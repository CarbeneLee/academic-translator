mod support;

use std::{sync::Arc, time::Duration};

use academic_translator_lib::cache::{
    CachePolicy, Clock, SqliteTranslationCache, TranslationCache,
};
use tempfile::tempdir;

use support::{cache_record, physical_database_bytes, FakeClock};

const SEVEN_DAYS: Duration = Duration::from_secs(7 * 24 * 60 * 60);

async fn open_cache(
    path: &std::path::Path,
    clock: impl Clock + 'static,
    policy: CachePolicy,
) -> SqliteTranslationCache {
    SqliteTranslationCache::open_with_clock(path.to_path_buf(), policy, Arc::new(clock))
        .await
        .expect("test cache opens")
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
        cache.column_names("translations").await.unwrap(),
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
    assert_eq!(cache.schema_version().await.unwrap(), 1);
    assert_eq!(cache.auto_vacuum_mode().await.unwrap(), 1);
    assert_eq!(
        cache
            .index_columns("translations_last_accessed_idx")
            .await
            .unwrap(),
        vec!["last_accessed_at"]
    );
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
    let key = cache_record("sliding", "译文 A").cache_key;

    cache.put(cache_record("sliding", "译文 A")).await.unwrap();
    clock.advance(Duration::from_secs(6 * 24 * 60 * 60));
    let hit = cache.get(&key).await.unwrap().expect("fresh hit");
    assert_eq!(hit.translation, "译文 A");
    assert_eq!(hit.last_accessed_at, clock.now_unix_seconds());

    clock.advance(SEVEN_DAYS);
    cache.cleanup().await.unwrap();
    assert_eq!(cache.stats().await.unwrap().row_count, 1);
    assert!(
        cache.get(&key).await.unwrap().is_some(),
        "exactly seven days remains valid"
    );

    clock.advance(SEVEN_DAYS + Duration::from_secs(1));
    cache.cleanup().await.unwrap();
    assert_eq!(cache.stats().await.unwrap().row_count, 0);
    assert!(cache.get(&key).await.unwrap().is_none());
}

#[tokio::test]
async fn cleanup_runs_on_initialization_and_after_every_successful_write() {
    let directory = tempdir().unwrap();
    let path = directory.path().join("translation-cache.sqlite3");
    let clock = FakeClock::at(1_700_000_000);
    let first_key = cache_record("expired-first", "旧译文").cache_key;

    let cache = open_cache(&path, clock.clone(), CachePolicy::production()).await;
    cache
        .put(cache_record("expired-first", "旧译文"))
        .await
        .unwrap();
    clock.advance(SEVEN_DAYS + Duration::from_secs(1));
    cache.put(cache_record("fresh", "新译文")).await.unwrap();
    assert_eq!(cache.stats().await.unwrap().row_count, 1);
    assert!(
        cache.get(&first_key).await.unwrap().is_none(),
        "write cleanup removes expired rows"
    );
    drop(cache);

    let second_key = cache_record("expired-second", "第二条旧译文").cache_key;
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
        reopened.get(&second_key).await.unwrap().is_none(),
        "startup cleanup removes expired rows"
    );
}

#[tokio::test]
async fn physical_size_cleanup_removes_the_least_recently_used_row_first() {
    let directory = tempdir().unwrap();
    let path = directory.path().join("translation-cache.sqlite3");
    let clock = FakeClock::at(1_700_000_000);
    let policy = CachePolicy {
        ttl: SEVEN_DAYS,
        max_bytes: 256 * 1024,
    };
    let cache = open_cache(&path, clock.clone(), policy).await;
    let old_key = cache_record("old-large", "").cache_key;
    let new_key = cache_record("new-large", "").cache_key;

    cache
        .put(cache_record("old-large", "o".repeat(180_000)))
        .await
        .unwrap();
    clock.advance(Duration::from_secs(1));
    cache
        .put(cache_record("new-large", "n".repeat(180_000)))
        .await
        .unwrap();

    assert!(cache.get(&old_key).await.unwrap().is_none());
    assert!(cache.get(&new_key).await.unwrap().is_some());
    let stats = cache.stats().await.unwrap();
    assert_eq!(stats.row_count, 1);
    assert_eq!(stats.database_bytes, physical_database_bytes(&path));
    assert!(stats.database_bytes <= policy.max_bytes);
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
