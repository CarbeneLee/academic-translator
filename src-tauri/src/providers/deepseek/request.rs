use serde::Serialize;

use crate::{
    errors::AppError,
    translation::{ProviderRequest, TranslationMode},
};

use super::{
    prompt::{translation_schema, CANONICAL_PROMPT_ACADEMIC_ZH_V1},
    DEEPSEEK_MODEL_ID,
};

#[derive(Serialize)]
pub(super) struct DeepseekRequest {
    model: &'static str,
    instructions: &'static str,
    input: [InputMessage; 1],
    reasoning: Reasoning,
    temperature: f32,
    stream: bool,
    max_output_tokens: u32,
    text: TextConfiguration,
}

#[derive(Serialize)]
struct InputMessage {
    role: &'static str,
    content: [InputContent; 1],
}

#[derive(Serialize)]
struct InputContent {
    #[serde(rename = "type")]
    content_type: &'static str,
    text: String,
}

#[derive(Serialize)]
struct Reasoning {
    effort: &'static str,
}

#[derive(Serialize)]
struct TextConfiguration {
    format: TextFormat,
}

#[derive(Serialize)]
struct TextFormat {
    #[serde(rename = "type")]
    format_type: &'static str,
    name: &'static str,
    schema: serde_json::Value,
}

#[derive(Serialize)]
struct SelectedInput<'a> {
    mode: TranslationMode,
    selected_text: &'a str,
}

pub(super) fn build_request(request: &ProviderRequest) -> Result<DeepseekRequest, AppError> {
    let selected_input = serde_json::to_string(&SelectedInput {
        mode: request.mode,
        selected_text: &request.selected_text,
    })
    .map_err(|_| AppError::provider_unavailable())?;

    Ok(DeepseekRequest {
        model: DEEPSEEK_MODEL_ID,
        instructions: CANONICAL_PROMPT_ACADEMIC_ZH_V1,
        input: [InputMessage {
            role: "user",
            content: [InputContent {
                content_type: "input_text",
                text: selected_input,
            }],
        }],
        reasoning: Reasoning { effort: "none" },
        temperature: 0.2,
        stream: false,
        max_output_tokens: request.max_output_tokens,
        text: TextConfiguration {
            format: TextFormat {
                format_type: "json_schema",
                name: "academic_translation_result",
                schema: translation_schema(),
            },
        },
    })
}
