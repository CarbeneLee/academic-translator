use async_trait::async_trait;
use serde::Serialize;
use tokio_util::sync::CancellationToken;

use crate::errors::AppError;

use super::{ModelMetadata, ProviderId, TranslationMode};

#[derive(Debug, Clone)]
pub struct ProviderRequest {
    pub selected_text: String,
    pub source_language: &'static str,
    pub target_language: &'static str,
    pub mode: TranslationMode,
    pub max_output_tokens: u32,
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TokenUsage {
    pub input_tokens: Option<u64>,
    pub output_tokens: Option<u64>,
}

#[derive(Debug, Clone)]
pub struct ProviderResult {
    pub provider: ProviderId,
    pub model: ModelMetadata,
    pub translation: String,
    pub usage: TokenUsage,
}

#[async_trait]
pub trait TranslationProvider: Send + Sync {
    fn provider_id(&self) -> ProviderId;
    fn model_metadata(&self) -> ModelMetadata;
    async fn translate(
        &self,
        request: ProviderRequest,
        cancellation: CancellationToken,
    ) -> Result<ProviderResult, AppError>;
}
