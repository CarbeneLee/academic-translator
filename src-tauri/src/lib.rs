//! Trusted desktop-shell boundary for Academic Translator.

pub fn run() {
    tauri::Builder::default()
        .run(tauri::generate_context!())
        .expect("failed to run Academic Translator desktop shell");
}
