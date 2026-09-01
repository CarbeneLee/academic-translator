use std::{
    ffi::OsString,
    path::{Path, PathBuf},
    sync::{Arc, Mutex},
    time::Duration,
};

use async_trait::async_trait;
use rusqlite::{params, Connection, OptionalExtension};

use crate::{
    errors::AppError,
    translation::{ProviderId, TokenUsage},
};

use super::{
    migrations, production_clock, CachePolicy, CacheRecord, CacheStats, CachedTranslation, Clock,
    TranslationCache,
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
                initialize_database(&inner.path)?;
                cleanup_database(&inner.path, inner.policy, inner.clock.now_unix_seconds())
                    .map(|_| ())
            })
            .await?;
        Ok(cache)
    }

    pub async fn database_bytes(&self) -> Result<u64, AppError> {
        self.run_blocking(|inner| {
            checkpoint_truncate(&inner.path)?;
            physical_database_bytes(&inner.path)
        })
        .await
    }

    pub async fn column_names(&self, table: &str) -> Result<Vec<String>, AppError> {
        if table != "translations" {
            return Err(AppError::cache_unavailable());
        }
        self.run_blocking(|inner| {
            let connection = open_ready_connection(&inner.path)?;
            let mut statement = connection.prepare("PRAGMA table_info(translations)")?;
            let rows = statement.query_map([], |row| row.get::<_, String>(1))?;
            rows.collect::<rusqlite::Result<Vec<_>>>()
        })
        .await
    }

    pub async fn index_columns(&self, index: &str) -> Result<Vec<String>, AppError> {
        if index != "translations_last_accessed_idx" {
            return Err(AppError::cache_unavailable());
        }
        self.run_blocking(|inner| {
            let connection = open_ready_connection(&inner.path)?;
            let mut statement =
                connection.prepare("PRAGMA index_info(translations_last_accessed_idx)")?;
            let rows = statement.query_map([], |row| row.get::<_, String>(2))?;
            rows.collect::<rusqlite::Result<Vec<_>>>()
        })
        .await
    }

    pub async fn schema_version(&self) -> Result<i64, AppError> {
        self.run_blocking(|inner| {
            let connection = open_ready_connection(&inner.path)?;
            connection.pragma_query_value(None, "user_version", |row| row.get(0))
        })
        .await
    }

    pub async fn auto_vacuum_mode(&self) -> Result<i64, AppError> {
        self.run_blocking(|inner| {
            let connection = open_ready_connection(&inner.path)?;
            connection.pragma_query_value(None, "auto_vacuum", |row| row.get(0))
        })
        .await
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
    async fn get(&self, key: &str) -> Result<Option<CachedTranslation>, AppError> {
        let key = key.to_owned();
        self.run_blocking(move |inner| {
            if !is_sha256_hex(&key) {
                return Err(rusqlite::Error::InvalidQuery);
            }
            let now = inner.clock.now_unix_seconds();
            let cutoff = expiration_cutoff(now, inner.policy.ttl)?;
            let connection = open_ready_connection(&inner.path)?;
            connection.execute(
                "DELETE FROM translations WHERE cache_key = ?1 AND last_accessed_at < ?2",
                params![key, cutoff],
            )?;
            let cached = connection
                .query_row(
                    "SELECT provider, model_id, model_revision, prompt_version, \
                     normalization_version, translation, created_at, input_tokens, output_tokens \
                     FROM translations WHERE cache_key = ?1",
                    params![key],
                    cached_translation_from_row,
                )
                .optional()?;
            if cached.is_some() {
                connection.execute(
                    "UPDATE translations SET last_accessed_at = ?2 WHERE cache_key = ?1",
                    params![key, now],
                )?;
            }
            drop(connection);
            checkpoint_truncate(&inner.path)?;
            Ok(cached.map(|mut value| {
                value.last_accessed_at = now;
                value
            }))
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
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).map_err(|_| rusqlite::Error::InvalidPath(parent.into()))?;
    }
    let mut connection = Connection::open(path)?;
    migrations::migrate(&mut connection)?;
    configure_connection(&connection)?;
    drop(connection);
    checkpoint_truncate(path)
}

fn open_ready_connection(path: &Path) -> rusqlite::Result<Connection> {
    let connection = Connection::open(path)?;
    configure_connection(&connection)?;
    let version =
        connection.pragma_query_value(None, "user_version", |row| row.get::<_, i64>(0))?;
    if version != migrations::SCHEMA_VERSION {
        return Err(rusqlite::Error::InvalidQuery);
    }
    Ok(connection)
}

fn configure_connection(connection: &Connection) -> rusqlite::Result<()> {
    connection.busy_timeout(Duration::from_secs(5))?;
    connection.pragma_update(None, "journal_mode", "WAL")?;
    connection.pragma_update(None, "synchronous", "NORMAL")?;
    Ok(())
}

fn cleanup_database(path: &Path, policy: CachePolicy, now: i64) -> rusqlite::Result<CacheStats> {
    let cutoff = expiration_cutoff(now, policy.ttl)?;
    let connection = open_ready_connection(path)?;
    connection.execute(
        "DELETE FROM translations WHERE last_accessed_at < ?1",
        params![cutoff],
    )?;
    drop(connection);
    checkpoint_truncate(path)?;

    loop {
        let bytes = physical_database_bytes(path)?;
        if bytes <= policy.max_bytes {
            return database_stats(path);
        }

        let connection = open_ready_connection(path)?;
        let removed = connection.execute(
            "DELETE FROM translations WHERE cache_key = (\
                SELECT cache_key FROM translations \
                ORDER BY last_accessed_at ASC, created_at ASC, cache_key ASC LIMIT 1\
             )",
            [],
        )?;
        drop(connection);
        checkpoint_truncate(path)?;
        if removed == 0 {
            return Err(rusqlite::Error::InvalidQuery);
        }
    }
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
    let connection = Connection::open(path)?;
    connection.busy_timeout(Duration::from_secs(5))?;
    connection.execute_batch("PRAGMA wal_checkpoint(TRUNCATE);")?;
    drop(connection);
    Ok(())
}

fn physical_database_bytes(path: &Path) -> rusqlite::Result<u64> {
    database_paths(path)
        .into_iter()
        .try_fold(0_u64, |total, candidate| {
            let bytes = match std::fs::metadata(candidate) {
                Ok(metadata) => metadata.len(),
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

fn cached_translation_from_row(row: &rusqlite::Row<'_>) -> rusqlite::Result<CachedTranslation> {
    Ok(CachedTranslation {
        provider: parse_provider(&row.get::<_, String>(0)?)?,
        model_id: row.get(1)?,
        model_revision: row.get(2)?,
        prompt_version: row.get(3)?,
        normalization_version: row.get(4)?,
        translation: row.get(5)?,
        created_at: row.get(6)?,
        last_accessed_at: 0,
        usage: TokenUsage {
            input_tokens: optional_i64_to_u64(row.get(7)?)?,
            output_tokens: optional_i64_to_u64(row.get(8)?)?,
        },
    })
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
