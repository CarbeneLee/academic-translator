use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::RwLock;

use serde::Serialize;
use uuid::Uuid;

use crate::errors::CommandError;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DocumentDescriptor {
    pub document_session_id: Uuid,
    pub file_name: String,
    pub byte_len: u64,
}

#[derive(Default)]
pub struct DocumentSessionStore {
    paths: RwLock<HashMap<Uuid, PathBuf>>,
}

impl DocumentSessionStore {
    pub fn register(
        &self,
        path: PathBuf,
        byte_len: u64,
    ) -> Result<DocumentDescriptor, CommandError> {
        let file_name = path
            .file_name()
            .and_then(|name| name.to_str())
            .filter(|name| !name.is_empty())
            .ok_or_else(CommandError::invalid_pdf)?
            .to_owned();
        let document_session_id = Uuid::new_v4();

        self.paths
            .write()
            .map_err(|_| CommandError::document_unavailable())?
            .insert(document_session_id, path);

        Ok(DocumentDescriptor {
            document_session_id,
            file_name,
            byte_len,
        })
    }

    pub fn path_for(&self, document_session_id: Uuid) -> Option<PathBuf> {
        self.paths.read().ok()?.get(&document_session_id).cloned()
    }

    pub fn close(&self, document_session_id: Uuid) {
        if let Ok(mut paths) = self.paths.write() {
            paths.remove(&document_session_id);
        }
    }
}
