mod prompt;
mod request;
mod response;

use std::{sync::Arc, time::Duration};

use async_trait::async_trait;
use reqwest::StatusCode;
use tokio::time::Instant;
use tokio_util::sync::CancellationToken;

use crate::{
    errors::AppError,
    secrets::{CredentialKind, SecretStore},
    translation::{
        ModelMetadata, ProviderId, ProviderRequest, ProviderResult, TranslationProvider,
    },
};

use self::{request::build_request, response::parse_response};
use super::response_body::read_bounded_response_body;

pub const DEEPSEEK_MODEL_ID: &str = "deepseek-v4-flash";
pub const DEEPSEEK_MODEL_REVISION: &str = "DeepSeek-V4-Flash-0731";
pub const PROMPT_VERSION: &str = "academic-zh-v1";
pub const DEEPSEEK_RESPONSES_URL: &str = "https://api.deepseek.com/responses";

const CONNECT_TIMEOUT: Duration = Duration::from_secs(5);
const TOTAL_TIMEOUT: Duration = Duration::from_secs(45);
const MAXIMUM_REQUEST_CHARACTERS: usize = 4_000;

enum Endpoint {
    Production,
    #[cfg(test)]
    Test(String),
}

impl Endpoint {
    fn as_str(&self) -> &str {
        match self {
            Self::Production => DEEPSEEK_RESPONSES_URL,
            #[cfg(test)]
            Self::Test(endpoint) => endpoint,
        }
    }
}

pub struct DeepseekProvider {
    client: reqwest::Client,
    secret_store: Arc<dyn SecretStore>,
    endpoint: Endpoint,
    total_timeout: Duration,
}

impl DeepseekProvider {
    pub fn new(secret_store: Arc<dyn SecretStore>) -> Result<Self, AppError> {
        Self::with_endpoint(secret_store, Endpoint::Production, TOTAL_TIMEOUT)
    }

    fn with_endpoint(
        secret_store: Arc<dyn SecretStore>,
        endpoint: Endpoint,
        total_timeout: Duration,
    ) -> Result<Self, AppError> {
        let client = reqwest::Client::builder()
            .connect_timeout(CONNECT_TIMEOUT)
            .redirect(reqwest::redirect::Policy::none())
            .build()
            .map_err(|_| AppError::provider_unavailable())?;
        Ok(Self {
            client,
            secret_store,
            endpoint,
            total_timeout,
        })
    }

    #[cfg(test)]
    fn for_test(
        secret_store: Arc<dyn SecretStore>,
        endpoint: String,
        total_timeout: Duration,
    ) -> Result<Self, AppError> {
        Self::with_endpoint(secret_store, Endpoint::Test(endpoint), total_timeout)
    }
}

#[async_trait]
impl TranslationProvider for DeepseekProvider {
    fn provider_id(&self) -> ProviderId {
        ProviderId::Deepseek
    }

    fn model_metadata(&self) -> ModelMetadata {
        ModelMetadata {
            model_id: DEEPSEEK_MODEL_ID.to_owned(),
            model_revision: DEEPSEEK_MODEL_REVISION.to_owned(),
            prompt_version: PROMPT_VERSION.to_owned(),
        }
    }

    async fn translate(
        &self,
        request: ProviderRequest,
        cancellation: CancellationToken,
    ) -> Result<ProviderResult, AppError> {
        if cancellation.is_cancelled() {
            return Err(AppError::request_cancelled());
        }
        if request.selected_text.chars().count() > MAXIMUM_REQUEST_CHARACTERS {
            return Err(AppError::selection_too_large());
        }

        let api_key = self
            .secret_store
            .get(CredentialKind::DeepseekApiKey)
            .await?
            .ok_or_else(AppError::credentials_missing)?;
        let payload = build_request(&request)?;
        let outbound = self
            .client
            .post(self.endpoint.as_str())
            .bearer_auth(api_key.expose_secret())
            .json(&payload);
        drop(api_key);

        let deadline = Instant::now() + self.total_timeout;
        let response = tokio::select! {
            biased;
            _ = cancellation.cancelled() => return Err(AppError::request_cancelled()),
            result = tokio::time::timeout_at(deadline, outbound.send()) => {
                match result {
                    Ok(Ok(response)) => response,
                    Ok(Err(error)) => {
                        return Err(map_transport_failure(error.is_timeout(), error.is_connect()))
                    }
                    Err(_) => return Err(AppError::request_timeout()),
                }
            }
        };

        map_http_status(response.status())?;
        let body = read_bounded_response_body(response, deadline, &cancellation).await?;

        let (translation, usage) = parse_response(&body, request.selected_text.chars().count())?;
        Ok(ProviderResult {
            provider: self.provider_id(),
            model: self.model_metadata(),
            translation,
            usage,
        })
    }
}

fn map_transport_failure(is_timeout: bool, is_connect: bool) -> AppError {
    if is_timeout {
        AppError::request_timeout()
    } else {
        AppError::network_unavailable(is_connect)
    }
}

fn map_http_status(status: StatusCode) -> Result<(), AppError> {
    if status.is_success() {
        return Ok(());
    }
    match status.as_u16() {
        401 | 403 => Err(AppError::auth_invalid()),
        429 => Err(AppError::rate_limited()),
        _ => Err(AppError::provider_unavailable()),
    }
}

#[cfg(test)]
mod tests;
