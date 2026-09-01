use std::{collections::HashMap, sync::Arc};

use crate::{
    cache::{CacheLookup, CacheRecord, CachedTranslation, TranslationCache},
    document::sessions::DocumentSessionStore,
    errors::{AppError, TranslationDomainError},
};

use super::{
    cache_key, prepare_translation, source_text_hash, DiagnosticCode, ModelMetadata, ProviderId,
    ProviderRequest, ProviderResult, RequestRegistry, TokenUsage, TranslationProvider,
    TranslationRequestDto, TranslationResultDto, NORMALIZATION_VERSION, SOURCE_LANGUAGE,
    TARGET_LANGUAGE,
};

const MAX_TRANSLATION_CHARACTERS: usize = 12_000;

pub struct TranslationCoordinator {
    providers: HashMap<ProviderId, Arc<dyn TranslationProvider>>,
    cache: Arc<dyn TranslationCache>,
    requests: RequestRegistry,
}

impl TranslationCoordinator {
    pub fn new(
        providers: Vec<Arc<dyn TranslationProvider>>,
        cache: Arc<dyn TranslationCache>,
        requests: RequestRegistry,
    ) -> Self {
        let providers = providers
            .into_iter()
            .map(|provider| (provider.provider_id(), provider))
            .collect();
        Self {
            providers,
            cache,
            requests,
        }
    }

    pub async fn translate(
        &self,
        request: TranslationRequestDto,
        sessions: &DocumentSessionStore,
    ) -> Result<TranslationResultDto, AppError> {
        if sessions.path_for(request.document_session_id).is_none() {
            return Err(AppError::request_cancelled());
        }

        let prepared = prepare_translation(&request.fragments).map_err(map_domain_error)?;
        let provider = self
            .providers
            .get(&request.provider)
            .ok_or_else(AppError::provider_unavailable)?;
        let metadata = provider.model_metadata();
        let mut diagnostics = Vec::new();
        let source_hash = source_text_hash(&prepared.normalized_text);
        let key = match cache_key(&prepared.normalized_text, request.provider, &metadata) {
            Ok(key) => Some(key),
            Err(_) => {
                push_cache_diagnostic(&mut diagnostics);
                None
            }
        };
        let registration = self.requests.register(request.request_id);
        let cancellation = registration.token();

        if let Some(key) = &key {
            let lookup = CacheLookup {
                cache_key: key.clone(),
                source_text_hash: source_hash.clone(),
                source_language: SOURCE_LANGUAGE.to_owned(),
                target_language: TARGET_LANGUAGE.to_owned(),
                provider: request.provider,
                model_id: metadata.model_id.clone(),
                model_revision: metadata.model_revision.clone(),
                prompt_version: metadata.prompt_version.clone(),
                normalization_version: NORMALIZATION_VERSION.to_owned(),
            };
            let cached = self.cache.get(&lookup).await;
            ensure_not_cancelled(&cancellation)?;
            match cached {
                Ok(Some(cached)) if valid_cached_result(&cached, request.provider, &metadata) => {
                    ensure_not_cancelled(&cancellation)?;
                    return Ok(TranslationResultDto {
                        request_id: request.request_id,
                        document_session_id: request.document_session_id,
                        provider: request.provider,
                        model_id: metadata.model_id,
                        normalized_source: prepared.normalized_text,
                        translation: cached.translation,
                        cache_hit: true,
                        usage: cached.usage,
                        diagnostics,
                    });
                }
                Ok(Some(_)) | Err(_) => push_cache_diagnostic(&mut diagnostics),
                Ok(None) => {}
            }
        }

        let mut translations = Vec::with_capacity(prepared.chunks.len());
        let mut usage = TokenUsage {
            input_tokens: Some(0),
            output_tokens: Some(0),
        };

        for chunk in &prepared.chunks {
            ensure_not_cancelled(&cancellation)?;
            let provider_result = translate_with_single_retry(
                provider.as_ref(),
                ProviderRequest {
                    selected_text: chunk.text.clone(),
                    source_language: SOURCE_LANGUAGE,
                    target_language: TARGET_LANGUAGE,
                    mode: prepared.mode,
                    max_output_tokens: chunk.max_output_tokens,
                },
                cancellation.clone(),
            )
            .await?;
            ensure_not_cancelled(&cancellation)?;
            validate_provider_result(&provider_result, request.provider, &metadata)?;
            accumulate_usage(&mut usage.input_tokens, provider_result.usage.input_tokens)?;
            accumulate_usage(
                &mut usage.output_tokens,
                provider_result.usage.output_tokens,
            )?;
            translations.push(provider_result.translation);
        }

        ensure_not_cancelled(&cancellation)?;
        let translation = translations.join("\n\n");
        if translation.trim().is_empty() || translation.chars().count() > MAX_TRANSLATION_CHARACTERS
        {
            return Err(AppError::malformed_response());
        }

        if let Some(key) = key {
            let record = CacheRecord {
                cache_key: key,
                source_text_hash: source_hash,
                source_language: SOURCE_LANGUAGE.to_owned(),
                target_language: TARGET_LANGUAGE.to_owned(),
                provider: request.provider,
                model_id: metadata.model_id.clone(),
                model_revision: metadata.model_revision.clone(),
                prompt_version: metadata.prompt_version.clone(),
                normalization_version: NORMALIZATION_VERSION.to_owned(),
                translation: translation.clone(),
                usage: usage.clone(),
            };
            if self.cache.put(record).await.is_err() {
                push_cache_diagnostic(&mut diagnostics);
            }
        }

        Ok(TranslationResultDto {
            request_id: request.request_id,
            document_session_id: request.document_session_id,
            provider: request.provider,
            model_id: metadata.model_id,
            normalized_source: prepared.normalized_text,
            translation,
            cache_hit: false,
            usage,
            diagnostics,
        })
    }
}

async fn translate_with_single_retry(
    provider: &dyn TranslationProvider,
    request: ProviderRequest,
    cancellation: tokio_util::sync::CancellationToken,
) -> Result<ProviderResult, AppError> {
    let first = provider
        .translate(request.clone(), cancellation.clone())
        .await;
    match first {
        Ok(result) => Ok(result),
        Err(error) => {
            ensure_not_cancelled(&cancellation)?;
            if !error.is_connection_before_send() {
                return Err(error);
            }
            ensure_not_cancelled(&cancellation)?;
            let retried = provider.translate(request, cancellation.clone()).await;
            ensure_not_cancelled(&cancellation)?;
            retried
        }
    }
}

fn ensure_not_cancelled(
    cancellation: &tokio_util::sync::CancellationToken,
) -> Result<(), AppError> {
    if cancellation.is_cancelled() {
        Err(AppError::request_cancelled())
    } else {
        Ok(())
    }
}

fn validate_provider_result(
    result: &ProviderResult,
    provider: ProviderId,
    metadata: &ModelMetadata,
) -> Result<(), AppError> {
    let valid = result.provider == provider
        && result.model == *metadata
        && !result.translation.trim().is_empty()
        && result.translation.chars().count() <= MAX_TRANSLATION_CHARACTERS;
    if valid {
        Ok(())
    } else {
        Err(AppError::malformed_response())
    }
}

fn valid_cached_result(
    cached: &CachedTranslation,
    provider: ProviderId,
    metadata: &ModelMetadata,
) -> bool {
    cached.provider == provider
        && cached.model_id == metadata.model_id
        && cached.model_revision == metadata.model_revision
        && cached.prompt_version == metadata.prompt_version
        && cached.normalization_version == NORMALIZATION_VERSION
        && !cached.translation.trim().is_empty()
        && cached.translation.chars().count() <= MAX_TRANSLATION_CHARACTERS
}

fn accumulate_usage(total: &mut Option<u64>, next: Option<u64>) -> Result<(), AppError> {
    *total = match (*total, next) {
        (Some(total), Some(next)) => Some(
            total
                .checked_add(next)
                .ok_or_else(AppError::malformed_response)?,
        ),
        _ => None,
    };
    Ok(())
}

fn push_cache_diagnostic(diagnostics: &mut Vec<DiagnosticCode>) {
    if !diagnostics.contains(&DiagnosticCode::CacheUnavailable) {
        diagnostics.push(DiagnosticCode::CacheUnavailable);
    }
}

fn map_domain_error(error: TranslationDomainError) -> AppError {
    match error {
        TranslationDomainError::SelectionEmpty => AppError::selection_empty(),
        TranslationDomainError::SelectionTooLarge => AppError::selection_too_large(),
        TranslationDomainError::CacheKeySerialization(_) => AppError::cache_unavailable(),
    }
}
