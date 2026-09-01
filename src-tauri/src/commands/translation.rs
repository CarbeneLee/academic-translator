use tauri::State;
use uuid::Uuid;

use crate::{
    cache::{CacheStats, SqliteTranslationCache, TranslationCache},
    document::sessions::DocumentSessionStore,
    errors::CommandError,
    translation::{
        RequestRegistry, TranslationCoordinator, TranslationRequestDto, TranslationResultDto,
    },
};

#[tauri::command]
pub async fn start_translation(
    request: TranslationRequestDto,
    coordinator: State<'_, TranslationCoordinator>,
    sessions: State<'_, DocumentSessionStore>,
) -> Result<TranslationResultDto, CommandError> {
    coordinator
        .translate(request, sessions.inner())
        .await
        .map_err(CommandError::translation)
}

#[tauri::command]
pub async fn cancel_translation(
    request_id: Uuid,
    requests: State<'_, RequestRegistry>,
) -> Result<(), CommandError> {
    requests.cancel(request_id);
    Ok(())
}

#[tauri::command]
pub async fn cache_stats(
    cache: State<'_, SqliteTranslationCache>,
) -> Result<CacheStats, CommandError> {
    cache.stats().await.map_err(CommandError::translation)
}

#[tauri::command]
pub async fn clear_cache(cache: State<'_, SqliteTranslationCache>) -> Result<(), CommandError> {
    cache.clear().await.map_err(CommandError::translation)
}
