use serde::Serialize;
use sha2::{Digest, Sha256};

use crate::errors::TranslationDomainError;

use super::{
    ModelMetadata, ProviderId, CACHE_KEY_VERSION, NORMALIZATION_VERSION, SOURCE_LANGUAGE,
    TARGET_LANGUAGE,
};

#[derive(Serialize)]
struct CanonicalCacheKeyPayload<'a> {
    cache_key_version: u8,
    source_text_hash: String,
    source_language: &'static str,
    target_language: &'static str,
    provider: ProviderId,
    model_id: &'a str,
    model_revision: &'a str,
    prompt_version: &'a str,
    normalization_version: &'static str,
}

pub fn source_text_hash(normalized_text: &str) -> String {
    sha256_hex(normalized_text.as_bytes())
}

pub fn cache_key(
    normalized_text: &str,
    provider: ProviderId,
    metadata: &ModelMetadata,
) -> Result<String, TranslationDomainError> {
    let payload = CanonicalCacheKeyPayload {
        cache_key_version: CACHE_KEY_VERSION,
        source_text_hash: source_text_hash(normalized_text),
        source_language: SOURCE_LANGUAGE,
        target_language: TARGET_LANGUAGE,
        provider,
        model_id: &metadata.model_id,
        model_revision: &metadata.model_revision,
        prompt_version: &metadata.prompt_version,
        normalization_version: NORMALIZATION_VERSION,
    };
    let canonical_json = serde_json::to_vec(&payload)?;

    Ok(sha256_hex(&canonical_json))
}

fn sha256_hex(bytes: &[u8]) -> String {
    hex::encode(Sha256::digest(bytes))
}
