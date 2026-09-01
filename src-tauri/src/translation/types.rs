use serde::{Deserialize, Serialize};
use uuid::Uuid;

use super::TokenUsage;

pub const NORMALIZATION_VERSION: &str = "academic-normalization-v1";
pub const CACHE_KEY_VERSION: u8 = 1;
pub const SOURCE_LANGUAGE: &str = "en";
pub const TARGET_LANGUAGE: &str = "zh-CN";

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ProviderId {
    Deepseek,
    Youdao,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum TranslationMode {
    Term,
    Passage,
}

#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct SelectedFragmentInput {
    pub id: String,
    pub order: u32,
    pub text: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TranslationChunk {
    pub index: usize,
    pub text: String,
    pub max_output_tokens: u32,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PreparedTranslation {
    pub normalized_text: String,
    pub mode: TranslationMode,
    pub chunks: Vec<TranslationChunk>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ModelMetadata {
    pub model_id: String,
    pub model_revision: String,
    pub prompt_version: String,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct TranslationRequestDto {
    pub request_id: Uuid,
    pub document_session_id: Uuid,
    pub provider: ProviderId,
    pub fragments: Vec<SelectedFragmentInput>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum DiagnosticCode {
    CacheUnavailable,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TranslationResultDto {
    pub request_id: Uuid,
    pub document_session_id: Uuid,
    pub provider: ProviderId,
    pub model_id: String,
    pub normalized_source: String,
    pub translation: String,
    pub cache_hit: bool,
    pub usage: TokenUsage,
    pub diagnostics: Vec<DiagnosticCode>,
}
