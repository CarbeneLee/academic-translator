use reqwest::Response;
use tokio::time::Instant;
use tokio_util::sync::CancellationToken;

use crate::errors::AppError;

pub(crate) const MAX_PROVIDER_RESPONSE_BYTES: usize = 262_144;

pub(crate) async fn read_bounded_response_body(
    mut response: Response,
    deadline: Instant,
    cancellation: &CancellationToken,
) -> Result<Vec<u8>, AppError> {
    let content_length = response.content_length();
    if content_length.is_some_and(|length| length > MAX_PROVIDER_RESPONSE_BYTES as u64) {
        return Err(AppError::malformed_response());
    }

    let initial_capacity = content_length
        .and_then(|length| usize::try_from(length).ok())
        .unwrap_or_default()
        .min(MAX_PROVIDER_RESPONSE_BYTES);
    let mut body = Vec::with_capacity(initial_capacity);

    loop {
        let next_chunk = tokio::select! {
            biased;
            _ = cancellation.cancelled() => return Err(AppError::request_cancelled()),
            result = tokio::time::timeout_at(deadline, response.chunk()) => {
                match result {
                    Ok(Ok(chunk)) => chunk,
                    Ok(Err(error)) if error.is_timeout() => {
                        return Err(AppError::request_timeout());
                    }
                    Ok(Err(_)) => return Err(AppError::network_unavailable(false)),
                    Err(_) => return Err(AppError::request_timeout()),
                }
            }
        };

        let Some(chunk) = next_chunk else {
            return Ok(body);
        };
        if chunk.len() > MAX_PROVIDER_RESPONSE_BYTES - body.len() {
            return Err(AppError::malformed_response());
        }
        body.extend_from_slice(&chunk);
    }
}
