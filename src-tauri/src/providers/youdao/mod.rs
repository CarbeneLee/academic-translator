mod response;
mod signing;

use std::{
    sync::Arc,
    time::{Duration, SystemTime, UNIX_EPOCH},
};

use async_trait::async_trait;
use reqwest::StatusCode;
use serde::Serialize;
use tokio::time::Instant;
use tokio_util::sync::CancellationToken;
use uuid::Uuid;

use crate::{
    errors::AppError,
    secrets::{CredentialKind, SecretStore},
    translation::{
        ModelMetadata, ProviderId, ProviderRequest, ProviderResult, TokenUsage, TranslationProvider,
    },
};

use self::{response::parse_response, signing::sign_v3};

pub const YOUDAO_TRANSLATION_URL: &str = "https://openapi.youdao.com/api";
pub const YOUDAO_MODEL_ID: &str = "youdao-text-translation";
pub const YOUDAO_MODEL_REVISION: &str = "youdao-text-v3";
pub const YOUDAO_PROMPT_VERSION: &str = "youdao-direct-v1";

const CONNECT_TIMEOUT: Duration = Duration::from_secs(5);
const TOTAL_TIMEOUT: Duration = Duration::from_secs(20);
const MAXIMUM_REQUEST_CHARACTERS: usize = 4_000;

enum Endpoint {
    Production,
    #[cfg(test)]
    Test(String),
}

impl Endpoint {
    fn as_str(&self) -> &str {
        match self {
            Self::Production => YOUDAO_TRANSLATION_URL,
            #[cfg(test)]
            Self::Test(endpoint) => endpoint,
        }
    }
}

#[derive(Serialize)]
struct YoudaoForm {
    q: String,
    from: &'static str,
    to: &'static str,
    #[serde(rename = "appKey")]
    app_key: String,
    salt: String,
    sign: String,
    #[serde(rename = "signType")]
    sign_type: &'static str,
    curtime: String,
    strict: &'static str,
}

pub struct YoudaoProvider {
    client: reqwest::Client,
    secret_store: Arc<dyn SecretStore>,
    endpoint: Endpoint,
    total_timeout: Duration,
    #[cfg(test)]
    fixed_request_metadata: Option<(String, String)>,
}

impl YoudaoProvider {
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
            #[cfg(test)]
            fixed_request_metadata: None,
        })
    }

    #[cfg(test)]
    fn for_test(
        secret_store: Arc<dyn SecretStore>,
        endpoint: String,
        total_timeout: Duration,
        fixed_request_metadata: Option<(String, String)>,
    ) -> Result<Self, AppError> {
        let mut provider =
            Self::with_endpoint(secret_store, Endpoint::Test(endpoint), total_timeout)?;
        provider.fixed_request_metadata = fixed_request_metadata;
        Ok(provider)
    }

    fn request_metadata(&self) -> Result<(String, String), AppError> {
        #[cfg(test)]
        if let Some(metadata) = &self.fixed_request_metadata {
            return Ok(metadata.clone());
        }

        let current_time = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map_err(|_| AppError::provider_unavailable())?
            .as_secs()
            .to_string();
        Ok((Uuid::new_v4().to_string(), current_time))
    }
}

#[async_trait]
impl TranslationProvider for YoudaoProvider {
    fn provider_id(&self) -> ProviderId {
        ProviderId::Youdao
    }

    fn model_metadata(&self) -> ModelMetadata {
        ModelMetadata {
            model_id: YOUDAO_MODEL_ID.to_owned(),
            model_revision: YOUDAO_MODEL_REVISION.to_owned(),
            prompt_version: YOUDAO_PROMPT_VERSION.to_owned(),
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

        let app_id = self
            .secret_store
            .get(CredentialKind::YoudaoAppId)
            .await?
            .ok_or_else(AppError::credentials_missing)?;
        let app_secret = self
            .secret_store
            .get(CredentialKind::YoudaoAppSecret)
            .await?
            .ok_or_else(AppError::credentials_missing)?;
        let (salt, current_time) = self.request_metadata()?;
        let signature = sign_v3(
            app_id.expose_secret(),
            &request.selected_text,
            &salt,
            &current_time,
            app_secret.expose_secret(),
        );
        let form = YoudaoForm {
            q: request.selected_text,
            from: "en",
            to: "zh-CHS",
            app_key: app_id.expose_secret().to_owned(),
            sign: signature,
            salt,
            sign_type: "v3",
            curtime: current_time,
            strict: "true",
        };
        drop(app_id);
        drop(app_secret);

        let outbound = self.client.post(self.endpoint.as_str()).form(&form);
        let deadline = Instant::now() + self.total_timeout;
        let response = tokio::select! {
            biased;
            _ = cancellation.cancelled() => return Err(AppError::request_cancelled()),
            result = tokio::time::timeout_at(deadline, outbound.send()) => {
                match result {
                    Ok(Ok(response)) => response,
                    Ok(Err(error)) if error.is_timeout() => return Err(AppError::request_timeout()),
                    Ok(Err(error)) => return Err(AppError::network_unavailable(error.is_connect())),
                    Err(_) => return Err(AppError::request_timeout()),
                }
            }
        };

        map_http_status(response.status())?;
        let body = tokio::select! {
            biased;
            _ = cancellation.cancelled() => return Err(AppError::request_cancelled()),
            result = tokio::time::timeout_at(deadline, response.bytes()) => {
                match result {
                    Ok(Ok(body)) => body,
                    Ok(Err(error)) if error.is_timeout() => return Err(AppError::request_timeout()),
                    Ok(Err(_)) => return Err(AppError::network_unavailable(false)),
                    Err(_) => return Err(AppError::request_timeout()),
                }
            }
        };

        Ok(ProviderResult {
            provider: self.provider_id(),
            model: self.model_metadata(),
            translation: parse_response(&body)?,
            usage: TokenUsage::default(),
        })
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
