//! Trusted desktop-shell boundary for Academic Translator.

pub mod commands;
pub mod document;
pub mod errors;

pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .manage(document::sessions::DocumentSessionStore::default())
        .invoke_handler(tauri::generate_handler![
            commands::document::open_pdf_document,
            commands::document::read_pdf_bytes,
            commands::document::close_pdf_document,
        ])
        .run(tauri::generate_context!())
        .expect("failed to run Academic Translator desktop shell");
}
