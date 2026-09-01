use serde::Deserialize;
use serde_json::Value;

use crate::{errors::AppError, translation::TokenUsage};

use super::prompt::translation_schema;

#[derive(Deserialize)]
struct ResponsesEnvelope {
    status: String,
    output: Vec<Value>,
    #[serde(default)]
    usage: Option<ResponsesUsage>,
}

#[derive(Deserialize)]
struct ResponsesUsage {
    #[serde(default)]
    input_tokens: Option<u64>,
    #[serde(default)]
    output_tokens: Option<u64>,
}

#[derive(Deserialize)]
struct MessageOutput {
    #[serde(rename = "type")]
    output_type: String,
    content: Vec<Value>,
}

#[derive(Deserialize)]
struct OutputText {
    #[serde(rename = "type")]
    content_type: String,
    text: String,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct AcademicTranslationResult {
    translation: String,
}

pub(super) fn parse_response(
    body: &[u8],
    source_character_count: usize,
) -> Result<(String, TokenUsage), AppError> {
    let envelope: ResponsesEnvelope =
        serde_json::from_slice(body).map_err(|_| AppError::malformed_response())?;
    if envelope.status != "completed" || envelope.output.len() != 1 {
        return Err(AppError::malformed_response());
    }

    let message: MessageOutput = serde_json::from_value(
        envelope
            .output
            .into_iter()
            .next()
            .ok_or_else(AppError::malformed_response)?,
    )
    .map_err(|_| AppError::malformed_response())?;
    if message.output_type != "message" || message.content.len() != 1 {
        return Err(AppError::malformed_response());
    }

    let output_text: OutputText = serde_json::from_value(
        message
            .content
            .into_iter()
            .next()
            .ok_or_else(AppError::malformed_response)?,
    )
    .map_err(|_| AppError::malformed_response())?;
    if output_text.content_type != "output_text" {
        return Err(AppError::malformed_response());
    }

    let candidate: Value =
        serde_json::from_str(&output_text.text).map_err(|_| AppError::malformed_response())?;
    let validator = jsonschema::validator_for(&translation_schema())
        .map_err(|_| AppError::malformed_response())?;
    if !validator.is_valid(&candidate) {
        return Err(AppError::malformed_response());
    }

    let result: AcademicTranslationResult =
        serde_json::from_value(candidate).map_err(|_| AppError::malformed_response())?;
    let translation_length = result.translation.chars().count();
    let dynamic_limit = source_character_count.saturating_mul(3).clamp(256, 12_000);
    if result.translation.trim().is_empty() || translation_length > dynamic_limit {
        return Err(AppError::malformed_response());
    }

    let usage = envelope.usage.unwrap_or(ResponsesUsage {
        input_tokens: None,
        output_tokens: None,
    });
    Ok((
        result.translation,
        TokenUsage {
            input_tokens: usage.input_tokens,
            output_tokens: usage.output_tokens,
        },
    ))
}
