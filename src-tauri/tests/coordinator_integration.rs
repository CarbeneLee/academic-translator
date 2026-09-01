use std::{
    collections::{HashMap, VecDeque},
    path::PathBuf,
    sync::{
        atomic::{AtomicUsize, Ordering},
        Arc, Mutex,
    },
    time::Duration,
};

use academic_translator_lib::{
    cache::{
        CacheLookup, CachePolicy, CacheRecord, CacheStats, CachedTranslation,
        SqliteTranslationCache, TranslationCache,
    },
    document::sessions::DocumentSessionStore,
    errors::{AppError, CommandError},
    providers::deepseek::{DEEPSEEK_MODEL_ID, DEEPSEEK_MODEL_REVISION, PROMPT_VERSION},
    translation::{
        cache_key, prepare_translation, DiagnosticCode, ModelMetadata, ProviderId, ProviderRequest,
        ProviderResult, RequestRegistry, SelectedFragmentInput, TokenUsage, TranslationCoordinator,
        TranslationProvider, TranslationRequestDto, TranslationResultDto, NORMALIZATION_VERSION,
    },
};
use async_trait::async_trait;
use tokio::sync::Semaphore;
use tokio_util::sync::CancellationToken;
use uuid::Uuid;

fn deepseek_metadata() -> ModelMetadata {
    ModelMetadata {
        model_id: DEEPSEEK_MODEL_ID.to_owned(),
        model_revision: DEEPSEEK_MODEL_REVISION.to_owned(),
        prompt_version: PROMPT_VERSION.to_owned(),
    }
}

fn live_session() -> (DocumentSessionStore, Uuid) {
    let sessions = DocumentSessionStore::default();
    let descriptor = sessions
        .register(PathBuf::from("paper.pdf"), 42)
        .expect("test session registers");
    (sessions, descriptor.document_session_id)
}

fn request(
    request_id: Uuid,
    document_session_id: Uuid,
    source: impl Into<String>,
) -> TranslationRequestDto {
    TranslationRequestDto {
        request_id,
        document_session_id,
        provider: ProviderId::Deepseek,
        fragments: vec![SelectedFragmentInput {
            id: "fragment-0".to_owned(),
            order: 0,
            text: source.into(),
        }],
    }
}

enum ProviderStep {
    Success {
        translation: String,
        usage: TokenUsage,
    },
    Result(ProviderResult),
    Error(AppError),
    CancelThenSuccess {
        translation: String,
        usage: TokenUsage,
    },
    CancelThenError(AppError),
    WaitForCancellation,
}

struct ConcurrencyGuard<'a> {
    active: &'a AtomicUsize,
}

impl Drop for ConcurrencyGuard<'_> {
    fn drop(&mut self) {
        self.active.fetch_sub(1, Ordering::SeqCst);
    }
}

#[derive(Clone)]
struct BoundedProvider {
    inner: Arc<ProviderState>,
}

struct ProviderState {
    steps: Mutex<VecDeque<ProviderStep>>,
    calls: Mutex<Vec<ProviderRequest>>,
    maximum_calls: usize,
    active: AtomicUsize,
    maximum_concurrency: AtomicUsize,
    arrivals: Semaphore,
}

impl BoundedProvider {
    fn new(steps: Vec<ProviderStep>) -> Self {
        let maximum_calls = steps.len();
        Self {
            inner: Arc::new(ProviderState {
                steps: Mutex::new(steps.into()),
                calls: Mutex::new(Vec::new()),
                maximum_calls,
                active: AtomicUsize::new(0),
                maximum_concurrency: AtomicUsize::new(0),
                arrivals: Semaphore::new(0),
            }),
        }
    }

    fn no_calls_allowed() -> Self {
        Self::new(Vec::new())
    }

    async fn wait_for_arrivals(&self, count: u32) {
        tokio::time::timeout(
            Duration::from_secs(1),
            self.inner.arrivals.acquire_many(count),
        )
        .await
        .expect("bounded provider call arrives before timeout")
        .expect("provider arrival semaphore remains open")
        .forget();
    }

    fn call_count(&self) -> usize {
        self.inner.calls.lock().unwrap().len()
    }

    fn seen_requests(&self) -> Vec<ProviderRequest> {
        self.inner.calls.lock().unwrap().clone()
    }

    fn max_concurrency(&self) -> usize {
        self.inner.maximum_concurrency.load(Ordering::SeqCst)
    }

    fn assert_exhausted(&self) {
        assert_eq!(self.call_count(), self.inner.maximum_calls);
        assert!(self.inner.steps.lock().unwrap().is_empty());
    }
}

#[async_trait]
impl TranslationProvider for BoundedProvider {
    fn provider_id(&self) -> ProviderId {
        ProviderId::Deepseek
    }

    fn model_metadata(&self) -> ModelMetadata {
        deepseek_metadata()
    }

    async fn translate(
        &self,
        provider_request: ProviderRequest,
        cancellation: CancellationToken,
    ) -> Result<ProviderResult, AppError> {
        let step = {
            let mut steps = self.inner.steps.lock().unwrap();
            steps.pop_front().unwrap_or_else(|| {
                panic!(
                    "unexpected provider call beyond hard bound {}",
                    self.inner.maximum_calls
                )
            })
        };
        self.inner.calls.lock().unwrap().push(provider_request);
        self.inner.arrivals.add_permits(1);
        let active = self.inner.active.fetch_add(1, Ordering::SeqCst) + 1;
        self.inner
            .maximum_concurrency
            .fetch_max(active, Ordering::SeqCst);
        let _guard = ConcurrencyGuard {
            active: &self.inner.active,
        };

        match step {
            ProviderStep::Success { translation, usage } => Ok(ProviderResult {
                provider: ProviderId::Deepseek,
                model: deepseek_metadata(),
                translation,
                usage,
            }),
            ProviderStep::Result(result) => Ok(result),
            ProviderStep::Error(error) => Err(error),
            ProviderStep::CancelThenSuccess { translation, usage } => {
                cancellation.cancel();
                Ok(ProviderResult {
                    provider: ProviderId::Deepseek,
                    model: deepseek_metadata(),
                    translation,
                    usage,
                })
            }
            ProviderStep::CancelThenError(error) => {
                cancellation.cancel();
                Err(error)
            }
            ProviderStep::WaitForCancellation => {
                tokio::time::timeout(Duration::from_secs(1), cancellation.cancelled())
                    .await
                    .expect("coordinator cancels bounded provider call");
                Err(AppError::request_cancelled())
            }
        }
    }
}

#[derive(Clone)]
struct MemoryCache {
    inner: Arc<Mutex<MemoryCacheState>>,
}

struct MemoryCacheState {
    values: HashMap<String, CachedTranslation>,
    puts: Vec<CacheRecord>,
    get_calls: usize,
    put_calls: usize,
    maximum_get_calls: usize,
    maximum_put_calls: usize,
    fail_get: bool,
    fail_put: bool,
}

impl MemoryCache {
    fn bounded(maximum_get_calls: usize, maximum_put_calls: usize) -> Self {
        Self {
            inner: Arc::new(Mutex::new(MemoryCacheState {
                values: HashMap::new(),
                puts: Vec::new(),
                get_calls: 0,
                put_calls: 0,
                maximum_get_calls,
                maximum_put_calls,
                fail_get: false,
                fail_put: false,
            })),
        }
    }

    fn failing(maximum_get_calls: usize, maximum_put_calls: usize) -> Self {
        let cache = Self::bounded(maximum_get_calls, maximum_put_calls);
        {
            let mut state = cache.inner.lock().unwrap();
            state.fail_get = true;
            state.fail_put = true;
        }
        cache
    }

    fn seed(&self, key: String, value: CachedTranslation) {
        self.inner.lock().unwrap().values.insert(key, value);
    }

    fn put_records(&self) -> Vec<CacheRecord> {
        self.inner.lock().unwrap().puts.clone()
    }

    fn assert_calls(&self, gets: usize, puts: usize) {
        let state = self.inner.lock().unwrap();
        assert_eq!(state.get_calls, gets);
        assert_eq!(state.put_calls, puts);
        assert_eq!(gets, state.maximum_get_calls);
        assert_eq!(puts, state.maximum_put_calls);
    }
}

#[async_trait]
impl TranslationCache for MemoryCache {
    async fn get(&self, lookup: &CacheLookup) -> Result<Option<CachedTranslation>, AppError> {
        let mut state = self.inner.lock().unwrap();
        state.get_calls += 1;
        assert!(
            state.get_calls <= state.maximum_get_calls,
            "unexpected cache get beyond hard bound {}",
            state.maximum_get_calls
        );
        if state.fail_get {
            return Err(AppError::cache_unavailable());
        }
        Ok(state.values.get(&lookup.cache_key).cloned())
    }

    async fn put(&self, record: CacheRecord) -> Result<(), AppError> {
        let mut state = self.inner.lock().unwrap();
        state.put_calls += 1;
        assert!(
            state.put_calls <= state.maximum_put_calls,
            "unexpected cache put beyond hard bound {}",
            state.maximum_put_calls
        );
        if state.fail_put {
            return Err(AppError::cache_unavailable());
        }
        state.values.insert(
            record.cache_key.clone(),
            CachedTranslation {
                provider: record.provider,
                model_id: record.model_id.clone(),
                model_revision: record.model_revision.clone(),
                prompt_version: record.prompt_version.clone(),
                normalization_version: record.normalization_version.clone(),
                translation: record.translation.clone(),
                created_at: 0,
                last_accessed_at: 0,
                usage: record.usage.clone(),
            },
        );
        state.puts.push(record);
        Ok(())
    }

    async fn cleanup(&self) -> Result<CacheStats, AppError> {
        panic!("coordinator must not invoke cache cleanup directly")
    }

    async fn clear(&self) -> Result<(), AppError> {
        panic!("coordinator must not clear cache")
    }

    async fn stats(&self) -> Result<CacheStats, AppError> {
        panic!("coordinator must not request cache stats")
    }
}

#[derive(Clone)]
struct BlockingMissCache {
    inner: Arc<BlockingMissCacheState>,
}

struct BlockingMissCacheState {
    get_calls: AtomicUsize,
    put_calls: AtomicUsize,
    arrived: Semaphore,
    release: Semaphore,
}

impl BlockingMissCache {
    fn new() -> Self {
        Self {
            inner: Arc::new(BlockingMissCacheState {
                get_calls: AtomicUsize::new(0),
                put_calls: AtomicUsize::new(0),
                arrived: Semaphore::new(0),
                release: Semaphore::new(0),
            }),
        }
    }

    async fn wait_until_get(&self) {
        tokio::time::timeout(Duration::from_secs(1), self.inner.arrived.acquire())
            .await
            .expect("bounded cache get arrives")
            .expect("cache arrival semaphore remains open")
            .forget();
    }

    fn release_miss(&self) {
        self.inner.release.add_permits(1);
    }

    fn assert_calls(&self, gets: usize, puts: usize) {
        assert_eq!(self.inner.get_calls.load(Ordering::SeqCst), gets);
        assert_eq!(self.inner.put_calls.load(Ordering::SeqCst), puts);
    }
}

#[async_trait]
impl TranslationCache for BlockingMissCache {
    async fn get(&self, _lookup: &CacheLookup) -> Result<Option<CachedTranslation>, AppError> {
        let call = self.inner.get_calls.fetch_add(1, Ordering::SeqCst) + 1;
        assert_eq!(call, 1, "blocking cache get has a hard bound of one");
        self.inner.arrived.add_permits(1);
        tokio::time::timeout(Duration::from_secs(1), self.inner.release.acquire())
            .await
            .expect("test releases bounded cache get")
            .expect("cache release semaphore remains open")
            .forget();
        Ok(None)
    }

    async fn put(&self, _record: CacheRecord) -> Result<(), AppError> {
        self.inner.put_calls.fetch_add(1, Ordering::SeqCst);
        panic!("cancelled cache wait must never write")
    }

    async fn cleanup(&self) -> Result<CacheStats, AppError> {
        panic!("coordinator must not invoke cache cleanup directly")
    }

    async fn clear(&self) -> Result<(), AppError> {
        panic!("coordinator must not clear cache")
    }

    async fn stats(&self) -> Result<CacheStats, AppError> {
        panic!("coordinator must not request cache stats")
    }
}

fn coordinator(
    provider: BoundedProvider,
    cache: MemoryCache,
    requests: RequestRegistry,
) -> TranslationCoordinator {
    let provider: Arc<dyn TranslationProvider> = Arc::new(provider);
    let cache: Arc<dyn TranslationCache> = Arc::new(cache);
    TranslationCoordinator::new(vec![provider], cache, requests)
}

fn usage(input_tokens: Option<u64>, output_tokens: Option<u64>) -> TokenUsage {
    TokenUsage {
        input_tokens,
        output_tokens,
    }
}

#[tokio::test]
async fn translates_exactly_two_chunks_sequentially_and_caches_only_the_complete_result() {
    let source = "A complete academic sentence. ".repeat(170);
    let prepared = prepare_translation(&[SelectedFragmentInput {
        id: "precondition".to_owned(),
        order: 0,
        text: source.clone(),
    }])
    .unwrap();
    assert_eq!(
        prepared.chunks.len(),
        2,
        "fixture must create exactly two chunks"
    );
    let provider = BoundedProvider::new(vec![
        ProviderStep::Success {
            translation: "第一段".to_owned(),
            usage: usage(Some(10), Some(5)),
        },
        ProviderStep::Success {
            translation: "第二段".to_owned(),
            usage: usage(Some(20), Some(7)),
        },
    ]);
    let cache = MemoryCache::bounded(2, 1);
    let requests = RequestRegistry::default();
    let coordinator = coordinator(provider.clone(), cache.clone(), requests.clone());
    let (sessions, session_id) = live_session();

    let first = coordinator
        .translate(
            request(Uuid::new_v4(), session_id, source.clone()),
            &sessions,
        )
        .await
        .unwrap();

    assert_eq!(provider.max_concurrency(), 1);
    assert_eq!(
        provider
            .seen_requests()
            .iter()
            .map(|seen| seen.selected_text.clone())
            .collect::<Vec<_>>(),
        prepared
            .chunks
            .iter()
            .map(|chunk| chunk.text.clone())
            .collect::<Vec<_>>()
    );
    assert_eq!(first.translation, "第一段\n\n第二段");
    assert_eq!(first.normalized_source, prepared.normalized_text);
    assert_eq!(first.model_id, DEEPSEEK_MODEL_ID);
    assert_eq!(first.usage, usage(Some(30), Some(12)));
    assert!(!first.cache_hit);
    assert!(first.diagnostics.is_empty());
    let puts = cache.put_records();
    assert_eq!(puts.len(), 1);
    assert_eq!(puts[0].translation, "第一段\n\n第二段");

    let second_request_id = Uuid::new_v4();
    let second = coordinator
        .translate(request(second_request_id, session_id, source), &sessions)
        .await
        .unwrap();
    assert_eq!(second.request_id, second_request_id);
    assert!(second.cache_hit);
    assert_eq!(second.translation, "第一段\n\n第二段");
    assert!(requests.is_empty(), "cache-hit guard must be removed");
    provider.assert_exhausted();
    cache.assert_calls(2, 1);
}

#[tokio::test]
async fn a_failed_later_chunk_never_writes_a_partial_translation() {
    let source = "A complete academic sentence. ".repeat(170);
    let provider = BoundedProvider::new(vec![
        ProviderStep::Success {
            translation: "不得落盘的第一段".to_owned(),
            usage: usage(Some(10), Some(5)),
        },
        ProviderStep::Error(AppError::auth_invalid()),
    ]);
    let cache = MemoryCache::bounded(1, 0);
    let coordinator = coordinator(provider.clone(), cache.clone(), RequestRegistry::default());
    let (sessions, session_id) = live_session();

    let error = coordinator
        .translate(request(Uuid::new_v4(), session_id, source), &sessions)
        .await
        .unwrap_err();

    assert_eq!(error.code(), "AUTH_INVALID");
    provider.assert_exhausted();
    cache.assert_calls(1, 0);
}

#[tokio::test]
async fn cancellation_during_a_chunk_stops_remaining_calls_and_skips_cache_write() {
    let source = "A complete academic sentence. ".repeat(260);
    let prepared = prepare_translation(&[SelectedFragmentInput {
        id: "precondition".to_owned(),
        order: 0,
        text: source.clone(),
    }])
    .unwrap();
    assert_eq!(
        prepared.chunks.len(),
        3,
        "fixture must create exactly three chunks"
    );
    let provider = BoundedProvider::new(vec![ProviderStep::WaitForCancellation]);
    let cache = MemoryCache::bounded(1, 0);
    let requests = RequestRegistry::default();
    let coordinator = Arc::new(coordinator(
        provider.clone(),
        cache.clone(),
        requests.clone(),
    ));
    let (sessions, session_id) = live_session();
    let request_id = Uuid::new_v4();
    let task = {
        let coordinator = Arc::clone(&coordinator);
        tokio::spawn(async move {
            coordinator
                .translate(request(request_id, session_id, source), &sessions)
                .await
        })
    };
    provider.wait_for_arrivals(1).await;

    requests.cancel(request_id);
    requests.cancel(request_id);
    let error = tokio::time::timeout(Duration::from_secs(1), task)
        .await
        .expect("cancelled coordinator finishes")
        .expect("coordinator task does not panic")
        .unwrap_err();

    assert_eq!(error.code(), "REQUEST_CANCELLED");
    provider.assert_exhausted();
    cache.assert_calls(1, 0);
}

#[tokio::test]
async fn cancellation_during_a_blocking_cache_miss_stops_before_provider_and_write() {
    let provider = BoundedProvider::no_calls_allowed();
    let cache = BlockingMissCache::new();
    let requests = RequestRegistry::default();
    let coordinator = Arc::new(TranslationCoordinator::new(
        vec![Arc::new(provider.clone()) as Arc<dyn TranslationProvider>],
        Arc::new(cache.clone()) as Arc<dyn TranslationCache>,
        requests.clone(),
    ));
    let (sessions, session_id) = live_session();
    let request_id = Uuid::new_v4();
    let task = {
        let coordinator = Arc::clone(&coordinator);
        tokio::spawn(async move {
            coordinator
                .translate(
                    request(request_id, session_id, "blocking cache source"),
                    &sessions,
                )
                .await
        })
    };
    cache.wait_until_get().await;

    requests.cancel(request_id);
    cache.release_miss();
    let error = tokio::time::timeout(Duration::from_secs(1), task)
        .await
        .expect("cache-wait cancellation completes")
        .expect("coordinator task does not panic")
        .unwrap_err();

    assert_eq!(error.code(), "REQUEST_CANCELLED");
    assert_eq!(provider.call_count(), 0);
    cache.assert_calls(1, 0);
    assert!(requests.is_empty(), "cancelled cache guard must be removed");
}

#[tokio::test]
async fn same_uuid_cached_replacement_cancels_an_older_provider_request() {
    let provider = BoundedProvider::new(vec![ProviderStep::WaitForCancellation]);
    let cache = MemoryCache::bounded(2, 0);
    let requests = RequestRegistry::default();
    let coordinator = Arc::new(coordinator(
        provider.clone(),
        cache.clone(),
        requests.clone(),
    ));
    let (sessions, session_id) = live_session();
    let sessions = Arc::new(sessions);
    let request_id = Uuid::new_v4();
    let replacement_source = "cached replacement source";
    let metadata = deepseek_metadata();
    cache.seed(
        cache_key(replacement_source, ProviderId::Deepseek, &metadata).unwrap(),
        CachedTranslation {
            provider: ProviderId::Deepseek,
            model_id: metadata.model_id.clone(),
            model_revision: metadata.model_revision.clone(),
            prompt_version: metadata.prompt_version.clone(),
            normalization_version: NORMALIZATION_VERSION.to_owned(),
            translation: "缓存替换译文".to_owned(),
            created_at: 1,
            last_accessed_at: 1,
            usage: usage(Some(4), Some(2)),
        },
    );

    let mut older = {
        let coordinator = Arc::clone(&coordinator);
        let sessions = Arc::clone(&sessions);
        tokio::spawn(async move {
            coordinator
                .translate(
                    request(request_id, session_id, "older provider source"),
                    &sessions,
                )
                .await
        })
    };
    provider.wait_for_arrivals(1).await;

    let replacement = coordinator
        .translate(
            request(request_id, session_id, replacement_source),
            &sessions,
        )
        .await
        .unwrap();
    let older_error = match tokio::time::timeout(Duration::from_millis(200), &mut older).await {
        Ok(result) => result
            .expect("older request task does not panic")
            .unwrap_err(),
        Err(_) => {
            requests.cancel(request_id);
            let _ = tokio::time::timeout(Duration::from_secs(1), older).await;
            panic!("cached replacement did not cancel the older provider request")
        }
    };

    assert!(replacement.cache_hit);
    assert_eq!(replacement.translation, "缓存替换译文");
    assert_eq!(older_error.code(), "REQUEST_CANCELLED");
    provider.assert_exhausted();
    cache.assert_calls(2, 0);
    assert!(requests.is_empty(), "replacement guard must be removed");
}

#[tokio::test]
async fn cancellation_between_chunks_stops_before_the_next_provider_call() {
    let source = "A complete academic sentence. ".repeat(170);
    let provider = BoundedProvider::new(vec![ProviderStep::CancelThenSuccess {
        translation: "第一段完成时取消".to_owned(),
        usage: usage(Some(10), Some(5)),
    }]);
    let cache = MemoryCache::bounded(1, 0);
    let coordinator = coordinator(provider.clone(), cache.clone(), RequestRegistry::default());
    let (sessions, session_id) = live_session();

    let error = coordinator
        .translate(request(Uuid::new_v4(), session_id, source), &sessions)
        .await
        .unwrap_err();

    assert_eq!(error.code(), "REQUEST_CANCELLED");
    provider.assert_exhausted();
    cache.assert_calls(1, 0);
}

#[tokio::test]
async fn duplicate_request_id_cancels_the_old_token_without_old_guard_removing_the_replacement() {
    let provider = BoundedProvider::new(vec![
        ProviderStep::WaitForCancellation,
        ProviderStep::WaitForCancellation,
    ]);
    let cache = MemoryCache::bounded(2, 0);
    let requests = RequestRegistry::default();
    let coordinator = Arc::new(coordinator(
        provider.clone(),
        cache.clone(),
        requests.clone(),
    ));
    let (sessions, session_id) = live_session();
    let sessions = Arc::new(sessions);
    let request_id = Uuid::new_v4();

    let first = {
        let coordinator = Arc::clone(&coordinator);
        let sessions = Arc::clone(&sessions);
        tokio::spawn(async move {
            coordinator
                .translate(request(request_id, session_id, "first source"), &sessions)
                .await
        })
    };
    provider.wait_for_arrivals(1).await;
    let second = {
        let coordinator = Arc::clone(&coordinator);
        let sessions = Arc::clone(&sessions);
        tokio::spawn(async move {
            coordinator
                .translate(
                    request(request_id, session_id, "replacement source"),
                    &sessions,
                )
                .await
        })
    };
    provider.wait_for_arrivals(1).await;

    let first_error = tokio::time::timeout(Duration::from_secs(1), first)
        .await
        .expect("old request exits after replacement")
        .expect("old request task does not panic")
        .unwrap_err();
    assert_eq!(first_error.code(), "REQUEST_CANCELLED");
    requests.cancel(request_id);
    let second_error = tokio::time::timeout(Duration::from_secs(1), second)
        .await
        .expect("replacement remains registered and can be cancelled")
        .expect("replacement task does not panic")
        .unwrap_err();

    assert_eq!(second_error.code(), "REQUEST_CANCELLED");
    provider.assert_exhausted();
    cache.assert_calls(2, 0);
}

#[tokio::test]
async fn cache_read_and_write_failures_are_one_nonfatal_diagnostic() {
    let provider = BoundedProvider::new(vec![ProviderStep::Success {
        translation: "可用译文".to_owned(),
        usage: usage(Some(8), Some(4)),
    }]);
    let cache = MemoryCache::failing(1, 1);
    let coordinator = coordinator(provider.clone(), cache.clone(), RequestRegistry::default());
    let (sessions, session_id) = live_session();

    let result = coordinator
        .translate(
            request(Uuid::new_v4(), session_id, "source text"),
            &sessions,
        )
        .await
        .unwrap();

    assert_eq!(result.translation, "可用译文");
    assert_eq!(result.diagnostics, vec![DiagnosticCode::CacheUnavailable]);
    provider.assert_exhausted();
    cache.assert_calls(1, 1);
}

#[tokio::test]
async fn startup_sqlite_failure_uses_a_non_persisting_backend_and_translation_still_succeeds() {
    let directory = tempfile::tempdir().unwrap();
    let blocked_parent = directory.path().join("not-a-directory");
    std::fs::write(&blocked_parent, b"fixture").unwrap();
    let cache = SqliteTranslationCache::open_or_unavailable(
        blocked_parent.join("translation-cache.sqlite3"),
        CachePolicy::production(),
    )
    .await;
    assert_eq!(cache.stats().await.unwrap_err().code(), "CACHE_UNAVAILABLE");
    let provider = BoundedProvider::new(vec![ProviderStep::Success {
        translation: "无缓存仍可用".to_owned(),
        usage: usage(Some(8), Some(4)),
    }]);
    let coordinator = TranslationCoordinator::new(
        vec![Arc::new(provider.clone()) as Arc<dyn TranslationProvider>],
        Arc::new(cache) as Arc<dyn TranslationCache>,
        RequestRegistry::default(),
    );
    let (sessions, session_id) = live_session();

    let result = coordinator
        .translate(
            request(Uuid::new_v4(), session_id, "source text"),
            &sessions,
        )
        .await
        .unwrap();

    assert_eq!(result.translation, "无缓存仍可用");
    assert_eq!(result.diagnostics, vec![DiagnosticCode::CacheUnavailable]);
    provider.assert_exhausted();
}

#[tokio::test]
async fn a_corrupt_sqlite_hit_is_deleted_and_provider_success_reports_one_diagnostic() {
    let directory = tempfile::tempdir().unwrap();
    let path = directory.path().join("translation-cache.sqlite3");
    let cache = SqliteTranslationCache::open(path.clone(), CachePolicy::production())
        .await
        .unwrap();
    let source = "source text";
    let metadata = deepseek_metadata();
    cache
        .put(CacheRecord {
            cache_key: cache_key(source, ProviderId::Deepseek, &metadata).unwrap(),
            source_text_hash: academic_translator_lib::translation::source_text_hash(source),
            source_language: "en".to_owned(),
            target_language: "zh-CN".to_owned(),
            provider: ProviderId::Deepseek,
            model_id: metadata.model_id.clone(),
            model_revision: metadata.model_revision.clone(),
            prompt_version: metadata.prompt_version.clone(),
            normalization_version: NORMALIZATION_VERSION.to_owned(),
            translation: "不得显示的污染缓存".to_owned(),
            usage: usage(Some(1), Some(1)),
        })
        .await
        .unwrap();
    rusqlite::Connection::open(&path)
        .unwrap()
        .execute("UPDATE translations SET source_language = 'fr'", [])
        .unwrap();
    let provider = BoundedProvider::new(vec![ProviderStep::Success {
        translation: "可信新译文".to_owned(),
        usage: usage(Some(8), Some(4)),
    }]);
    let coordinator = TranslationCoordinator::new(
        vec![Arc::new(provider.clone()) as Arc<dyn TranslationProvider>],
        Arc::new(cache.clone()) as Arc<dyn TranslationCache>,
        RequestRegistry::default(),
    );
    let (sessions, session_id) = live_session();

    let result = coordinator
        .translate(request(Uuid::new_v4(), session_id, source), &sessions)
        .await
        .unwrap();

    assert_eq!(result.translation, "可信新译文");
    assert!(!result.cache_hit);
    assert_eq!(result.diagnostics, vec![DiagnosticCode::CacheUnavailable]);
    assert_eq!(cache.stats().await.unwrap().row_count, 1);
    provider.assert_exhausted();
}

#[tokio::test]
async fn incompatible_cache_metadata_is_bypassed_without_exposing_it() {
    let source = "source text";
    let metadata = deepseek_metadata();
    let key = cache_key(source, ProviderId::Deepseek, &metadata).unwrap();
    let provider = BoundedProvider::new(vec![ProviderStep::Success {
        translation: "可信新译文".to_owned(),
        usage: usage(Some(8), Some(4)),
    }]);
    let cache = MemoryCache::bounded(1, 1);
    cache.seed(
        key,
        CachedTranslation {
            provider: ProviderId::Deepseek,
            model_id: DEEPSEEK_MODEL_ID.to_owned(),
            model_revision: "unapproved-revision".to_owned(),
            prompt_version: PROMPT_VERSION.to_owned(),
            normalization_version: NORMALIZATION_VERSION.to_owned(),
            translation: "不得返回的污染缓存".to_owned(),
            created_at: 0,
            last_accessed_at: 0,
            usage: usage(Some(1), Some(1)),
        },
    );
    let coordinator = coordinator(provider.clone(), cache.clone(), RequestRegistry::default());
    let (sessions, session_id) = live_session();

    let result = coordinator
        .translate(request(Uuid::new_v4(), session_id, source), &sessions)
        .await
        .unwrap();

    assert_eq!(result.translation, "可信新译文");
    assert_eq!(result.diagnostics, vec![DiagnosticCode::CacheUnavailable]);
    provider.assert_exhausted();
    cache.assert_calls(1, 1);
}

#[tokio::test]
async fn non_live_document_is_rejected_before_normalization_cache_or_provider_work() {
    let provider = BoundedProvider::no_calls_allowed();
    let cache = MemoryCache::bounded(0, 0);
    let coordinator = coordinator(provider.clone(), cache.clone(), RequestRegistry::default());
    let (sessions, session_id) = live_session();
    sessions.close(session_id);
    let empty_request = TranslationRequestDto {
        request_id: Uuid::new_v4(),
        document_session_id: session_id,
        provider: ProviderId::Deepseek,
        fragments: Vec::new(),
    };

    let error = coordinator
        .translate(empty_request, &sessions)
        .await
        .unwrap_err();

    assert_eq!(error.code(), "REQUEST_CANCELLED");
    provider.assert_exhausted();
    cache.assert_calls(0, 0);
}

#[tokio::test]
async fn exactly_one_retry_occurs_only_for_a_known_connection_failure_before_send() {
    let provider = BoundedProvider::new(vec![
        ProviderStep::Error(AppError::network_unavailable(true)),
        ProviderStep::Success {
            translation: "重试成功".to_owned(),
            usage: usage(Some(8), Some(4)),
        },
    ]);
    let cache = MemoryCache::bounded(1, 1);
    let coordinator = coordinator(provider.clone(), cache.clone(), RequestRegistry::default());
    let (sessions, session_id) = live_session();

    let result = coordinator
        .translate(
            request(Uuid::new_v4(), session_id, "source text"),
            &sessions,
        )
        .await
        .unwrap();

    assert_eq!(result.translation, "重试成功");
    provider.assert_exhausted();
    cache.assert_calls(1, 1);
}

#[tokio::test]
async fn a_second_pre_send_failure_is_not_retried_a_third_time() {
    let provider = BoundedProvider::new(vec![
        ProviderStep::Error(AppError::network_unavailable(true)),
        ProviderStep::Error(AppError::network_unavailable(true)),
    ]);
    let cache = MemoryCache::bounded(1, 0);
    let coordinator = coordinator(provider.clone(), cache.clone(), RequestRegistry::default());
    let (sessions, session_id) = live_session();

    let error = coordinator
        .translate(
            request(Uuid::new_v4(), session_id, "source text"),
            &sessions,
        )
        .await
        .unwrap_err();

    assert_eq!(error.code(), "NETWORK_UNAVAILABLE");
    provider.assert_exhausted();
    cache.assert_calls(1, 0);
}

#[tokio::test]
async fn cancellation_is_rechecked_before_the_single_allowed_retry() {
    let provider = BoundedProvider::new(vec![ProviderStep::CancelThenError(
        AppError::network_unavailable(true),
    )]);
    let cache = MemoryCache::bounded(1, 0);
    let coordinator = coordinator(provider.clone(), cache.clone(), RequestRegistry::default());
    let (sessions, session_id) = live_session();

    let error = coordinator
        .translate(
            request(Uuid::new_v4(), session_id, "source text"),
            &sessions,
        )
        .await
        .unwrap_err();

    assert_eq!(error.code(), "REQUEST_CANCELLED");
    provider.assert_exhausted();
    cache.assert_calls(1, 0);
}

#[tokio::test]
async fn cancellation_during_the_single_retry_wins_over_its_transport_error() {
    let provider = BoundedProvider::new(vec![
        ProviderStep::Error(AppError::network_unavailable(true)),
        ProviderStep::CancelThenError(AppError::network_unavailable(false)),
    ]);
    let cache = MemoryCache::bounded(1, 0);
    let coordinator = coordinator(provider.clone(), cache.clone(), RequestRegistry::default());
    let (sessions, session_id) = live_session();

    let error = coordinator
        .translate(
            request(Uuid::new_v4(), session_id, "source text"),
            &sessions,
        )
        .await
        .unwrap_err();

    assert_eq!(error.code(), "REQUEST_CANCELLED");
    provider.assert_exhausted();
    cache.assert_calls(1, 0);
}

#[tokio::test]
async fn auth_rate_limit_received_5xx_malformed_timeout_cancel_and_post_send_network_never_retry() {
    let cases = [
        ("auth-401-or-403", AppError::auth_invalid(), "AUTH_INVALID"),
        ("rate-limit", AppError::rate_limited(), "RATE_LIMITED"),
        (
            "received-5xx",
            AppError::provider_unavailable(),
            "PROVIDER_UNAVAILABLE",
        ),
        (
            "malformed",
            AppError::malformed_response(),
            "MALFORMED_RESPONSE",
        ),
        ("timeout", AppError::request_timeout(), "REQUEST_TIMEOUT"),
        (
            "cancelled",
            AppError::request_cancelled(),
            "REQUEST_CANCELLED",
        ),
        (
            "post-send-network",
            AppError::network_unavailable(false),
            "NETWORK_UNAVAILABLE",
        ),
    ];

    for (label, provider_error, expected_code) in cases {
        let provider = BoundedProvider::new(vec![ProviderStep::Error(provider_error)]);
        let cache = MemoryCache::bounded(1, 0);
        let coordinator = coordinator(provider.clone(), cache.clone(), RequestRegistry::default());
        let (sessions, session_id) = live_session();

        let error = coordinator
            .translate(
                request(Uuid::new_v4(), session_id, "source text"),
                &sessions,
            )
            .await
            .unwrap_err();

        assert_eq!(error.code(), expected_code, "case: {label}");
        provider.assert_exhausted();
        cache.assert_calls(1, 0);
    }
}

#[tokio::test]
async fn provider_result_metadata_blank_text_size_and_usage_overflow_are_rejected_before_cache_write(
) {
    let invalid_results = [
        ProviderResult {
            provider: ProviderId::Youdao,
            model: deepseek_metadata(),
            translation: "wrong provider".to_owned(),
            usage: TokenUsage::default(),
        },
        ProviderResult {
            provider: ProviderId::Deepseek,
            model: ModelMetadata {
                model_revision: "wrong revision".to_owned(),
                ..deepseek_metadata()
            },
            translation: "wrong model".to_owned(),
            usage: TokenUsage::default(),
        },
        ProviderResult {
            provider: ProviderId::Deepseek,
            model: deepseek_metadata(),
            translation: " \n\t ".to_owned(),
            usage: TokenUsage::default(),
        },
        ProviderResult {
            provider: ProviderId::Deepseek,
            model: deepseek_metadata(),
            translation: "译".repeat(12_001),
            usage: TokenUsage::default(),
        },
    ];

    for invalid in invalid_results {
        let provider = BoundedProvider::new(vec![ProviderStep::Result(invalid)]);
        let cache = MemoryCache::bounded(1, 0);
        let coordinator = coordinator(provider.clone(), cache.clone(), RequestRegistry::default());
        let (sessions, session_id) = live_session();

        let error = coordinator
            .translate(
                request(Uuid::new_v4(), session_id, "source text"),
                &sessions,
            )
            .await
            .unwrap_err();

        assert_eq!(error.code(), "MALFORMED_RESPONSE");
        provider.assert_exhausted();
        cache.assert_calls(1, 0);
    }

    let source = "A complete academic sentence. ".repeat(170);
    let provider = BoundedProvider::new(vec![
        ProviderStep::Success {
            translation: "第一段".to_owned(),
            usage: usage(Some(u64::MAX), Some(1)),
        },
        ProviderStep::Success {
            translation: "第二段".to_owned(),
            usage: usage(Some(1), Some(1)),
        },
    ]);
    let cache = MemoryCache::bounded(1, 0);
    let coordinator = coordinator(provider.clone(), cache.clone(), RequestRegistry::default());
    let (sessions, session_id) = live_session();
    let error = coordinator
        .translate(request(Uuid::new_v4(), session_id, source), &sessions)
        .await
        .unwrap_err();
    assert_eq!(error.code(), "MALFORMED_RESPONSE");
    provider.assert_exhausted();
    cache.assert_calls(1, 0);
}

#[test]
fn translation_request_is_strict_camel_case_and_result_is_exactly_task_8_compatible() {
    let request_id = Uuid::new_v4();
    let session_id = Uuid::new_v4();
    let parsed: TranslationRequestDto = serde_json::from_value(serde_json::json!({
        "requestId": request_id,
        "documentSessionId": session_id,
        "provider": "deepseek",
        "fragments": [{"id": "fragment-0", "order": 0, "text": "source"}]
    }))
    .unwrap();
    assert_eq!(parsed.request_id, request_id);
    assert!(
        serde_json::from_value::<TranslationRequestDto>(serde_json::json!({
            "requestId": request_id,
            "documentSessionId": session_id,
            "provider": "deepseek",
            "fragments": [{"id": "fragment-0", "order": 0, "text": "source"}],
            "context": "must be rejected"
        }))
        .is_err()
    );

    let result = TranslationResultDto {
        request_id,
        document_session_id: session_id,
        provider: ProviderId::Deepseek,
        model_id: DEEPSEEK_MODEL_ID.to_owned(),
        normalized_source: "source".to_owned(),
        translation: "译文".to_owned(),
        cache_hit: false,
        usage: usage(Some(2), Some(1)),
        diagnostics: vec![DiagnosticCode::CacheUnavailable],
    };
    let value = serde_json::to_value(result).unwrap();
    assert_eq!(
        value,
        serde_json::json!({
            "requestId": request_id,
            "documentSessionId": session_id,
            "provider": "deepseek",
            "modelId": "deepseek-v4-flash",
            "normalizedSource": "source",
            "translation": "译文",
            "cacheHit": false,
            "usage": {"inputTokens": 2, "outputTokens": 1},
            "diagnostics": ["cache_unavailable"]
        })
    );
}

#[test]
fn translation_errors_are_exact_code_retryable_objects_while_legacy_errors_keep_messages() {
    let fixtures = [
        (
            AppError::credentials_missing(),
            "CREDENTIALS_MISSING",
            false,
        ),
        (AppError::auth_invalid(), "AUTH_INVALID", false),
        (AppError::selection_empty(), "SELECTION_EMPTY", false),
        (
            AppError::selection_too_large(),
            "SELECTION_TOO_LARGE",
            false,
        ),
        (AppError::rate_limited(), "RATE_LIMITED", true),
        (
            AppError::network_unavailable(false),
            "NETWORK_UNAVAILABLE",
            true,
        ),
        (AppError::request_timeout(), "REQUEST_TIMEOUT", true),
        (AppError::request_cancelled(), "REQUEST_CANCELLED", false),
        (
            AppError::provider_unavailable(),
            "PROVIDER_UNAVAILABLE",
            true,
        ),
        (AppError::malformed_response(), "MALFORMED_RESPONSE", true),
        (AppError::cache_unavailable(), "CACHE_UNAVAILABLE", true),
    ];
    for (error, code, retryable) in fixtures {
        let value = serde_json::to_value(CommandError::translation(error)).unwrap();
        assert_eq!(
            value,
            serde_json::json!({"code": code, "retryable": retryable})
        );
        assert_eq!(value.as_object().unwrap().len(), 2);
    }

    let document = serde_json::to_value(CommandError::document_unavailable()).unwrap();
    assert_eq!(
        document,
        serde_json::json!({
            "code": "DOCUMENT_UNAVAILABLE",
            "message": "PDF 文档不可用，请重新打开。"
        })
    );
    let settings =
        serde_json::to_value(CommandError::from(AppError::credential_store_unavailable())).unwrap();
    assert_eq!(settings.as_object().unwrap().len(), 2);
    assert!(settings.get("message").is_some());
    assert!(settings.get("retryable").is_none());
}
