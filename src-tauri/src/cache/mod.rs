mod migrations;
mod sqlite;

use std::{sync::Arc, time::Duration};

use async_trait::async_trait;
use serde::Serialize;

use crate::{
    errors::AppError,
    translation::{ProviderId, TokenUsage},
};

pub use sqlite::SqliteTranslationCache;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct CachePolicy {
    pub ttl: Duration,
    pub max_bytes: u64,
}

impl CachePolicy {
    pub const fn production() -> Self {
        Self {
            ttl: Duration::from_secs(7 * 24 * 60 * 60),
            max_bytes: 100 * 1024 * 1024,
        }
    }
}

pub trait Clock: Send + Sync {
    fn now_unix_seconds(&self) -> i64;
}

#[derive(Debug, Default)]
pub struct SystemClock;

impl Clock for SystemClock {
    fn now_unix_seconds(&self) -> i64 {
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .ok()
            .and_then(|duration| i64::try_from(duration.as_secs()).ok())
            .unwrap_or(i64::MAX)
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CacheRecord {
    pub cache_key: String,
    pub source_text_hash: String,
    pub source_language: String,
    pub target_language: String,
    pub provider: ProviderId,
    pub model_id: String,
    pub model_revision: String,
    pub prompt_version: String,
    pub normalization_version: String,
    pub translation: String,
    pub usage: TokenUsage,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CachedTranslation {
    pub provider: ProviderId,
    pub model_id: String,
    pub model_revision: String,
    pub prompt_version: String,
    pub normalization_version: String,
    pub translation: String,
    pub created_at: i64,
    pub last_accessed_at: i64,
    pub usage: TokenUsage,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CacheStats {
    pub row_count: u64,
    pub database_bytes: u64,
}

#[async_trait]
pub trait TranslationCache: Send + Sync {
    async fn get(&self, key: &str) -> Result<Option<CachedTranslation>, AppError>;
    async fn put(&self, record: CacheRecord) -> Result<(), AppError>;
    async fn cleanup(&self) -> Result<CacheStats, AppError>;
    async fn clear(&self) -> Result<(), AppError>;
    async fn stats(&self) -> Result<CacheStats, AppError>;
}

pub(crate) fn production_clock() -> Arc<dyn Clock> {
    Arc::new(SystemClock)
}
