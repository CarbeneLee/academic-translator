use serde::Serialize;
use thiserror::Error;

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
#[serde(rename_all = "camelCase")]
pub struct CommandError {
    code: &'static str,
    message: &'static str,
}

impl CommandError {
    pub const fn invalid_pdf() -> Self {
        Self {
            code: "INVALID_PDF_DOCUMENT",
            message: "请选择有效的 PDF 文件。",
        }
    }

    pub const fn document_unavailable() -> Self {
        Self {
            code: "DOCUMENT_UNAVAILABLE",
            message: "PDF 文档不可用，请重新打开。",
        }
    }

    pub const fn document_read_failed() -> Self {
        Self {
            code: "DOCUMENT_READ_FAILED",
            message: "无法读取 PDF 文档。",
        }
    }
}
