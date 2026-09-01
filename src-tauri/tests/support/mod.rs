use std::{
    sync::{
        atomic::{AtomicI64, Ordering},
        Arc,
    },
    time::Duration,
};

use academic_translator_lib::{
    cache::CacheRecord,
    translation::{source_text_hash, ProviderId, TokenUsage, NORMALIZATION_VERSION},
};

#[derive(Clone)]
pub struct FakeClock {
    now: Arc<AtomicI64>,
}

impl FakeClock {
    pub fn at(now: i64) -> Self {
        Self {
            now: Arc::new(AtomicI64::new(now)),
        }
    }

    pub fn advance(&self, duration: Duration) {
        let seconds = i64::try_from(duration.as_secs()).expect("test duration fits i64");
        self.now.fetch_add(seconds, Ordering::SeqCst);
    }
}

impl academic_translator_lib::cache::Clock for FakeClock {
    fn now_unix_seconds(&self) -> i64 {
        self.now.load(Ordering::SeqCst)
    }
}

pub fn cache_record(label: &str, translation: impl Into<String>) -> CacheRecord {
    CacheRecord {
        cache_key: source_text_hash(&format!("cache-key-{label}")),
        source_text_hash: source_text_hash(&format!("selected-source-{label}")),
        source_language: "en".to_owned(),
        target_language: "zh-CN".to_owned(),
        provider: ProviderId::Deepseek,
        model_id: "deepseek-v4-flash".to_owned(),
        model_revision: "DeepSeek-V4-Flash-0731".to_owned(),
        prompt_version: "academic-zh-v1".to_owned(),
        normalization_version: NORMALIZATION_VERSION.to_owned(),
        translation: translation.into(),
        usage: TokenUsage {
            input_tokens: Some(17),
            output_tokens: Some(11),
        },
    }
}

pub fn physical_database_bytes(path: &std::path::Path) -> u64 {
    [
        path.to_path_buf(),
        std::path::PathBuf::from(format!("{}-wal", path.display())),
        std::path::PathBuf::from(format!("{}-shm", path.display())),
    ]
    .into_iter()
    .map(|candidate| {
        std::fs::metadata(candidate)
            .map(|metadata| metadata.len())
            .unwrap_or(0)
    })
    .sum()
}
