//! Trusted desktop-shell boundary for Academic Translator.

pub mod commands;
pub mod document;
pub mod errors;
pub mod secrets;
pub mod translation;

pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .manage(document::sessions::DocumentSessionStore::default())
        .manage(secrets::KeyringSecretStore)
        .invoke_handler(tauri::generate_handler![
            commands::document::open_pdf_document,
            commands::document::read_pdf_bytes,
            commands::document::close_pdf_document,
            commands::settings::save_credential,
            commands::settings::delete_credential,
            commands::settings::credential_statuses,
        ])
        .run(tauri::generate_context!())
        .expect("failed to run Academic Translator desktop shell");
}
