use std::{
    collections::{BTreeMap, BTreeSet},
    sync::{
        atomic::{AtomicUsize, Ordering},
        Arc,
    },
    time::Duration,
};

use async_trait::async_trait;
use rstest::rstest;
use serde_json::json;
use tokio::{sync::Notify, time::timeout};
use tokio_util::sync::CancellationToken;
use uuid::Uuid;
use wiremock::{
    matchers::{method, path},
    Mock, MockServer, ResponseTemplate,
};

use crate::{
    errors::AppError,
    secrets::{CredentialKind, SecretStore, SecretValue},
    translation::{
        ProviderRequest, ProviderResult, TokenUsage, TranslationMode, TranslationProvider,
        SOURCE_LANGUAGE, TARGET_LANGUAGE,
    },
};

use super::{
    signing::{sign_v3, truncate_for_sign},
    YoudaoProvider,
};

struct YoudaoSecretStore {
    app_id: Option<&'static str>,
    app_secret: Option<&'static str>,
    maximum_gets: usize,
    gets: AtomicUsize,
}

impl YoudaoSecretStore {
    fn configured() -> Self {
        Self::with_values(Some("app"), Some("secret"), 2)
    }

    fn with_values(
        app_id: Option<&'static str>,
        app_secret: Option<&'static str>,
        maximum_gets: usize,
    ) -> Self {
        Self {
            app_id,
            app_secret,
            maximum_gets,
            gets: AtomicUsize::new(0),
        }
    }
}

#[async_trait]
impl SecretStore for YoudaoSecretStore {
    async fn save(&self, _: CredentialKind, _: SecretValue) -> Result<(), AppError> {
        panic!("unexpected credential save")
    }

    async fn get(&self, kind: CredentialKind) -> Result<Option<SecretValue>, AppError> {
        let call = self.gets.fetch_add(1, Ordering::SeqCst);
        assert!(call < self.maximum_gets, "unexpected credential read");
        let value = match kind {
            CredentialKind::YoudaoAppId => self.app_id,
            CredentialKind::YoudaoAppSecret => self.app_secret,
            CredentialKind::DeepseekApiKey => panic!("unexpected DeepSeek credential read"),
        };
        value
            .map(|secret| SecretValue::new(secret.to_owned()))
            .transpose()
    }

    async fn delete(&self, _: CredentialKind) -> Result<(), AppError> {
        panic!("unexpected credential delete")
    }
}

fn passage(selected_text: impl Into<String>) -> ProviderRequest {
    ProviderRequest {
        selected_text: selected_text.into(),
        source_language: SOURCE_LANGUAGE,
        target_language: TARGET_LANGUAGE,
        mode: TranslationMode::Passage,
        max_output_tokens: 256,
    }
}

fn youdao_for(server: &MockServer) -> YoudaoProvider {
    YoudaoProvider::for_test(
        Arc::new(YoudaoSecretStore::configured()),
        format!("{}/api", server.uri()),
        Duration::from_secs(2),
        Some(("salt".to_owned(), "1700000000".to_owned())),
    )
    .unwrap()
}

fn percent_decode(value: &str) -> String {
    fn hex_value(value: u8) -> u8 {
        match value {
            b'0'..=b'9' => value - b'0',
            b'a'..=b'f' => value - b'a' + 10,
            b'A'..=b'F' => value - b'A' + 10,
            _ => panic!("invalid percent encoding"),
        }
    }

    let bytes = value.as_bytes();
    let mut decoded = Vec::with_capacity(bytes.len());
    let mut index = 0;
    while index < bytes.len() {
        match bytes[index] {
            b'+' => {
                decoded.push(b' ');
                index += 1;
            }
            b'%' => {
                assert!(index + 2 < bytes.len(), "truncated percent encoding");
                decoded.push((hex_value(bytes[index + 1]) << 4) | hex_value(bytes[index + 2]));
                index += 3;
            }
            byte => {
                decoded.push(byte);
                index += 1;
            }
        }
    }
    String::from_utf8(decoded).unwrap()
}

fn parse_form(body: &[u8]) -> BTreeMap<String, String> {
    let mut form = BTreeMap::new();
    for pair in std::str::from_utf8(body).unwrap().split('&') {
        let (key, value) = pair.split_once('=').unwrap();
        let previous = form.insert(percent_decode(key), percent_decode(value));
        assert!(previous.is_none(), "duplicate form field");
    }
    form
}

async fn recorded_youdao_request() -> (ProviderResult, BTreeMap<String, String>) {
    let server = MockServer::start().await;
    Mock::given(method("POST"))
        .and(path("/api"))
        .respond_with(ResponseTemplate::new(200).set_body_json(json!({
            "errorCode": "0",
            "translation": ["译文"],
            "dict": {"url": "ignored"},
            "speakUrl": "ignored"
        })))
        .expect(1)
        .mount(&server)
        .await;

    let result = youdao_for(&server)
        .translate(
            passage("abcdefghijklmnopqrstuvwxyz"),
            CancellationToken::new(),
        )
        .await
        .unwrap();
    let requests = server.received_requests().await.unwrap();
    assert_eq!(requests.len(), 1);
    assert_eq!(requests[0].url.path(), "/api");
    assert_eq!(requests[0].method.as_str(), "POST");
    let content_type = requests[0]
        .headers
        .get("content-type")
        .map(|value| value.to_str().unwrap().to_owned())
        .unwrap();
    assert!(content_type.starts_with("application/x-www-form-urlencoded"));
    (result, parse_form(&requests[0].body))
}

async fn call_youdao_fixture(body: ResponseTemplate) -> Result<ProviderResult, AppError> {
    let server = MockServer::start().await;
    Mock::given(method("POST"))
        .and(path("/api"))
        .respond_with(body)
        .expect(1)
        .mount(&server)
        .await;

    youdao_for(&server)
        .translate(passage("source"), CancellationToken::new())
        .await
}

#[test]
fn v3_signature_uses_truncated_unicode_input() {
    assert_eq!(
        truncate_for_sign("abcdefghijklmnopqrstuvwxyz"),
        "abcdefghij26qrstuvwxyz"
    );
    assert_eq!(
        sign_v3(
            "app",
            "abcdefghijklmnopqrstuvwxyz",
            "salt",
            "1700000000",
            "secret"
        ),
        "2da886576be8f7c09f83b068630bf8da285e6cca3b4bcbe893fa27801eb5df84"
    );

    let unicode_query = "学".repeat(25);
    assert_eq!(
        truncate_for_sign(&unicode_query),
        format!("{}25{}", "学".repeat(10), "学".repeat(10))
    );
    assert_eq!(
        sign_v3("appid", &unicode_query, "salt", "1700000000", "secret"),
        "1b26f609adb23705b66e1b1aae3e8ab32042188dd9ab23895429e4829be60f0f"
    );
}

#[tokio::test]
async fn posts_the_exact_strict_english_to_simplified_chinese_form() {
    let (result, form) = recorded_youdao_request().await;
    assert_eq!(
        form.keys().map(String::as_str).collect::<BTreeSet<_>>(),
        BTreeSet::from([
            "appKey", "curtime", "from", "q", "salt", "sign", "signType", "strict", "to"
        ])
    );
    assert_eq!(form["q"], "abcdefghijklmnopqrstuvwxyz");
    assert_eq!(form["from"], "en");
    assert_eq!(form["to"], "zh-CHS");
    assert_eq!(form["appKey"], "app");
    assert_eq!(form["salt"], "salt");
    assert_eq!(form["signType"], "v3");
    assert_eq!(form["curtime"], "1700000000");
    assert_eq!(form["strict"], "true");
    assert_eq!(
        form["sign"],
        "2da886576be8f7c09f83b068630bf8da285e6cca3b4bcbe893fa27801eb5df84"
    );
    assert_eq!(result.translation, "译文");
    assert_eq!(result.usage, TokenUsage::default());
    assert_eq!(result.model.model_id, "youdao-text-translation");
    assert_eq!(result.model.model_revision, "youdao-text-v3");
    assert_eq!(result.model.prompt_version, "youdao-direct-v1");
}

#[tokio::test]
async fn uses_utf8_form_encoding_for_unicode_selected_text() {
    let server = MockServer::start().await;
    Mock::given(method("POST"))
        .and(path("/api"))
        .respond_with(ResponseTemplate::new(200).set_body_json(json!({
            "errorCode": "0",
            "translation": ["贝塔"]
        })))
        .expect(1)
        .mount(&server)
        .await;

    youdao_for(&server)
        .translate(passage("β result"), CancellationToken::new())
        .await
        .unwrap();
    let requests = server.received_requests().await.unwrap();
    let form = parse_form(&requests[0].body);
    assert_eq!(form["q"], "β result");
}

#[tokio::test]
async fn accepts_the_first_nonblank_translation_and_ignores_optional_fields() {
    let result = call_youdao_fixture(ResponseTemplate::new(200).set_body_json(json!({
        "errorCode": "0",
        "translation": [" ", "有效译文"],
        "basic": {"explains": ["ignored"]},
        "tSpeakUrl": "ignored"
    })))
    .await
    .unwrap();
    assert_eq!(result.translation, "有效译文");
}

#[rstest]
#[case::invalid_app_id("108")]
#[case::service_not_enabled("110")]
#[case::invalid_account("111")]
#[case::bad_signature("202")]
#[case::ip_not_allowed("203")]
#[case::platform_mismatch("205")]
#[case::invalid_timestamp("206")]
#[case::replay("207")]
#[tokio::test]
async fn maps_youdao_authentication_codes(#[case] code: &str) {
    let error =
        call_youdao_fixture(ResponseTemplate::new(200).set_body_json(json!({"errorCode": code})))
            .await
            .unwrap_err();
    assert_eq!(error.code(), "AUTH_INVALID");
}

#[tokio::test]
async fn maps_youdao_rate_limit_code_411() {
    let error =
        call_youdao_fixture(ResponseTemplate::new(200).set_body_json(json!({"errorCode": "411"})))
            .await
            .unwrap_err();
    assert_eq!(error.code(), "RATE_LIMITED");
}

#[tokio::test]
async fn maps_unknown_youdao_error_to_provider_unavailable() {
    let error =
        call_youdao_fixture(ResponseTemplate::new(200).set_body_json(json!({"errorCode": "303"})))
            .await
            .unwrap_err();
    assert_eq!(error.code(), "PROVIDER_UNAVAILABLE");
}

#[rstest]
#[case::unauthorized(401, "AUTH_INVALID")]
#[case::forbidden(403, "AUTH_INVALID")]
#[case::rate_limited(429, "RATE_LIMITED")]
#[case::server_error(500, "PROVIDER_UNAVAILABLE")]
#[case::server_unavailable(503, "PROVIDER_UNAVAILABLE")]
#[tokio::test]
async fn maps_youdao_http_failures(#[case] status: u16, #[case] expected: &str) {
    let error =
        call_youdao_fixture(ResponseTemplate::new(status).set_body_string("provider detail"))
            .await
            .unwrap_err();
    assert_eq!(error.code(), expected);
    assert!(!format!("{error:?}").contains("provider detail"));
}

#[tokio::test]
async fn never_follows_a_youdao_redirect_to_an_unapproved_endpoint() {
    let redirect_target = MockServer::start().await;
    let server = MockServer::start().await;
    Mock::given(method("POST"))
        .and(path("/api"))
        .respond_with(
            ResponseTemplate::new(307)
                .insert_header("location", format!("{}/capture", redirect_target.uri())),
        )
        .expect(1)
        .mount(&server)
        .await;

    let error = youdao_for(&server)
        .translate(passage("private source"), CancellationToken::new())
        .await
        .unwrap_err();
    assert_eq!(error.code(), "PROVIDER_UNAVAILABLE");
    assert!(redirect_target
        .received_requests()
        .await
        .unwrap()
        .is_empty());
}

#[rstest]
#[case::empty_array(json!({"errorCode": "0", "translation": []}))]
#[case::only_blank(json!({"errorCode": "0", "translation": ["", "  "]}))]
#[case::missing_translation(json!({"errorCode": "0"}))]
#[tokio::test]
async fn rejects_empty_success_translations(#[case] body: serde_json::Value) {
    let error = call_youdao_fixture(ResponseTemplate::new(200).set_body_json(body))
        .await
        .unwrap_err();
    assert_eq!(error.code(), "MALFORMED_RESPONSE");
}

#[tokio::test]
async fn rejects_malformed_youdao_json_without_exposing_it() {
    let error = call_youdao_fixture(
        ResponseTemplate::new(200).set_body_raw("not-json", "application/json"),
    )
    .await
    .unwrap_err();
    assert_eq!(error.code(), "MALFORMED_RESPONSE");
    assert!(!format!("{error:?}").contains("not-json"));
}

#[rstest]
#[case::missing_app_id(None, Some("secret"), 1)]
#[case::missing_app_secret(Some("app"), None, 2)]
#[tokio::test]
async fn missing_youdao_credentials_fail_before_network(
    #[case] app_id: Option<&'static str>,
    #[case] app_secret: Option<&'static str>,
    #[case] maximum_gets: usize,
) {
    let server = MockServer::start().await;
    let provider = YoudaoProvider::for_test(
        Arc::new(YoudaoSecretStore::with_values(
            app_id,
            app_secret,
            maximum_gets,
        )),
        format!("{}/api", server.uri()),
        Duration::from_secs(1),
        Some(("salt".to_owned(), "1700000000".to_owned())),
    )
    .unwrap();

    let error = provider
        .translate(passage("source"), CancellationToken::new())
        .await
        .unwrap_err();
    assert_eq!(error.code(), "CREDENTIALS_MISSING");
    assert!(server.received_requests().await.unwrap().is_empty());
}

#[tokio::test]
async fn rejects_more_than_4000_characters_before_credentials_or_network() {
    let server = MockServer::start().await;
    let provider = YoudaoProvider::for_test(
        Arc::new(YoudaoSecretStore::with_values(None, None, 0)),
        format!("{}/api", server.uri()),
        Duration::from_secs(1),
        Some(("salt".to_owned(), "1700000000".to_owned())),
    )
    .unwrap();

    let error = provider
        .translate(passage("β".repeat(4_001)), CancellationToken::new())
        .await
        .unwrap_err();
    assert_eq!(error.code(), "SELECTION_TOO_LARGE");
    assert!(server.received_requests().await.unwrap().is_empty());
}

#[tokio::test]
async fn accepts_exactly_4000_unicode_scalars_with_two_credential_reads_and_one_request() {
    let server = MockServer::start().await;
    Mock::given(method("POST"))
        .and(path("/api"))
        .respond_with(ResponseTemplate::new(200).set_body_json(json!({
            "errorCode": "0",
            "translation": ["译文"]
        })))
        .expect(1)
        .mount(&server)
        .await;
    let secret_store = Arc::new(YoudaoSecretStore::configured());
    let provider = YoudaoProvider::for_test(
        secret_store.clone(),
        format!("{}/api", server.uri()),
        Duration::from_secs(2),
        Some(("salt".to_owned(), "1700000000".to_owned())),
    )
    .unwrap();

    let result = provider
        .translate(passage("β".repeat(4_000)), CancellationToken::new())
        .await
        .unwrap();

    assert_eq!(result.translation, "译文");
    assert_eq!(secret_store.gets.load(Ordering::SeqCst), 2);
    let requests = server.received_requests().await.unwrap();
    assert_eq!(requests.len(), 1);
    assert_eq!(parse_form(&requests[0].body)["q"].chars().count(), 4_000);
    server.verify().await;
}

#[tokio::test]
async fn generates_a_fresh_uuid_salt_for_each_request() {
    let server = MockServer::start().await;
    Mock::given(method("POST"))
        .and(path("/api"))
        .respond_with(ResponseTemplate::new(200).set_body_json(json!({
            "errorCode": "0",
            "translation": ["译文"]
        })))
        .expect(2)
        .mount(&server)
        .await;
    let provider = YoudaoProvider::for_test(
        Arc::new(YoudaoSecretStore::with_values(
            Some("app"),
            Some("secret"),
            4,
        )),
        format!("{}/api", server.uri()),
        Duration::from_secs(2),
        None,
    )
    .unwrap();

    for _ in 0..2 {
        provider
            .translate(passage("source"), CancellationToken::new())
            .await
            .unwrap();
    }
    let requests = server.received_requests().await.unwrap();
    assert_eq!(requests.len(), 2);
    let salts = requests
        .iter()
        .map(|request| parse_form(&request.body)["salt"].clone())
        .collect::<Vec<_>>();
    assert_ne!(salts[0], salts[1]);
    assert!(salts.iter().all(|salt| Uuid::parse_str(salt).is_ok()));
}

#[tokio::test]
async fn youdao_cancellation_is_bounded() {
    let server = MockServer::start().await;
    let request_arrived = Arc::new(Notify::new());
    let responder_arrived = request_arrived.clone();
    let delayed_response = ResponseTemplate::new(200)
        .set_delay(Duration::from_secs(2))
        .set_body_json(json!({"errorCode": "0", "translation": ["译文"]}));
    Mock::given(method("POST"))
        .and(path("/api"))
        .respond_with(move |_: &wiremock::Request| {
            responder_arrived.notify_one();
            delayed_response.clone()
        })
        .expect(1)
        .mount(&server)
        .await;
    let provider = youdao_for(&server);
    let cancellation = CancellationToken::new();
    let translate_cancellation = cancellation.clone();
    let translation = tokio::spawn(async move {
        provider
            .translate(passage("source"), translate_cancellation)
            .await
    });

    timeout(Duration::from_secs(1), request_arrived.notified())
        .await
        .expect("request did not reach the Youdao mock within the hard bound");
    cancellation.cancel();

    let error = timeout(Duration::from_secs(1), translation)
        .await
        .expect("cancellation test exceeded its hard bound")
        .expect("translation task panicked")
        .unwrap_err();
    assert_eq!(error.code(), "REQUEST_CANCELLED");
    server.verify().await;
}

#[tokio::test]
async fn youdao_total_timeout_is_bounded() {
    let server = MockServer::start().await;
    Mock::given(method("POST"))
        .and(path("/api"))
        .respond_with(
            ResponseTemplate::new(200)
                .set_delay(Duration::from_millis(250))
                .set_body_json(json!({"errorCode": "0", "translation": ["译文"]})),
        )
        .expect(1)
        .mount(&server)
        .await;
    let provider = YoudaoProvider::for_test(
        Arc::new(YoudaoSecretStore::configured()),
        format!("{}/api", server.uri()),
        Duration::from_millis(25),
        Some(("salt".to_owned(), "1700000000".to_owned())),
    )
    .unwrap();

    let error = timeout(
        Duration::from_secs(1),
        provider.translate(passage("source"), CancellationToken::new()),
    )
    .await
    .expect("timeout test exceeded its hard bound")
    .unwrap_err();
    assert_eq!(error.code(), "REQUEST_TIMEOUT");
    server.verify().await;
}
