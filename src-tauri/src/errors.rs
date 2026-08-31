use serde::Serialize;

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
