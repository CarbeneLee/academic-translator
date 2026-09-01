use serde::Serialize;
use thiserror::Error;

#[derive(Debug, Error)]
pub enum AppError {
    #[error("credential value is invalid")]
    CredentialValueInvalid,
    #[error("credential store is unavailable")]
    CredentialStoreUnavailable,
    #[error("credentials are missing")]
    CredentialsMissing,
    #[error("provider authentication failed")]
    AuthInvalid,
    #[error("selection is empty")]
    SelectionEmpty,
    #[error("selection exceeds the provider character limit")]
    SelectionTooLarge,
    #[error("provider rate limit reached")]
    RateLimited,
    #[error("network is unavailable")]
    NetworkUnavailable { connection_before_send: bool },
    #[error("provider request timed out")]
    RequestTimeout,
    #[error("provider request was cancelled")]
    RequestCancelled,
    #[error("provider is unavailable")]
    ProviderUnavailable,
    #[error("provider returned a malformed response")]
    MalformedResponse,
    #[error("translation cache is unavailable")]
    CacheUnavailable,
}

impl AppError {
    pub const fn credential_value_invalid() -> Self {
        Self::CredentialValueInvalid
    }

    pub const fn credential_store_unavailable() -> Self {
        Self::CredentialStoreUnavailable
    }

    pub const fn credentials_missing() -> Self {
        Self::CredentialsMissing
    }

    pub const fn auth_invalid() -> Self {
        Self::AuthInvalid
    }

    pub const fn selection_empty() -> Self {
        Self::SelectionEmpty
    }

    pub const fn selection_too_large() -> Self {
        Self::SelectionTooLarge
    }

    pub const fn rate_limited() -> Self {
        Self::RateLimited
    }

    pub const fn network_unavailable(connection_before_send: bool) -> Self {
        Self::NetworkUnavailable {
            connection_before_send,
        }
    }

    pub const fn request_timeout() -> Self {
        Self::RequestTimeout
    }

    pub const fn request_cancelled() -> Self {
        Self::RequestCancelled
    }

    pub const fn provider_unavailable() -> Self {
        Self::ProviderUnavailable
    }

    pub const fn malformed_response() -> Self {
        Self::MalformedResponse
    }

    pub const fn cache_unavailable() -> Self {
        Self::CacheUnavailable
    }

    pub const fn code(&self) -> &'static str {
        match self {
            Self::CredentialValueInvalid => "CREDENTIAL_VALUE_INVALID",
            Self::CredentialStoreUnavailable => "CREDENTIAL_STORE_UNAVAILABLE",
            Self::CredentialsMissing => "CREDENTIALS_MISSING",
            Self::AuthInvalid => "AUTH_INVALID",
            Self::SelectionEmpty => "SELECTION_EMPTY",
            Self::SelectionTooLarge => "SELECTION_TOO_LARGE",
            Self::RateLimited => "RATE_LIMITED",
            Self::NetworkUnavailable { .. } => "NETWORK_UNAVAILABLE",
            Self::RequestTimeout => "REQUEST_TIMEOUT",
            Self::RequestCancelled => "REQUEST_CANCELLED",
            Self::ProviderUnavailable => "PROVIDER_UNAVAILABLE",
            Self::MalformedResponse => "MALFORMED_RESPONSE",
            Self::CacheUnavailable => "CACHE_UNAVAILABLE",
        }
    }

    pub const fn is_connection_before_send(&self) -> bool {
        matches!(
            self,
            Self::NetworkUnavailable {
                connection_before_send: true
            }
        )
    }
}

#[derive(Debug, Error)]
pub enum TranslationDomainError {
    #[error("selection is empty")]
    SelectionEmpty,
    #[error("selection exceeds the local character limit")]
    SelectionTooLarge,
    #[error("cache identity could not be serialized")]
    CacheKeySerialization(#[from] serde_json::Error),
}

impl TranslationDomainError {
    pub const fn code(&self) -> &'static str {
        match self {
            Self::SelectionEmpty => "SELECTION_EMPTY",
            Self::SelectionTooLarge => "SELECTION_TOO_LARGE",
            Self::CacheKeySerialization(_) => "CACHE_UNAVAILABLE",
        }
    }
}

#[derive(Debug, Serialize)]
#[serde(untagged)]
pub enum CommandError {
    Legacy {
        code: &'static str,
        message: &'static str,
    },
    Translation {
        code: &'static str,
        retryable: bool,
    },
}

impl CommandError {
    pub const fn invalid_pdf() -> Self {
        Self::Legacy {
            code: "INVALID_PDF_DOCUMENT",
            message: "请选择有效的 PDF 文件。",
        }
    }

    pub const fn document_unavailable() -> Self {
        Self::Legacy {
            code: "DOCUMENT_UNAVAILABLE",
            message: "PDF 文档不可用，请重新打开。",
        }
    }

    pub const fn document_read_failed() -> Self {
        Self::Legacy {
            code: "DOCUMENT_READ_FAILED",
            message: "无法读取 PDF 文档。",
        }
    }

    pub const fn translation(error: AppError) -> Self {
        let (code, retryable) = match error {
            AppError::CredentialValueInvalid | AppError::CredentialsMissing => {
                ("CREDENTIALS_MISSING", false)
            }
            AppError::CredentialStoreUnavailable => ("PROVIDER_UNAVAILABLE", true),
            AppError::AuthInvalid => ("AUTH_INVALID", false),
            AppError::SelectionEmpty => ("SELECTION_EMPTY", false),
            AppError::SelectionTooLarge => ("SELECTION_TOO_LARGE", false),
            AppError::RateLimited => ("RATE_LIMITED", true),
            AppError::NetworkUnavailable { .. } => ("NETWORK_UNAVAILABLE", true),
            AppError::RequestTimeout => ("REQUEST_TIMEOUT", true),
            AppError::RequestCancelled => ("REQUEST_CANCELLED", false),
            AppError::ProviderUnavailable => ("PROVIDER_UNAVAILABLE", true),
            AppError::MalformedResponse => ("MALFORMED_RESPONSE", true),
            AppError::CacheUnavailable => ("CACHE_UNAVAILABLE", true),
        };
        Self::Translation { code, retryable }
    }
}

impl From<AppError> for CommandError {
    fn from(error: AppError) -> Self {
        match error {
            AppError::CredentialValueInvalid => Self::Legacy {
                code: "CREDENTIAL_VALUE_INVALID",
                message: "凭据不能为空。",
            },
            AppError::CredentialStoreUnavailable => Self::Legacy {
                code: "CREDENTIAL_STORE_UNAVAILABLE",
                message: "无法访问系统凭据存储，请稍后重试。",
            },
            AppError::CredentialsMissing => Self::Legacy {
                code: "CREDENTIALS_MISSING",
                message: "请先在设置中填写当前翻译服务的凭据。",
            },
            AppError::AuthInvalid => Self::Legacy {
                code: "AUTH_INVALID",
                message: "凭据无效，请在设置中重新填写。",
            },
            AppError::SelectionEmpty => Self::Legacy {
                code: "SELECTION_EMPTY",
                message: "请先选择需要翻译的英文。",
            },
            AppError::SelectionTooLarge => Self::Legacy {
                code: "SELECTION_TOO_LARGE",
                message: "选中内容过长，请减少选区后重试。",
            },
            AppError::RateLimited => Self::Legacy {
                code: "RATE_LIMITED",
                message: "请求过于频繁，请稍后重试。",
            },
            AppError::NetworkUnavailable { .. } => Self::Legacy {
                code: "NETWORK_UNAVAILABLE",
                message: "网络不可用，请检查连接后重试。",
            },
            AppError::RequestTimeout => Self::Legacy {
                code: "REQUEST_TIMEOUT",
                message: "翻译请求超时，请手动重试。",
            },
            AppError::RequestCancelled => Self::Legacy {
                code: "REQUEST_CANCELLED",
                message: "翻译请求已取消。",
            },
            AppError::ProviderUnavailable => Self::Legacy {
                code: "PROVIDER_UNAVAILABLE",
                message: "翻译服务暂时不可用，请稍后重试或切换服务。",
            },
            AppError::MalformedResponse => Self::Legacy {
                code: "MALFORMED_RESPONSE",
                message: "翻译服务返回了无效格式，请重试或切换服务。",
            },
            AppError::CacheUnavailable => Self::Legacy {
                code: "CACHE_UNAVAILABLE",
                message: "本地翻译缓存暂时不可用。",
            },
        }
    }
}
