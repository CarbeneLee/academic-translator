use std::path::Path;

use tauri::{AppHandle, State};
use tauri_plugin_dialog::DialogExt;
use uuid::Uuid;

use crate::document::sessions::{DocumentDescriptor, DocumentSessionStore};
use crate::errors::CommandError;

fn has_pdf_extension(path: &Path) -> bool {
    path.extension()
        .and_then(|extension| extension.to_str())
        .is_some_and(|extension| extension.eq_ignore_ascii_case("pdf"))
}

#[tauri::command]
pub async fn open_pdf_document(
    app: AppHandle,
    sessions: State<'_, DocumentSessionStore>,
) -> Result<Option<DocumentDescriptor>, CommandError> {
    let (sender, receiver) = tokio::sync::oneshot::channel();
    app.dialog()
        .file()
        .add_filter("PDF documents", &["pdf"])
        .pick_file(move |selected| {
            let _ = sender.send(selected);
        });

    let Some(selected) = receiver
        .await
        .map_err(|_| CommandError::document_read_failed())?
    else {
        return Ok(None);
    };
    let selected_path = selected
        .into_path()
        .map_err(|_| CommandError::invalid_pdf())?;
    if !has_pdf_extension(&selected_path) {
        return Err(CommandError::invalid_pdf());
    }

    let canonical_path = tokio::fs::canonicalize(&selected_path)
        .await
        .map_err(|_| CommandError::document_read_failed())?;
    if !has_pdf_extension(&canonical_path) {
        return Err(CommandError::invalid_pdf());
    }

    let metadata = tokio::fs::metadata(&canonical_path)
        .await
        .map_err(|_| CommandError::document_read_failed())?;
    if !metadata.is_file() {
        return Err(CommandError::invalid_pdf());
    }

    sessions.register(canonical_path, metadata.len()).map(Some)
}

#[tauri::command]
pub async fn read_pdf_bytes(
    document_session_id: Uuid,
    sessions: State<'_, DocumentSessionStore>,
) -> Result<tauri::ipc::Response, CommandError> {
    let path = sessions
        .path_for(document_session_id)
        .ok_or_else(CommandError::document_unavailable)?;
    let bytes = tokio::fs::read(path)
        .await
        .map_err(|_| CommandError::document_read_failed())?;

    Ok(tauri::ipc::Response::new(bytes))
}

#[tauri::command]
pub async fn close_pdf_document(
    document_session_id: Uuid,
    sessions: State<'_, DocumentSessionStore>,
) -> Result<(), CommandError> {
    sessions.close(document_session_id);
    Ok(())
}

#[cfg(test)]
mod tests {
    use std::path::Path;

    use super::has_pdf_extension;

    #[test]
    fn pdf_extension_check_is_case_insensitive() {
        assert!(has_pdf_extension(Path::new("paper.PDF")));
        assert!(!has_pdf_extension(Path::new("paper.txt")));
    }
}
