//! Trusted desktop-shell boundary for Academic Translator.

use std::sync::Arc;

use tauri::Manager;

use crate::{
    cache::{CachePolicy, SqliteTranslationCache, TranslationCache},
    providers::{deepseek::DeepseekProvider, youdao::YoudaoProvider},
    secrets::{KeyringSecretStore, SecretStore},
    translation::{RequestRegistry, TranslationCoordinator, TranslationProvider},
};

pub mod cache;
pub mod commands;
pub mod document;
pub mod errors;
pub mod providers;
pub mod secrets;
pub mod translation;

pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .manage(document::sessions::DocumentSessionStore::default())
        .manage(secrets::KeyringSecretStore)
        .setup(|app| {
            let policy = CachePolicy::production();
            let cache = match app.path().app_data_dir() {
                Ok(cache_directory) => {
                    tauri::async_runtime::block_on(SqliteTranslationCache::open_or_unavailable(
                        cache_directory.join("translation-cache.sqlite3"),
                        policy,
                    ))
                }
                Err(_) => SqliteTranslationCache::unavailable(policy),
            };
            let requests = RequestRegistry::default();
            let secret_store: Arc<dyn SecretStore> = Arc::new(KeyringSecretStore);
            let providers: Vec<Arc<dyn TranslationProvider>> = vec![
                Arc::new(DeepseekProvider::new(Arc::clone(&secret_store))?),
                Arc::new(YoudaoProvider::new(secret_store)?),
            ];
            let coordinator = TranslationCoordinator::new(
                providers,
                Arc::new(cache.clone()) as Arc<dyn TranslationCache>,
                requests.clone(),
            );

            app.manage(cache);
            app.manage(requests);
            app.manage(coordinator);
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            commands::document::open_pdf_document,
            commands::document::read_pdf_bytes,
            commands::document::close_pdf_document,
            commands::settings::save_credential,
            commands::settings::delete_credential,
            commands::settings::credential_statuses,
            commands::translation::start_translation,
            commands::translation::cancel_translation,
            commands::translation::cache_stats,
            commands::translation::clear_cache,
        ])
        .run(tauri::generate_context!())
        .expect("failed to run Academic Translator desktop shell");
}
