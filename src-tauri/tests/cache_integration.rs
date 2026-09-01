mod support;

use std::{
    path::{Path, PathBuf},
    sync::Arc,
    time::Duration,
};

use academic_translator_lib::cache::{
    CachePolicy, Clock, SqliteTranslationCache, TranslationCache,
};
use tempfile::tempdir;

use support::{cache_lookup, cache_record, physical_database_bytes, FakeClock};

const SEVEN_DAYS: Duration = Duration::from_secs(7 * 24 * 60 * 60);

async fn open_cache(
    path: &std::path::Path,
    clock: impl Clock + 'static,
    policy: CachePolicy,
) -> SqliteTranslationCache {
    let parent = path
        .parent()
        .expect("test cache path has a parent")
        .canonicalize()
        .expect("test cache parent canonicalizes");
    let path = parent.join(path.file_name().expect("test cache path has a file name"));
    SqliteTranslationCache::open_with_clock(path, policy, Arc::new(clock))
        .await
        .expect("test cache opens")
}

fn canonical_cache_path(directory: &tempfile::TempDir) -> PathBuf {
    directory
        .path()
        .canonicalize()
        .expect("isolated test directory canonicalizes")
        .join("translation-cache.sqlite3")
}

fn schema_objects(path: &Path) -> Vec<(String, String)> {
    let connection = rusqlite::Connection::open(path).expect("test database opens");
    let mut statement = connection
        .prepare("SELECT type, name FROM sqlite_schema ORDER BY type, name")
        .expect("test schema query prepares");
    let objects = statement
        .query_map([], |row| Ok((row.get(0)?, row.get(1)?)))
        .expect("test schema query runs")
        .collect::<rusqlite::Result<Vec<_>>>()
        .expect("test schema rows decode");
    objects
}

fn exact_v1_objects() -> Vec<(String, String)> {
    vec![
        (
            "index".to_owned(),
            "sqlite_autoindex_translations_1".to_owned(),
        ),
        (
            "index".to_owned(),
            "translations_last_accessed_idx".to_owned(),
        ),
        ("table".to_owned(), "translations".to_owned()),
    ]
}

fn table_columns(path: &Path) -> Vec<String> {
    let connection = rusqlite::Connection::open(path).expect("test database opens");
    let mut statement = connection
        .prepare("PRAGMA table_info(translations)")
        .expect("test column query prepares");
    statement
        .query_map([], |row| row.get(1))
        .expect("test column query runs")
        .collect::<rusqlite::Result<Vec<_>>>()
        .expect("test columns decode")
}

fn translation_index_columns(path: &Path) -> Vec<String> {
    let connection = rusqlite::Connection::open(path).expect("test database opens");
    let mut statement = connection
        .prepare("PRAGMA index_info(translations_last_accessed_idx)")
        .expect("test index query prepares");
    statement
        .query_map([], |row| row.get(2))
        .expect("test index query runs")
        .collect::<rusqlite::Result<Vec<_>>>()
        .expect("test index columns decode")
}

fn pragma_value(path: &Path, pragma: &str) -> i64 {
    let connection = rusqlite::Connection::open(path).expect("test database opens");
    connection
        .pragma_query_value(None, pragma, |row| row.get(0))
        .expect("test pragma query succeeds")
}

fn stored_cache_keys(path: &Path) -> Vec<String> {
    let connection = rusqlite::Connection::open(path).expect("test database opens");
    let mut statement = connection
        .prepare("SELECT cache_key FROM translations ORDER BY cache_key")
        .expect("test key query prepares");
    statement
        .query_map([], |row| row.get(0))
        .expect("test key query runs")
        .collect::<rusqlite::Result<Vec<_>>>()
        .expect("test keys decode")
}

fn persisted_database_bytes(path: &Path) -> Vec<u8> {
    [
        path.to_path_buf(),
        std::path::PathBuf::from(format!("{}-wal", path.display())),
        std::path::PathBuf::from(format!("{}-shm", path.display())),
    ]
    .into_iter()
    .filter_map(|candidate| std::fs::read(candidate).ok())
    .flatten()
    .collect()
}

#[tokio::test]
async fn migration_has_the_exact_privacy_only_v1_schema() {
    let directory = tempdir().unwrap();
    let path = directory.path().join("translation-cache.sqlite3");
    let cache = open_cache(
        &path,
        FakeClock::at(1_700_000_000),
        CachePolicy::production(),
    )
    .await;

    assert_eq!(
        table_columns(&path),
        vec![
            "cache_key",
            "source_text_hash",
            "source_language",
            "target_language",
            "provider",
            "model_id",
            "model_revision",
            "prompt_version",
            "normalization_version",
            "translation",
            "created_at",
            "last_accessed_at",
            "input_tokens",
            "output_tokens",
        ]
    );
    assert_eq!(pragma_value(&path, "user_version"), 1);
    assert_eq!(pragma_value(&path, "auto_vacuum"), 1);
    assert_eq!(translation_index_columns(&path), vec!["last_accessed_at"]);
    assert_eq!(schema_objects(&path), exact_v1_objects());
    assert_eq!(cache.stats().await.unwrap().row_count, 0);
}

#[tokio::test]
async fn version_zero_database_with_a_foreign_table_is_safely_reset_to_exact_v1() {
    let directory = tempdir().unwrap();
    let path = directory.path().join("translation-cache.sqlite3");
    rusqlite::Connection::open(&path)
        .unwrap()
        .execute_batch("CREATE TABLE foreign_data (raw_source TEXT NOT NULL);")
        .unwrap();

    let cache = open_cache(
        &path,
        FakeClock::at(1_700_000_000),
        CachePolicy::production(),
    )
    .await;

    assert_eq!(schema_objects(&path), exact_v1_objects());
    assert_eq!(cache.stats().await.unwrap().row_count, 0);
}

#[tokio::test]
async fn sqlite_confusable_user_object_is_not_mistaken_for_an_internal_object() {
    let directory = tempdir().unwrap();
    let path = directory.path().join("translation-cache.sqlite3");
    let cache = open_cache(
        &path,
        FakeClock::at(1_700_000_000),
        CachePolicy::production(),
    )
    .await;
    cache
        .put(cache_record("confusable-object", "译文"))
        .await
        .unwrap();
    drop(cache);
    rusqlite::Connection::open(&path)
        .unwrap()
        .execute_batch("CREATE TABLE sqliteXrogue (raw_source TEXT NOT NULL);")
        .unwrap();

    let reopened = open_cache(
        &path,
        FakeClock::at(1_700_000_001),
        CachePolicy::production(),
    )
    .await;

    assert_eq!(schema_objects(&path), exact_v1_objects());
    assert_eq!(reopened.stats().await.unwrap().row_count, 0);
}

#[tokio::test]
async fn analyze_statistics_with_raw_content_force_a_safe_privacy_reset() {
    let directory = tempdir().unwrap();
    let path = directory.path().join("translation-cache.sqlite3");
    let cache = open_cache(
        &path,
        FakeClock::at(1_700_000_000),
        CachePolicy::production(),
    )
    .await;
    cache
        .put(cache_record("analyze-privacy", "译文"))
        .await
        .unwrap();
    drop(cache);
    let forbidden = "UNMISTAKABLE RAW ENGLISH IN SQLITE STAT MUST VANISH";
    let connection = rusqlite::Connection::open(&path).unwrap();
    connection
        .execute_batch("ANALYZE; DELETE FROM sqlite_stat1;")
        .unwrap();
    connection
        .execute(
            "INSERT INTO sqlite_stat1(tbl, idx, stat) VALUES ('translations', NULL, ?1)",
            [forbidden],
        )
        .unwrap();
    drop(connection);

    let reopened = open_cache(
        &path,
        FakeClock::at(1_700_000_001),
        CachePolicy::production(),
    )
    .await;

    assert_eq!(reopened.stats().await.unwrap().row_count, 0);
    let persisted = persisted_database_bytes(&path);
    assert!(!persisted
        .windows(forbidden.len())
        .any(|window| window == forbidden.as_bytes()));
}

#[tokio::test]
async fn pseudo_v1_with_an_extra_column_is_reset_instead_of_trusted() {
    let directory = tempdir().unwrap();
    let path = directory.path().join("translation-cache.sqlite3");
    let cache = open_cache(
        &path,
        FakeClock::at(1_700_000_000),
        CachePolicy::production(),
    )
    .await;
    cache
        .put(cache_record("extra-column", "译文"))
        .await
        .unwrap();
    drop(cache);
    rusqlite::Connection::open(&path)
        .unwrap()
        .execute_batch("ALTER TABLE translations ADD COLUMN raw_source TEXT;")
        .unwrap();

    let reopened = open_cache(
        &path,
        FakeClock::at(1_700_000_001),
        CachePolicy::production(),
    )
    .await;

    assert_eq!(table_columns(&path).len(), 14);
    assert_eq!(reopened.stats().await.unwrap().row_count, 0);
}

#[tokio::test]
async fn pseudo_v1_with_a_trigger_is_reset_to_the_allowed_objects_only() {
    let directory = tempdir().unwrap();
    let path = directory.path().join("translation-cache.sqlite3");
    let cache = open_cache(
        &path,
        FakeClock::at(1_700_000_000),
        CachePolicy::production(),
    )
    .await;
    cache.put(cache_record("trigger", "译文")).await.unwrap();
    drop(cache);
    rusqlite::Connection::open(&path)
        .unwrap()
        .execute_batch(
            "CREATE TRIGGER rogue_trigger AFTER DELETE ON translations \
             BEGIN SELECT 1; END;",
        )
        .unwrap();

    let reopened = open_cache(
        &path,
        FakeClock::at(1_700_000_001),
        CachePolicy::production(),
    )
    .await;

    assert_eq!(schema_objects(&path), exact_v1_objects());
    assert_eq!(reopened.stats().await.unwrap().row_count, 0);
}

#[tokio::test]
async fn pseudo_v1_with_wrong_index_or_auto_vacuum_is_reset() {
    for mutation in [
        "DROP INDEX translations_last_accessed_idx; \
         CREATE INDEX translations_last_accessed_idx ON translations(created_at);",
        "PRAGMA auto_vacuum = NONE; VACUUM;",
    ] {
        let directory = tempdir().unwrap();
        let path = directory.path().join("translation-cache.sqlite3");
        let cache = open_cache(
            &path,
            FakeClock::at(1_700_000_000),
            CachePolicy::production(),
        )
        .await;
        cache
            .put(cache_record("wrong-schema", "译文"))
            .await
            .unwrap();
        drop(cache);
        rusqlite::Connection::open(&path)
            .unwrap()
            .execute_batch(mutation)
            .unwrap();

        let reopened = open_cache(
            &path,
            FakeClock::at(1_700_000_001),
            CachePolicy::production(),
        )
        .await;

        assert_eq!(translation_index_columns(&path), vec!["last_accessed_at"]);
        assert_eq!(pragma_value(&path, "auto_vacuum"), 1);
        assert_eq!(reopened.stats().await.unwrap().row_count, 0);
    }
}

#[tokio::test]
async fn valid_v1_reopen_is_idempotent_and_preserves_cached_rows() {
    let directory = tempdir().unwrap();
    let path = directory.path().join("translation-cache.sqlite3");
    let cache = open_cache(
        &path,
        FakeClock::at(1_700_000_000),
        CachePolicy::production(),
    )
    .await;
    cache
        .put(cache_record("valid-reopen", "保留译文"))
        .await
        .unwrap();
    drop(cache);

    let reopened = open_cache(
        &path,
        FakeClock::at(1_700_000_001),
        CachePolicy::production(),
    )
    .await;

    assert_eq!(schema_objects(&path), exact_v1_objects());
    assert_eq!(pragma_value(&path, "user_version"), 1);
    assert_eq!(reopened.stats().await.unwrap().row_count, 1);
}

#[cfg(unix)]
#[tokio::test]
async fn a_symlink_database_target_is_rejected_without_touching_its_target() {
    use std::os::unix::fs::symlink;

    let directory = tempdir().unwrap();
    let root = directory.path().canonicalize().unwrap();
    let external = root.join("external.sqlite3");
    rusqlite::Connection::open(&external)
        .unwrap()
        .execute_batch("CREATE TABLE sentinel (value TEXT NOT NULL);")
        .unwrap();
    let path = root.join("translation-cache.sqlite3");
    symlink(&external, &path).unwrap();

    let cache = SqliteTranslationCache::open_or_unavailable(path, CachePolicy::production()).await;

    assert_eq!(cache.stats().await.unwrap_err().code(), "CACHE_UNAVAILABLE");
    assert_eq!(
        schema_objects(&external),
        vec![("table".to_owned(), "sentinel".to_owned())]
    );
}

#[cfg(unix)]
#[tokio::test]
async fn unsafe_sidecar_prevents_reset_and_leaves_both_targets_untouched() {
    use std::os::unix::fs::symlink;

    for suffix in ["-wal", "-shm"] {
        let directory = tempdir().unwrap();
        let path = canonical_cache_path(&directory);
        let cache = open_cache(
            &path,
            FakeClock::at(1_700_000_000),
            CachePolicy::production(),
        )
        .await;
        drop(cache);
        rusqlite::Connection::open(&path)
            .unwrap()
            .execute_batch("ALTER TABLE translations ADD COLUMN rogue TEXT;")
            .unwrap();
        let external = directory
            .path()
            .canonicalize()
            .unwrap()
            .join(format!("external{suffix}"));
        std::fs::write(&external, b"sidecar sentinel").unwrap();
        let sidecar = std::path::PathBuf::from(format!("{}{suffix}", path.display()));
        if sidecar.exists() {
            std::fs::remove_file(&sidecar).unwrap();
        }
        symlink(&external, &sidecar).unwrap();

        let unavailable =
            SqliteTranslationCache::open_or_unavailable(path.clone(), CachePolicy::production())
                .await;

        assert_eq!(
            unavailable.stats().await.unwrap_err().code(),
            "CACHE_UNAVAILABLE"
        );
        assert_eq!(std::fs::read(&external).unwrap(), b"sidecar sentinel");
        std::fs::remove_file(&sidecar).unwrap();
        let connection = rusqlite::Connection::open(&path).unwrap();
        let column_count = connection
            .query_row(
                "SELECT COUNT(*) FROM pragma_table_info('translations')",
                [],
                |row| row.get::<_, i64>(0),
            )
            .unwrap();
        assert_eq!(column_count, 15, "unsafe sidecar forbids reset");
    }
}

#[cfg(unix)]
#[tokio::test]
async fn parent_and_ancestor_symlinks_disable_cache_without_touching_the_real_database() {
    use std::os::unix::fs::symlink;

    for nested_depth in [0_u8, 1_u8] {
        let directory = tempdir().unwrap();
        let root = directory.path().canonicalize().unwrap();
        let real_parent = root.join("real-parent");
        std::fs::create_dir(&real_parent).unwrap();
        let alias = root.join("linked-parent");
        symlink(&real_parent, &alias).unwrap();

        let (real_path, aliased_path) = if nested_depth == 0 {
            (
                real_parent.join("translation-cache.sqlite3"),
                alias.join("translation-cache.sqlite3"),
            )
        } else {
            std::fs::create_dir(real_parent.join("nested")).unwrap();
            (
                real_parent.join("nested/translation-cache.sqlite3"),
                alias.join("nested/translation-cache.sqlite3"),
            )
        };
        let cache = open_cache(
            &real_path,
            FakeClock::at(1_700_000_000),
            CachePolicy::production(),
        )
        .await;
        cache
            .put(cache_record("linked-ancestor", "必须保留的译文"))
            .await
            .unwrap();
        drop(cache);
        let before = persisted_database_bytes(&real_path);

        let unavailable =
            SqliteTranslationCache::open_or_unavailable(aliased_path, CachePolicy::production())
                .await;

        assert_eq!(
            unavailable.stats().await.unwrap_err().code(),
            "CACHE_UNAVAILABLE",
            "linked ancestor depth {nested_depth} must be rejected"
        );
        assert_eq!(persisted_database_bytes(&real_path), before);
        assert_eq!(stored_cache_keys(&real_path).len(), 1);
    }
}

#[cfg(unix)]
#[tokio::test]
async fn database_and_sidecar_hard_links_disable_cache_without_mutating_either_link() {
    use std::os::unix::fs::MetadataExt;

    {
        let directory = tempdir().unwrap();
        let path = canonical_cache_path(&directory);
        let external = path.with_file_name("database-hard-link-sentinel");
        std::fs::write(&external, b"database hard-link sentinel").unwrap();
        std::fs::hard_link(&external, &path).unwrap();

        let unavailable =
            SqliteTranslationCache::open_or_unavailable(path.clone(), CachePolicy::production())
                .await;

        assert_eq!(
            unavailable.stats().await.unwrap_err().code(),
            "CACHE_UNAVAILABLE"
        );
        assert_eq!(
            std::fs::read(&external).unwrap(),
            b"database hard-link sentinel"
        );
        assert_eq!(std::fs::metadata(&external).unwrap().nlink(), 2);
    }

    for suffix in ["-wal", "-shm"] {
        let directory = tempdir().unwrap();
        let path = canonical_cache_path(&directory);
        let cache = open_cache(
            &path,
            FakeClock::at(1_700_000_000),
            CachePolicy::production(),
        )
        .await;
        drop(cache);
        rusqlite::Connection::open(&path)
            .unwrap()
            .execute_batch("ALTER TABLE translations ADD COLUMN rogue TEXT;")
            .unwrap();
        let sidecar = PathBuf::from(format!("{}{suffix}", path.display()));
        if sidecar.exists() {
            std::fs::remove_file(&sidecar).unwrap();
        }
        let external = path.with_file_name(format!("sidecar-hard-link{suffix}"));
        std::fs::write(&external, b"sidecar hard-link sentinel").unwrap();
        std::fs::hard_link(&external, &sidecar).unwrap();

        let unavailable =
            SqliteTranslationCache::open_or_unavailable(path.clone(), CachePolicy::production())
                .await;

        assert_eq!(
            unavailable.stats().await.unwrap_err().code(),
            "CACHE_UNAVAILABLE"
        );
        assert_eq!(
            std::fs::read(&external).unwrap(),
            b"sidecar hard-link sentinel"
        );
        assert_eq!(std::fs::metadata(&external).unwrap().nlink(), 2);
        let column_count = rusqlite::Connection::open(&path)
            .unwrap()
            .query_row(
                "SELECT COUNT(*) FROM pragma_table_info('translations')",
                [],
                |row| row.get::<_, i64>(0),
            )
            .unwrap();
        assert_eq!(column_count, 15, "unsafe sidecar forbids reset");
    }
}

#[tokio::test]
async fn a_directory_database_target_falls_back_disabled_without_removal() {
    let directory = tempdir().unwrap();
    let path = canonical_cache_path(&directory);
    std::fs::create_dir(&path).unwrap();

    let unavailable =
        SqliteTranslationCache::open_or_unavailable(path.clone(), CachePolicy::production()).await;

    assert_eq!(
        unavailable.stats().await.unwrap_err().code(),
        "CACHE_UNAVAILABLE"
    );
    assert!(path.is_dir());
}

#[tokio::test]
async fn persisted_database_never_contains_raw_source_path_or_request_material() {
    let directory = tempdir().unwrap();
    let path = directory.path().join("translation-cache.sqlite3");
    let cache = open_cache(
        &path,
        FakeClock::at(1_700_000_000),
        CachePolicy::production(),
    )
    .await;
    let forbidden_source = "UNIQUE RAW ENGLISH SELECTION never persist";
    let forbidden_path = "/private/papers/secret-paper.pdf";
    let forbidden_request = "Authorization: Bearer secret-fixture";
    let mut record = cache_record("privacy", "合规缓存译文");
    record.source_text_hash =
        academic_translator_lib::translation::source_text_hash(forbidden_source);

    cache.put(record).await.unwrap();
    let _ = cache.stats().await.unwrap();

    let persisted = [
        path.clone(),
        std::path::PathBuf::from(format!("{}-wal", path.display())),
        std::path::PathBuf::from(format!("{}-shm", path.display())),
    ]
    .into_iter()
    .filter_map(|candidate| std::fs::read(candidate).ok())
    .flatten()
    .collect::<Vec<_>>();
    for forbidden in [forbidden_source, forbidden_path, forbidden_request] {
        assert!(!persisted
            .windows(forbidden.len())
            .any(|bytes| bytes == forbidden.as_bytes()));
    }
}

#[tokio::test]
async fn hit_refreshes_sliding_ttl_and_only_rows_unused_more_than_seven_days_expire() {
    let directory = tempdir().unwrap();
    let path = directory.path().join("translation-cache.sqlite3");
    let clock = FakeClock::at(1_700_000_000);
    let cache = open_cache(&path, clock.clone(), CachePolicy::production()).await;
    let lookup = cache_lookup("sliding");

    cache.put(cache_record("sliding", "译文 A")).await.unwrap();
    clock.advance(Duration::from_secs(6 * 24 * 60 * 60));
    let hit = cache.get(&lookup).await.unwrap().expect("fresh hit");
    assert_eq!(hit.translation, "译文 A");
    assert_eq!(hit.last_accessed_at, clock.now_unix_seconds());

    clock.advance(SEVEN_DAYS);
    cache.cleanup().await.unwrap();
    assert_eq!(cache.stats().await.unwrap().row_count, 1);
    assert!(
        cache.get(&lookup).await.unwrap().is_some(),
        "exactly seven days remains valid"
    );

    clock.advance(SEVEN_DAYS + Duration::from_secs(1));
    cache.cleanup().await.unwrap();
    assert_eq!(cache.stats().await.unwrap().row_count, 0);
    assert!(cache.get(&lookup).await.unwrap().is_none());
}

#[tokio::test]
async fn cleanup_runs_on_initialization_and_after_every_successful_write() {
    let directory = tempdir().unwrap();
    let path = directory.path().join("translation-cache.sqlite3");
    let clock = FakeClock::at(1_700_000_000);
    let first_lookup = cache_lookup("expired-first");

    let cache = open_cache(&path, clock.clone(), CachePolicy::production()).await;
    cache
        .put(cache_record("expired-first", "旧译文"))
        .await
        .unwrap();
    clock.advance(SEVEN_DAYS + Duration::from_secs(1));
    cache.put(cache_record("fresh", "新译文")).await.unwrap();
    assert_eq!(cache.stats().await.unwrap().row_count, 1);
    assert!(
        cache.get(&first_lookup).await.unwrap().is_none(),
        "write cleanup removes expired rows"
    );
    drop(cache);

    let second_lookup = cache_lookup("expired-second");
    let cache = open_cache(&path, clock.clone(), CachePolicy::production()).await;
    cache
        .put(cache_record("expired-second", "第二条旧译文"))
        .await
        .unwrap();
    drop(cache);
    clock.advance(SEVEN_DAYS + Duration::from_secs(1));

    let reopened = open_cache(&path, clock, CachePolicy::production()).await;
    assert_eq!(reopened.stats().await.unwrap().row_count, 0);
    assert!(
        reopened.get(&second_lookup).await.unwrap().is_none(),
        "startup cleanup removes expired rows"
    );
}

#[tokio::test]
async fn startup_cleanup_removes_invalid_times_before_lru_can_evict_valid_data() {
    let directory = tempdir().unwrap();
    let path = directory.path().join("translation-cache.sqlite3");
    let now = 1_700_000_000;
    let cache = open_cache(&path, FakeClock::at(now), CachePolicy::production()).await;
    let fixtures = [
        "valid-time",
        "negative-created",
        "created-after-access",
        "future-access",
    ];
    let mut keys = Vec::new();
    for (index, label) in fixtures.into_iter().enumerate() {
        let record = cache_record(
            label,
            char::from(b'a' + u8::try_from(index).unwrap())
                .to_string()
                .repeat(12_000),
        );
        keys.push(record.cache_key.clone());
        cache.put(record).await.unwrap();
    }
    drop(cache);
    let connection = rusqlite::Connection::open(&path).unwrap();
    connection
        .execute(
            "UPDATE translations SET created_at = -1 WHERE cache_key = ?1",
            [&keys[1]],
        )
        .unwrap();
    connection
        .execute(
            "UPDATE translations SET created_at = ?2, last_accessed_at = ?3 \
             WHERE cache_key = ?1",
            rusqlite::params![&keys[2], now + 1, now],
        )
        .unwrap();
    connection
        .execute(
            "UPDATE translations SET last_accessed_at = ?2 WHERE cache_key = ?1",
            rusqlite::params![&keys[3], now + 1],
        )
        .unwrap();
    drop(connection);

    let reopened = open_cache(
        &path,
        FakeClock::at(now),
        CachePolicy {
            ttl: SEVEN_DAYS,
            max_bytes: 64 * 1024,
        },
    )
    .await;

    assert_eq!(stored_cache_keys(&path), vec![keys[0].clone()]);
    assert_eq!(reopened.stats().await.unwrap().row_count, 1);
}

#[tokio::test]
async fn startup_cleanup_deletes_real_timestamps_before_lru_ordering() {
    let directory = tempdir().unwrap();
    let path = directory.path().join("translation-cache.sqlite3");
    let now = 1_700_000_000;
    let cache = open_cache(&path, FakeClock::at(now), CachePolicy::production()).await;
    let valid = cache_record("integer-time-under-pressure", "v".repeat(12_000));
    let corrupt = cache_record("real-time-under-pressure", "c".repeat(12_000));
    let valid_key = valid.cache_key.clone();
    let corrupt_key = corrupt.cache_key.clone();
    cache.put(valid).await.unwrap();
    cache.put(corrupt).await.unwrap();
    drop(cache);

    let connection = rusqlite::Connection::open(&path).unwrap();
    connection
        .execute(
            "UPDATE translations SET created_at = ?2, last_accessed_at = ?2 \
             WHERE cache_key = ?1",
            rusqlite::params![&valid_key, now - 1],
        )
        .unwrap();
    connection
        .execute(
            "UPDATE translations SET created_at = ?2, last_accessed_at = ?2 \
             WHERE cache_key = ?1",
            rusqlite::params![&corrupt_key, 1_699_999_999.5_f64],
        )
        .unwrap();
    let storage_classes = connection
        .query_row(
            "SELECT typeof(created_at), typeof(last_accessed_at) \
             FROM translations WHERE cache_key = ?1",
            [&corrupt_key],
            |row| Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?)),
        )
        .unwrap();
    assert_eq!(storage_classes, ("real".to_owned(), "real".to_owned()));
    drop(connection);

    let reopened = open_cache(
        &path,
        FakeClock::at(now),
        CachePolicy {
            ttl: SEVEN_DAYS,
            max_bytes: 40 * 1024,
        },
    )
    .await;

    assert_eq!(stored_cache_keys(&path), vec![valid_key]);
    assert_eq!(reopened.stats().await.unwrap().row_count, 1);
}

#[tokio::test]
async fn corrupt_cache_rows_are_deleted_without_display_or_ttl_renewal() {
    let mutations = [
        (
            "wrong-source-hash",
            "UPDATE translations SET source_text_hash = \
             '0000000000000000000000000000000000000000000000000000000000000000'",
        ),
        (
            "wrong-language",
            "UPDATE translations SET source_language = 'fr'",
        ),
        (
            "wrong-metadata",
            "UPDATE translations SET model_revision = 'rogue-revision'",
        ),
        (
            "future-timestamps",
            "UPDATE translations SET created_at = 1700000001, last_accessed_at = 1700000001",
        ),
        (
            "inconsistent-timestamps",
            "UPDATE translations SET created_at = 1700000000, last_accessed_at = 1699999999",
        ),
        (
            "negative-tokens",
            "UPDATE translations SET input_tokens = -1",
        ),
        (
            "uppercase-hash",
            "UPDATE translations SET source_text_hash = \
             'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA'",
        ),
        (
            "blank-translation",
            "UPDATE translations SET translation = '   '",
        ),
    ];

    for (label, mutation) in mutations {
        let directory = tempdir().unwrap();
        let path = directory.path().join("translation-cache.sqlite3");
        let cache = open_cache(
            &path,
            FakeClock::at(1_700_000_000),
            CachePolicy::production(),
        )
        .await;
        let record = cache_record(label, "合法译文");
        let lookup = academic_translator_lib::cache::CacheLookup::from(&record);
        cache.put(record).await.unwrap();
        rusqlite::Connection::open(&path)
            .unwrap()
            .execute_batch(mutation)
            .unwrap();

        let error = cache.get(&lookup).await.unwrap_err();

        assert_eq!(error.code(), "CACHE_UNAVAILABLE", "case {label}");
        assert_eq!(cache.stats().await.unwrap().row_count, 0, "case {label}");
        cache
            .clear()
            .await
            .expect("runtime failure leaves clear usable");
    }
}

#[tokio::test]
async fn physical_size_cleanup_removes_the_least_recently_used_row_first() {
    let directory = tempdir().unwrap();
    let path = directory.path().join("translation-cache.sqlite3");
    let clock = FakeClock::at(1_700_000_000);
    let policy = CachePolicy {
        ttl: SEVEN_DAYS,
        max_bytes: 80 * 1024,
    };
    let cache = open_cache(&path, clock.clone(), policy).await;
    let old_key = cache_record("large-0", "").cache_key;
    let mut newest_key = String::new();
    for index in 0..8 {
        let label = format!("large-{index}");
        let record = cache_record(&label, char::from(b'a' + index).to_string().repeat(12_000));
        newest_key = record.cache_key.clone();
        cache.put(record).await.unwrap();
        clock.advance(Duration::from_secs(1));
    }

    let stored = stored_cache_keys(&path);
    assert!(!stored.contains(&old_key));
    assert!(stored.contains(&newest_key));
    let stats = cache.stats().await.unwrap();
    assert!(stats.row_count > 0);
    assert!(stats.row_count < 8);
    assert_eq!(stats.database_bytes, physical_database_bytes(&path));
    assert!(stats.database_bytes <= policy.max_bytes);
}

#[tokio::test]
async fn same_clock_lru_uses_created_at_then_cache_key_as_deterministic_tie_breakers() {
    let directory = tempdir().unwrap();
    let path = directory.path().join("translation-cache.sqlite3");
    let clock = FakeClock::at(1_700_000_000);
    let policy = CachePolicy {
        ttl: SEVEN_DAYS,
        max_bytes: 80 * 1024,
    };
    let cache = open_cache(&path, clock, policy).await;
    let mut all_keys = Vec::new();
    for index in 0..8 {
        let record = cache_record(
            &format!("same-clock-{index}"),
            char::from(b'a' + index).to_string().repeat(12_000),
        );
        all_keys.push(record.cache_key.clone());
        cache.put(record).await.unwrap();
    }
    all_keys.sort();

    let remaining = stored_cache_keys(&path);

    assert!(!remaining.is_empty());
    assert!(remaining.len() < all_keys.len());
    assert_eq!(remaining, all_keys[all_keys.len() - remaining.len()..]);
}

#[tokio::test]
async fn a_cap_below_empty_database_overhead_terminates_with_cache_unavailable() {
    let directory = tempdir().unwrap();
    let path = canonical_cache_path(&directory);
    let open = SqliteTranslationCache::open_with_clock(
        path.clone(),
        CachePolicy {
            ttl: SEVEN_DAYS,
            max_bytes: 1,
        },
        Arc::new(FakeClock::at(1_700_000_000)),
    );

    let result = tokio::time::timeout(Duration::from_secs(1), open)
        .await
        .expect("bounded cleanup must terminate");
    let error = match result {
        Ok(_) => panic!("empty database overhead cannot satisfy a one-byte cap"),
        Err(error) => error,
    };

    assert_eq!(error.code(), "CACHE_UNAVAILABLE");
    assert_eq!(physical_database_bytes(&path), 0);
}

#[tokio::test]
async fn clear_and_stats_report_only_counts_and_physical_bytes() {
    let directory = tempdir().unwrap();
    let path = directory.path().join("translation-cache.sqlite3");
    let cache = open_cache(
        &path,
        FakeClock::at(1_700_000_000),
        CachePolicy::production(),
    )
    .await;

    cache.put(cache_record("a", "译文 A")).await.unwrap();
    cache.put(cache_record("b", "译文 B")).await.unwrap();
    let populated = cache.stats().await.unwrap();
    assert_eq!(populated.row_count, 2);
    assert_eq!(populated.database_bytes, physical_database_bytes(&path));

    cache.clear().await.unwrap();
    let empty = cache.stats().await.unwrap();
    assert_eq!(empty.row_count, 0);
    assert_eq!(empty.database_bytes, physical_database_bytes(&path));
    assert!(empty.database_bytes <= populated.database_bytes);
}

#[tokio::test]
async fn invalid_records_fail_with_only_the_stable_cache_error() {
    let directory = tempdir().unwrap();
    let path = directory.path().join("translation-cache.sqlite3");
    let cache = open_cache(
        &path,
        FakeClock::at(1_700_000_000),
        CachePolicy::production(),
    )
    .await;
    let mut invalid = cache_record("invalid", "译文");
    invalid.cache_key = "not-a-sha256-key".to_owned();

    let error = cache.put(invalid).await.unwrap_err();

    assert_eq!(error.code(), "CACHE_UNAVAILABLE");
    assert_eq!(format!("{error}"), "translation cache is unavailable");
}

#[test]
fn production_policy_is_exactly_seven_days_and_one_hundred_mibibytes() {
    let policy = CachePolicy::production();

    assert_eq!(policy.ttl, SEVEN_DAYS);
    assert_eq!(policy.max_bytes, 100 * 1024 * 1024);
}
