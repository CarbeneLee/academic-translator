use serde::Deserialize;

use crate::errors::AppError;

#[derive(Deserialize)]
struct YoudaoResponse {
    #[serde(rename = "errorCode")]
    error_code: String,
    #[serde(default)]
    translation: Vec<String>,
}

pub(super) fn parse_response(body: &[u8]) -> Result<String, AppError> {
    let response: YoudaoResponse =
        serde_json::from_slice(body).map_err(|_| AppError::malformed_response())?;
    match response.error_code.as_str() {
        "0" => response
            .translation
            .into_iter()
            .find(|translation| !translation.trim().is_empty())
            .ok_or_else(AppError::malformed_response),
        "108" | "110" | "111" | "202" | "203" | "205" | "206" | "207" => {
            Err(AppError::auth_invalid())
        }
        "411" => Err(AppError::rate_limited()),
        _ => Err(AppError::provider_unavailable()),
    }
}
