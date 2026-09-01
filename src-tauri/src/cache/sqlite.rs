use std::{
    ffi::OsString,
    path::{Path, PathBuf},
    sync::{Arc, Mutex},
    time::Duration,
};

use async_trait::async_trait;
use rusqlite::{params, Connection, OpenFlags, OptionalExtension};

use crate::{
    errors::AppError,
    translation::{ProviderId, TokenUsage},
};

use super::{
    migrations, production_clock, CacheLookup, CachePolicy, CacheRecord, CacheStats,
    CachedTranslation, Clock, TranslationCache,
};

#[derive(Clone)]
pub struct SqliteTranslationCache {
    inner: Arc<CacheInner>,
}

struct CacheInner {
    path: PathBuf,
    policy: CachePolicy,
    clock: Arc<dyn Clock>,
    operation_lock: Mutex<()>,
    available: bool,
}

impl SqliteTranslationCache {
    pub async fn open(path: PathBuf, policy: CachePolicy) -> Result<Self, AppError> {
        Self::open_with_clock(path, policy, production_clock()).await
    }

    pub async fn open_or_unavailable(path: PathBuf, policy: CachePolicy) -> Self {
        match Self::open(path, policy).await {
            Ok(cache) => cache,
            Err(_) => Self::unavailable(policy),
        }
    }

    pub fn unavailable(policy: CachePolicy) -> Self {
        Self {
            inner: Arc::new(CacheInner {
                path: PathBuf::new(),
                policy,
                clock: production_clock(),
                operation_lock: Mutex::new(()),
                available: false,
            }),
        }
    }

    pub async fn open_with_clock(
        path: PathBuf,
        policy: CachePolicy,
        clock: Arc<dyn Clock>,
    ) -> Result<Self, AppError> {
        let cache = Self {
            inner: Arc::new(CacheInner {
                path,
                policy,
                clock,
                operation_lock: Mutex::new(()),
                available: true,
            }),
        };
        cache
            .run_blocking(|inner| {
                initialize_and_enforce_policy(
                    &inner.path,
                    inner.policy,
                    inner.clock.now_unix_seconds(),
                    cleanup_database,
                )
            })
            .await?;
        Ok(cache)
    }

    async fn run_blocking<T, F>(&self, operation: F) -> Result<T, AppError>
    where
        T: Send + 'static,
        F: FnOnce(&CacheInner) -> rusqlite::Result<T> + Send + 'static,
    {
        if !self.inner.available {
            return Err(AppError::cache_unavailable());
        }
        let inner = Arc::clone(&self.inner);
        tokio::task::spawn_blocking(move || {
            let Ok(_guard) = inner.operation_lock.lock() else {
                return Err(AppError::cache_unavailable());
            };
            operation(&inner).map_err(|_| AppError::cache_unavailable())
        })
        .await
        .map_err(|_| AppError::cache_unavailable())?
    }
}

#[async_trait]
impl TranslationCache for SqliteTranslationCache {
    async fn get(&self, lookup: &CacheLookup) -> Result<Option<CachedTranslation>, AppError> {
        let lookup = lookup.clone();
        self.run_blocking(move |inner| {
            validate_lookup(&lookup)?;
            let now = inner.clock.now_unix_seconds();
            if now < 0 {
                return Err(rusqlite::Error::InvalidQuery);
            }
            let cutoff = expiration_cutoff(now, inner.policy.ttl)?;
            let connection = open_ready_connection(&inner.path)?;
            let stored = connection
                .query_row(
                    "SELECT cache_key, source_text_hash, source_language, target_language, \
                     provider, model_id, model_revision, prompt_version, normalization_version, \
                     translation, created_at, last_accessed_at, input_tokens, output_tokens \
                     FROM translations WHERE cache_key = ?1",
                    params![lookup.cache_key],
                    stored_cache_row_from_row,
                )
                .optional();
            let stored = match stored {
                Ok(stored) => stored,
                Err(_) => {
                    delete_corrupt_row(&connection, &lookup.cache_key)?;
                    drop(connection);
                    checkpoint_truncate(&inner.path)?;
                    return Err(rusqlite::Error::InvalidQuery);
                }
            };
            let Some(stored) = stored else {
                drop(connection);
                checkpoint_truncate(&inner.path)?;
                return Ok(None);
            };
            if validate_stored_row(&stored, &lookup, now).is_err() {
                delete_corrupt_row(&connection, &lookup.cache_key)?;
                drop(connection);
                checkpoint_truncate(&inner.path)?;
                return Err(rusqlite::Error::InvalidQuery);
            }
            if stored.last_accessed_at < cutoff {
                connection.execute(
                    "DELETE FROM translations WHERE cache_key = ?1",
                    params![lookup.cache_key],
                )?;
                drop(connection);
                checkpoint_truncate(&inner.path)?;
                return Ok(None);
            }
            let mut cached = stored.into_cached_translation()?;
            connection.execute(
                "UPDATE translations SET last_accessed_at = ?2 WHERE cache_key = ?1",
                params![lookup.cache_key, now],
            )?;
            drop(connection);
            checkpoint_truncate(&inner.path)?;
            cached.last_accessed_at = now;
            Ok(Some(cached))
        })
        .await
    }

    async fn put(&self, record: CacheRecord) -> Result<(), AppError> {
        self.run_blocking(move |inner| {
            validate_record(&record)?;
            let now = inner.clock.now_unix_seconds();
            let input_tokens = optional_u64_to_i64(record.usage.input_tokens)?;
            let output_tokens = optional_u64_to_i64(record.usage.output_tokens)?;
            let connection = open_ready_connection(&inner.path)?;
            connection.execute(
                "INSERT INTO translations (\
                    cache_key, source_text_hash, source_language, target_language, provider, \
                    model_id, model_revision, prompt_version, normalization_version, translation, \
                    created_at, last_accessed_at, input_tokens, output_tokens\
                 ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14) \
                 ON CONFLICT(cache_key) DO UPDATE SET \
                    source_text_hash = excluded.source_text_hash, \
                    source_language = excluded.source_language, \
                    target_language = excluded.target_language, \
                    provider = excluded.provider, \
                    model_id = excluded.model_id, \
                    model_revision = excluded.model_revision, \
                    prompt_version = excluded.prompt_version, \
                    normalization_version = excluded.normalization_version, \
                    translation = excluded.translation, \
                    created_at = excluded.created_at, \
                    last_accessed_at = excluded.last_accessed_at, \
                    input_tokens = excluded.input_tokens, \
                    output_tokens = excluded.output_tokens",
                params![
                    record.cache_key,
                    record.source_text_hash,
                    record.source_language,
                    record.target_language,
                    provider_name(record.provider),
                    record.model_id,
                    record.model_revision,
                    record.prompt_version,
                    record.normalization_version,
                    record.translation,
                    now,
                    now,
                    input_tokens,
                    output_tokens,
                ],
            )?;
            drop(connection);
            cleanup_database(&inner.path, inner.policy, now).map(|_| ())
        })
        .await
    }

    async fn cleanup(&self) -> Result<CacheStats, AppError> {
        self.run_blocking(|inner| {
            cleanup_database(&inner.path, inner.policy, inner.clock.now_unix_seconds())
        })
        .await
    }

    async fn clear(&self) -> Result<(), AppError> {
        self.run_blocking(|inner| {
            let connection = open_ready_connection(&inner.path)?;
            connection.execute("DELETE FROM translations", [])?;
            drop(connection);
            checkpoint_truncate(&inner.path)
        })
        .await
    }

    async fn stats(&self) -> Result<CacheStats, AppError> {
        self.run_blocking(|inner| database_stats(&inner.path)).await
    }
}

fn initialize_database(path: &Path) -> rusqlite::Result<()> {
    ensure_safe_database_parent(path)?;
    validate_database_targets(path)?;
    if !path_exists(path)? {
        safe_reset_database_files(path)?;
    }

    if try_initialize_database(path).is_err() {
        safe_reset_database_files(path)?;
        try_initialize_database(path)?;
    }
    Ok(())
}

fn initialize_and_enforce_policy<F>(
    path: &Path,
    policy: CachePolicy,
    now: i64,
    mut cleanup: F,
) -> rusqlite::Result<()>
where
    F: FnMut(&Path, CachePolicy, i64) -> rusqlite::Result<CacheStats>,
{
    initialize_database(path)?;
    if cleanup(path, policy, now).is_ok() {
        return Ok(());
    }

    safe_reset_database_files(path)?;
    try_initialize_database(path)?;
    let empty_stats = match database_stats(path) {
        Ok(stats) => stats,
        Err(_) => {
            safe_reset_database_files(path)?;
            return Err(rusqlite::Error::InvalidQuery);
        }
    };
    if empty_stats.row_count == 0 && empty_stats.database_bytes <= policy.max_bytes {
        Ok(())
    } else {
        safe_reset_database_files(path)?;
        Err(rusqlite::Error::InvalidQuery)
    }
}

fn try_initialize_database(path: &Path) -> rusqlite::Result<()> {
    let mut connection = open_database_connection(path)?;
    migrations::migrate(&mut connection)?;
    configure_connection(&connection)?;
    validate_schema_fingerprint(&connection)?;
    validate_database_targets(path)?;
    drop(connection);
    checkpoint_truncate(path)?;
    let connection = open_ready_connection(path)?;
    drop(connection);
    Ok(())
}

fn open_ready_connection(path: &Path) -> rusqlite::Result<Connection> {
    let connection = open_database_connection(path)?;
    configure_connection(&connection)?;
    validate_schema_fingerprint(&connection)?;
    validate_database_targets(path)?;
    Ok(connection)
}

fn production_open_flags() -> OpenFlags {
    OpenFlags::default() | OpenFlags::SQLITE_OPEN_NOFOLLOW
}

fn open_database_connection(path: &Path) -> rusqlite::Result<Connection> {
    validate_database_targets(path)?;
    Connection::open_with_flags(path, production_open_flags())
}

fn configure_connection(connection: &Connection) -> rusqlite::Result<()> {
    connection.busy_timeout(Duration::from_secs(5))?;
    connection.pragma_update(None, "journal_mode", "WAL")?;
    connection.pragma_update(None, "synchronous", "NORMAL")?;
    Ok(())
}

fn validate_schema_fingerprint(connection: &Connection) -> rusqlite::Result<()> {
    let version =
        connection.pragma_query_value(None, "user_version", |row| row.get::<_, i64>(0))?;
    let auto_vacuum =
        connection.pragma_query_value(None, "auto_vacuum", |row| row.get::<_, i64>(0))?;
    if version != migrations::SCHEMA_VERSION || auto_vacuum != 1 {
        return Err(rusqlite::Error::InvalidQuery);
    }

    let mut objects_statement = connection
        .prepare("SELECT type, name, tbl_name, sql FROM sqlite_schema ORDER BY type, name")?;
    let objects = objects_statement
        .query_map([], |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, String>(1)?,
                row.get::<_, String>(2)?,
                row.get::<_, Option<String>>(3)?,
            ))
        })?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    let expected_objects = [
        (
            "index",
            "sqlite_autoindex_translations_1",
            "translations",
            None,
        ),
        (
            "index",
            "translations_last_accessed_idx",
            "translations",
            Some(migrations::TRANSLATIONS_INDEX_SQL),
        ),
        (
            "table",
            "translations",
            "translations",
            Some(migrations::TRANSLATIONS_TABLE_SQL),
        ),
    ];
    if objects.len() != expected_objects.len()
        || objects
            .iter()
            .zip(expected_objects)
            .any(|(actual, expected)| {
                actual.0 != expected.0
                    || actual.1 != expected.1
                    || actual.2 != expected.2
                    || !schema_sql_matches(actual.3.as_deref(), expected.3)
            })
    {
        return Err(rusqlite::Error::InvalidQuery);
    }

    let mut columns_statement = connection.prepare("PRAGMA table_info(translations)")?;
    let columns = columns_statement
        .query_map([], |row| {
            Ok((
                row.get::<_, i64>(0)?,
                row.get::<_, String>(1)?,
                row.get::<_, String>(2)?,
                row.get::<_, i64>(3)?,
                row.get::<_, Option<String>>(4)?,
                row.get::<_, i64>(5)?,
            ))
        })?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    let expected_columns = [
        (0, "cache_key", "TEXT", 1, 1),
        (1, "source_text_hash", "TEXT", 1, 0),
        (2, "source_language", "TEXT", 1, 0),
        (3, "target_language", "TEXT", 1, 0),
        (4, "provider", "TEXT", 1, 0),
        (5, "model_id", "TEXT", 1, 0),
        (6, "model_revision", "TEXT", 1, 0),
        (7, "prompt_version", "TEXT", 1, 0),
        (8, "normalization_version", "TEXT", 1, 0),
        (9, "translation", "TEXT", 1, 0),
        (10, "created_at", "INTEGER", 1, 0),
        (11, "last_accessed_at", "INTEGER", 1, 0),
        (12, "input_tokens", "INTEGER", 0, 0),
        (13, "output_tokens", "INTEGER", 0, 0),
    ];
    if columns.len() != expected_columns.len()
        || columns
            .iter()
            .zip(expected_columns)
            .any(|(actual, expected)| {
                actual.0 != expected.0
                    || actual.1 != expected.1
                    || actual.2 != expected.2
                    || actual.3 != expected.3
                    || actual.4.is_some()
                    || actual.5 != expected.4
            })
    {
        return Err(rusqlite::Error::InvalidQuery);
    }

    let mut index_list_statement = connection.prepare("PRAGMA index_list(translations)")?;
    let mut indexes = index_list_statement
        .query_map([], |row| {
            Ok((
                row.get::<_, String>(1)?,
                row.get::<_, i64>(2)?,
                row.get::<_, String>(3)?,
                row.get::<_, i64>(4)?,
            ))
        })?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    indexes.sort_by(|left, right| left.0.cmp(&right.0));
    let expected_indexes = [
        (
            "sqlite_autoindex_translations_1".to_owned(),
            1,
            "pk".to_owned(),
            0,
        ),
        (
            "translations_last_accessed_idx".to_owned(),
            0,
            "c".to_owned(),
            0,
        ),
    ];
    if indexes != expected_indexes {
        return Err(rusqlite::Error::InvalidQuery);
    }

    let mut index_info_statement =
        connection.prepare("PRAGMA index_info(translations_last_accessed_idx)")?;
    let index_columns = index_info_statement
        .query_map([], |row| {
            Ok((
                row.get::<_, i64>(0)?,
                row.get::<_, i64>(1)?,
                row.get::<_, String>(2)?,
            ))
        })?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    if index_columns != [(0, 11, "last_accessed_at".to_owned())] {
        return Err(rusqlite::Error::InvalidQuery);
    }

    let foreign_key_count = connection.query_row(
        "SELECT COUNT(*) FROM pragma_foreign_key_list('translations')",
        [],
        |row| row.get::<_, i64>(0),
    )?;
    if foreign_key_count != 0 {
        return Err(rusqlite::Error::InvalidQuery);
    }
    Ok(())
}

fn normalize_schema_sql(sql: &str) -> String {
    sql.chars()
        .filter(|character| !character.is_ascii_whitespace() && *character != ';')
        .flat_map(char::to_lowercase)
        .collect()
}

fn schema_sql_matches(actual: Option<&str>, expected: Option<&str>) -> bool {
    match (actual, expected) {
        (None, None) => true,
        (Some(actual), Some(expected)) => {
            normalize_schema_sql(actual) == normalize_schema_sql(expected)
        }
        _ => false,
    }
}

fn cleanup_database(path: &Path, policy: CachePolicy, now: i64) -> rusqlite::Result<CacheStats> {
    let cutoff = expiration_cutoff(now, policy.ttl)?;
    let connection = open_ready_connection(path)?;
    connection.execute(
        "DELETE FROM translations \
         WHERE typeof(created_at) != 'integer' \
            OR typeof(last_accessed_at) != 'integer' \
            OR last_accessed_at < ?1 \
            OR created_at < 0 \
            OR created_at > last_accessed_at \
            OR last_accessed_at > ?2",
        params![cutoff, now],
    )?;
    drop(connection);
    checkpoint_truncate(path)?;

    let initial = database_stats(path)?;
    run_bounded_eviction(initial, policy.max_bytes, |_, batch_size| {
        let batch_size = i64::try_from(batch_size).map_err(|_| rusqlite::Error::InvalidQuery)?;
        let connection = open_ready_connection(path)?;
        let removed = connection.execute(
            "DELETE FROM translations WHERE cache_key IN (\
                SELECT cache_key FROM translations \
                ORDER BY last_accessed_at ASC, created_at ASC, cache_key ASC LIMIT ?1\
             )",
            params![batch_size],
        )?;
        drop(connection);
        checkpoint_truncate(path)?;
        Ok((removed, database_stats(path)?))
    })
}

const MAX_LRU_EVICTABLE_ROWS: u64 = 500_000;
const MAX_LRU_EVICTION_BATCHES: u64 = 32;

fn run_bounded_eviction<F>(
    initial: CacheStats,
    max_bytes: u64,
    mut delete_one: F,
) -> rusqlite::Result<CacheStats>
where
    F: FnMut(CacheStats, u64) -> rusqlite::Result<(usize, CacheStats)>,
{
    let mut current = initial;
    if current.database_bytes <= max_bytes {
        return Ok(current);
    }
    if initial.row_count == 0 || initial.row_count > MAX_LRU_EVICTABLE_ROWS {
        return Err(rusqlite::Error::InvalidQuery);
    }
    let batch_count = initial.row_count.min(MAX_LRU_EVICTION_BATCHES);
    let batch_size = initial.row_count.div_ceil(batch_count);
    for _ in 0..batch_count {
        let requested = batch_size.min(current.row_count);
        let (removed, next) = delete_one(current, requested)?;
        let removed = u64::try_from(removed).map_err(|_| rusqlite::Error::InvalidQuery)?;
        let made_progress =
            next.row_count < current.row_count || next.database_bytes < current.database_bytes;
        if removed == 0
            || removed > requested
            || !made_progress
            || next.row_count > current.row_count
        {
            return Err(rusqlite::Error::InvalidQuery);
        }
        current = next;
        if current.database_bytes <= max_bytes {
            return Ok(current);
        }
    }
    Err(rusqlite::Error::InvalidQuery)
}

fn database_stats(path: &Path) -> rusqlite::Result<CacheStats> {
    let connection = open_ready_connection(path)?;
    let row_count = connection.query_row("SELECT COUNT(*) FROM translations", [], |row| {
        row.get::<_, i64>(0)
    })?;
    drop(connection);
    checkpoint_truncate(path)?;
    Ok(CacheStats {
        row_count: u64::try_from(row_count).map_err(|_| rusqlite::Error::InvalidQuery)?,
        database_bytes: physical_database_bytes(path)?,
    })
}

fn checkpoint_truncate(path: &Path) -> rusqlite::Result<()> {
    let connection = open_database_connection(path)?;
    connection.busy_timeout(Duration::from_secs(5))?;
    connection.execute_batch("PRAGMA wal_checkpoint(TRUNCATE);")?;
    validate_database_targets(path)?;
    drop(connection);
    Ok(())
}

fn physical_database_bytes(path: &Path) -> rusqlite::Result<u64> {
    validate_database_targets(path)?;
    database_paths(path)
        .into_iter()
        .try_fold(0_u64, |total, candidate| {
            let bytes = match std::fs::symlink_metadata(&candidate) {
                Ok(metadata) if is_safe_regular_file(&candidate, &metadata) => metadata.len(),
                Ok(_) => return Err(rusqlite::Error::InvalidQuery),
                Err(error) if error.kind() == std::io::ErrorKind::NotFound => 0,
                Err(_) => return Err(rusqlite::Error::InvalidQuery),
            };
            total
                .checked_add(bytes)
                .ok_or(rusqlite::Error::InvalidQuery)
        })
}

fn database_paths(path: &Path) -> [PathBuf; 3] {
    [
        path.to_path_buf(),
        path_with_suffix(path, "-wal"),
        path_with_suffix(path, "-shm"),
    ]
}

fn validate_database_targets(path: &Path) -> rusqlite::Result<()> {
    if !path.is_absolute() || path.as_os_str().is_empty() || path.file_name().is_none() {
        return Err(rusqlite::Error::InvalidPath(path.to_path_buf()));
    }
    validate_database_parent(path)?;
    for candidate in database_paths(path) {
        match std::fs::symlink_metadata(&candidate) {
            Ok(metadata) if is_safe_regular_file(&candidate, &metadata) => {}
            Ok(_) => return Err(rusqlite::Error::InvalidPath(candidate)),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
            Err(_) => return Err(rusqlite::Error::InvalidPath(candidate)),
        }
    }
    Ok(())
}

fn path_exists(path: &Path) -> rusqlite::Result<bool> {
    match std::fs::symlink_metadata(path) {
        Ok(metadata) if is_safe_regular_file(path, &metadata) => Ok(true),
        Ok(_) => Err(rusqlite::Error::InvalidPath(path.to_path_buf())),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(false),
        Err(_) => Err(rusqlite::Error::InvalidPath(path.to_path_buf())),
    }
}

fn safe_reset_database_files(path: &Path) -> rusqlite::Result<()> {
    validate_database_targets(path)?;
    let paths = database_paths(path);
    for candidate in paths.iter().rev() {
        validate_database_targets(path)?;
        match std::fs::symlink_metadata(candidate) {
            Ok(metadata) if is_safe_regular_file(candidate, &metadata) => {
                std::fs::remove_file(candidate)
                    .map_err(|_| rusqlite::Error::InvalidPath(candidate.clone()))?;
                validate_database_targets(path)?;
            }
            Ok(_) => return Err(rusqlite::Error::InvalidPath(candidate.clone())),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
            Err(_) => return Err(rusqlite::Error::InvalidPath(candidate.clone())),
        }
    }
    for candidate in paths {
        match std::fs::symlink_metadata(&candidate) {
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
            _ => return Err(rusqlite::Error::InvalidPath(candidate)),
        }
    }
    Ok(())
}

fn ensure_safe_database_parent(path: &Path) -> rusqlite::Result<()> {
    let parent = database_parent(path)?;
    walk_database_parent(parent, true)
}

fn validate_database_parent(path: &Path) -> rusqlite::Result<()> {
    let parent = database_parent(path)?;
    walk_database_parent(parent, false)
}

fn database_parent(path: &Path) -> rusqlite::Result<&Path> {
    if !path.is_absolute() || path.file_name().is_none() {
        return Err(rusqlite::Error::InvalidPath(path.to_path_buf()));
    }
    path.parent()
        .filter(|parent| !parent.as_os_str().is_empty())
        .ok_or_else(|| rusqlite::Error::InvalidPath(path.to_path_buf()))
}

fn walk_database_parent(parent: &Path, create_missing: bool) -> rusqlite::Result<()> {
    use std::path::Component;

    let mut current = PathBuf::new();
    for component in parent.components() {
        match component {
            Component::Prefix(_) => {
                current.push(component.as_os_str());
                continue;
            }
            Component::RootDir | Component::Normal(_) => current.push(component.as_os_str()),
            Component::CurDir | Component::ParentDir => {
                return Err(rusqlite::Error::InvalidPath(parent.to_path_buf()));
            }
        }
        match std::fs::symlink_metadata(&current) {
            Ok(metadata) if is_safe_directory(&current, &metadata) => {}
            Ok(_) => return Err(rusqlite::Error::InvalidPath(current)),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound && create_missing => {
                match std::fs::create_dir(&current) {
                    Ok(()) => {}
                    Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => {}
                    Err(_) => return Err(rusqlite::Error::InvalidPath(current)),
                }
                let metadata = std::fs::symlink_metadata(&current)
                    .map_err(|_| rusqlite::Error::InvalidPath(current.clone()))?;
                if !is_safe_directory(&current, &metadata) {
                    return Err(rusqlite::Error::InvalidPath(current));
                }
            }
            Err(_) => return Err(rusqlite::Error::InvalidPath(current)),
        }
    }
    Ok(())
}

fn is_safe_directory(path: &Path, metadata: &std::fs::Metadata) -> bool {
    if !metadata.file_type().is_dir() {
        return false;
    }
    #[cfg(unix)]
    {
        let _ = path;
        true
    }
    #[cfg(windows)]
    {
        windows_entry_is_safe(path, WindowsEntryKind::Directory)
    }
    #[cfg(not(any(unix, windows)))]
    {
        let _ = path;
        false
    }
}

fn is_safe_regular_file(path: &Path, metadata: &std::fs::Metadata) -> bool {
    if !metadata.file_type().is_file() {
        return false;
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::MetadataExt;
        let _ = path;
        metadata.nlink() == 1
    }
    #[cfg(windows)]
    {
        windows_entry_is_safe(path, WindowsEntryKind::RegularFile)
    }
    #[cfg(not(any(unix, windows)))]
    {
        let _ = path;
        false
    }
}

#[cfg(windows)]
#[derive(Clone, Copy)]
enum WindowsEntryKind {
    Directory,
    RegularFile,
}

#[cfg(windows)]
fn windows_entry_is_safe(path: &Path, expected: WindowsEntryKind) -> bool {
    use std::{os::windows::ffi::OsStrExt, ptr};
    use windows_sys::Win32::{
        Foundation::{CloseHandle, HANDLE, INVALID_HANDLE_VALUE},
        Storage::FileSystem::{
            CreateFileW, GetFileInformationByHandle, BY_HANDLE_FILE_INFORMATION,
            FILE_ATTRIBUTE_DIRECTORY, FILE_ATTRIBUTE_REPARSE_POINT, FILE_FLAG_BACKUP_SEMANTICS,
            FILE_FLAG_OPEN_REPARSE_POINT, FILE_READ_ATTRIBUTES, FILE_SHARE_DELETE, FILE_SHARE_READ,
            FILE_SHARE_WRITE, OPEN_EXISTING,
        },
    };

    struct OwnedHandle(HANDLE);
    impl Drop for OwnedHandle {
        fn drop(&mut self) {
            // SAFETY: the constructor below stores only a valid owned CreateFileW handle.
            unsafe {
                CloseHandle(self.0);
            }
        }
    }

    let wide_path = path
        .as_os_str()
        .encode_wide()
        .chain(std::iter::once(0))
        .collect::<Vec<_>>();
    // SAFETY: wide_path is NUL-terminated and all optional pointer/handle arguments are null.
    let raw_handle = unsafe {
        CreateFileW(
            wide_path.as_ptr(),
            FILE_READ_ATTRIBUTES,
            FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE,
            ptr::null(),
            OPEN_EXISTING,
            FILE_FLAG_OPEN_REPARSE_POINT | FILE_FLAG_BACKUP_SEMANTICS,
            ptr::null_mut(),
        )
    };
    if raw_handle == INVALID_HANDLE_VALUE {
        return false;
    }
    let handle = OwnedHandle(raw_handle);
    let mut information = BY_HANDLE_FILE_INFORMATION::default();
    // SAFETY: handle remains valid through this call and information is writable storage.
    if unsafe { GetFileInformationByHandle(handle.0, &mut information) } == 0 {
        return false;
    }
    if information.dwFileAttributes & FILE_ATTRIBUTE_REPARSE_POINT != 0
        || information.nNumberOfLinks == 0
    {
        return false;
    }
    let is_directory = information.dwFileAttributes & FILE_ATTRIBUTE_DIRECTORY != 0;
    match expected {
        WindowsEntryKind::Directory => is_directory,
        WindowsEntryKind::RegularFile => !is_directory && information.nNumberOfLinks == 1,
    }
}

fn path_with_suffix(path: &Path, suffix: &str) -> PathBuf {
    let mut value = OsString::from(path.as_os_str());
    value.push(suffix);
    PathBuf::from(value)
}

fn expiration_cutoff(now: i64, ttl: Duration) -> rusqlite::Result<i64> {
    let ttl = i64::try_from(ttl.as_secs()).map_err(|_| rusqlite::Error::InvalidQuery)?;
    now.checked_sub(ttl).ok_or(rusqlite::Error::InvalidQuery)
}

fn validate_record(record: &CacheRecord) -> rusqlite::Result<()> {
    let valid = is_sha256_hex(&record.cache_key)
        && is_sha256_hex(&record.source_text_hash)
        && !record.source_language.is_empty()
        && !record.target_language.is_empty()
        && !record.model_id.is_empty()
        && !record.model_revision.is_empty()
        && !record.prompt_version.is_empty()
        && !record.normalization_version.is_empty()
        && !record.translation.trim().is_empty();
    if valid {
        Ok(())
    } else {
        Err(rusqlite::Error::InvalidQuery)
    }
}

fn validate_lookup(lookup: &CacheLookup) -> rusqlite::Result<()> {
    let valid = is_sha256_hex(&lookup.cache_key)
        && is_sha256_hex(&lookup.source_text_hash)
        && !lookup.source_language.is_empty()
        && !lookup.target_language.is_empty()
        && !lookup.model_id.is_empty()
        && !lookup.model_revision.is_empty()
        && !lookup.prompt_version.is_empty()
        && !lookup.normalization_version.is_empty();
    if valid {
        Ok(())
    } else {
        Err(rusqlite::Error::InvalidQuery)
    }
}

fn is_sha256_hex(value: &str) -> bool {
    value.len() == 64
        && value
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
}

fn optional_u64_to_i64(value: Option<u64>) -> rusqlite::Result<Option<i64>> {
    value
        .map(|value| i64::try_from(value).map_err(|_| rusqlite::Error::InvalidQuery))
        .transpose()
}

fn optional_i64_to_u64(value: Option<i64>) -> rusqlite::Result<Option<u64>> {
    value
        .map(|value| u64::try_from(value).map_err(|_| rusqlite::Error::InvalidQuery))
        .transpose()
}

struct StoredCacheRow {
    cache_key: String,
    source_text_hash: String,
    source_language: String,
    target_language: String,
    provider: String,
    model_id: String,
    model_revision: String,
    prompt_version: String,
    normalization_version: String,
    translation: String,
    created_at: i64,
    last_accessed_at: i64,
    input_tokens: Option<i64>,
    output_tokens: Option<i64>,
}

impl StoredCacheRow {
    fn into_cached_translation(self) -> rusqlite::Result<CachedTranslation> {
        Ok(CachedTranslation {
            provider: parse_provider(&self.provider)?,
            model_id: self.model_id,
            model_revision: self.model_revision,
            prompt_version: self.prompt_version,
            normalization_version: self.normalization_version,
            translation: self.translation,
            created_at: self.created_at,
            last_accessed_at: self.last_accessed_at,
            usage: TokenUsage {
                input_tokens: optional_i64_to_u64(self.input_tokens)?,
                output_tokens: optional_i64_to_u64(self.output_tokens)?,
            },
        })
    }
}

fn stored_cache_row_from_row(row: &rusqlite::Row<'_>) -> rusqlite::Result<StoredCacheRow> {
    Ok(StoredCacheRow {
        cache_key: row.get(0)?,
        source_text_hash: row.get(1)?,
        source_language: row.get(2)?,
        target_language: row.get(3)?,
        provider: row.get(4)?,
        model_id: row.get(5)?,
        model_revision: row.get(6)?,
        prompt_version: row.get(7)?,
        normalization_version: row.get(8)?,
        translation: row.get(9)?,
        created_at: row.get(10)?,
        last_accessed_at: row.get(11)?,
        input_tokens: row.get(12)?,
        output_tokens: row.get(13)?,
    })
}

fn validate_stored_row(
    stored: &StoredCacheRow,
    lookup: &CacheLookup,
    now: i64,
) -> rusqlite::Result<()> {
    let valid = is_sha256_hex(&stored.cache_key)
        && is_sha256_hex(&stored.source_text_hash)
        && stored.cache_key == lookup.cache_key
        && stored.source_text_hash == lookup.source_text_hash
        && stored.source_language == lookup.source_language
        && stored.target_language == lookup.target_language
        && stored.provider == provider_name(lookup.provider)
        && stored.model_id == lookup.model_id
        && stored.model_revision == lookup.model_revision
        && stored.prompt_version == lookup.prompt_version
        && stored.normalization_version == lookup.normalization_version
        && stored.created_at >= 0
        && stored.created_at <= stored.last_accessed_at
        && stored.last_accessed_at <= now
        && stored.input_tokens.is_none_or(|tokens| tokens >= 0)
        && stored.output_tokens.is_none_or(|tokens| tokens >= 0)
        && !stored.translation.trim().is_empty()
        && stored.translation.chars().count() <= 12_000;
    if valid {
        Ok(())
    } else {
        Err(rusqlite::Error::InvalidQuery)
    }
}

fn delete_corrupt_row(connection: &Connection, cache_key: &str) -> rusqlite::Result<()> {
    let removed = connection.execute(
        "DELETE FROM translations WHERE cache_key = ?1",
        params![cache_key],
    )?;
    if removed == 1 {
        Ok(())
    } else {
        Err(rusqlite::Error::InvalidQuery)
    }
}

const fn provider_name(provider: ProviderId) -> &'static str {
    match provider {
        ProviderId::Deepseek => "deepseek",
        ProviderId::Youdao => "youdao",
    }
}

fn parse_provider(value: &str) -> rusqlite::Result<ProviderId> {
    match value {
        "deepseek" => Ok(ProviderId::Deepseek),
        "youdao" => Ok(ProviderId::Youdao),
        _ => Err(rusqlite::Error::InvalidQuery),
    }
}

#[cfg(test)]
mod tests {
    use std::cell::Cell;

    use super::*;

    #[test]
    fn every_production_connection_uses_sqlite_nofollow() {
        assert!(production_open_flags().contains(OpenFlags::SQLITE_OPEN_NOFOLLOW));
    }

    #[test]
    fn delete_success_without_row_or_byte_progress_is_rejected_after_one_step() {
        let initial = CacheStats {
            row_count: 3,
            database_bytes: 100,
        };
        let calls = Cell::new(0_u64);

        let result = run_bounded_eviction(initial, 50, |_, _| {
            calls.set(calls.get() + 1);
            Ok((1, initial))
        });

        assert!(result.is_err());
        assert_eq!(calls.get(), 1);
    }

    #[test]
    fn eviction_uses_at_most_the_explicit_batch_limit() {
        let initial = CacheStats {
            row_count: MAX_LRU_EVICTABLE_ROWS,
            database_bytes: 100,
        };
        let calls = Cell::new(0_u64);

        let result = run_bounded_eviction(initial, 50, |current, requested| {
            calls.set(calls.get() + 1);
            Ok((
                usize::try_from(requested).expect("bounded batch fits usize"),
                CacheStats {
                    row_count: current.row_count - requested,
                    database_bytes: current.database_bytes,
                },
            ))
        });

        assert!(result.is_err());
        assert_eq!(calls.get(), MAX_LRU_EVICTION_BATCHES);
    }

    #[test]
    fn startup_cleanup_failure_safely_recreates_an_empty_within_cap_database() {
        let directory = tempfile::tempdir().expect("isolated cache fixture");
        let path = directory
            .path()
            .canonicalize()
            .expect("isolated cache fixture canonicalizes")
            .join("translation-cache.sqlite3");
        initialize_database(&path).expect("fixture database initializes");
        let empty_bytes = database_stats(&path).expect("empty stats").database_bytes;
        let connection = open_ready_connection(&path).expect("fixture connection opens");
        connection
            .execute(
                "INSERT INTO translations (\
                    cache_key, source_text_hash, source_language, target_language, provider, \
                    model_id, model_revision, prompt_version, normalization_version, translation, \
                    created_at, last_accessed_at, input_tokens, output_tokens\
                 ) VALUES (?1, ?2, 'en', 'zh-CN', 'deepseek', 'model', 'revision', 'prompt', \
                           'normalization', ?3, 1, 1, 1, 1)",
                params!["a".repeat(64), "b".repeat(64), "x".repeat(12_000)],
            )
            .expect("fixture row inserts");
        drop(connection);
        checkpoint_truncate(&path).expect("fixture checkpoints");
        let populated_bytes = physical_database_bytes(&path).expect("populated bytes");
        assert!(populated_bytes > empty_bytes);
        let cleanup_calls = Cell::new(0_u64);
        let policy = CachePolicy {
            ttl: Duration::from_secs(7 * 24 * 60 * 60),
            max_bytes: empty_bytes,
        };

        initialize_and_enforce_policy(&path, policy, 2, |_, _, _| {
            cleanup_calls.set(cleanup_calls.get() + 1);
            Err(rusqlite::Error::InvalidQuery)
        })
        .expect("safe empty recreation succeeds");

        assert_eq!(cleanup_calls.get(), 1);
        let stats = database_stats(&path).expect("recreated stats");
        assert_eq!(stats.row_count, 0);
        assert!(stats.database_bytes <= policy.max_bytes);
    }
}
