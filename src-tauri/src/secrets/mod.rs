mod masking;
mod store;

use serde::{Deserialize, Serialize};

pub use masking::mask_secret;
pub use store::{KeyringSecretStore, SecretStore, SecretValue};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum CredentialKind {
    DeepseekApiKey,
    YoudaoAppId,
    YoudaoAppSecret,
}

impl CredentialKind {
    pub(crate) const ALL: [Self; 3] = [
        Self::DeepseekApiKey,
        Self::YoudaoAppId,
        Self::YoudaoAppSecret,
    ];

    pub(crate) const fn account_name(self) -> &'static str {
        match self {
            Self::DeepseekApiKey => "deepseek_api_key",
            Self::YoudaoAppId => "youdao_app_id",
            Self::YoudaoAppSecret => "youdao_app_secret",
        }
    }
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CredentialSummary {
    pub kind: CredentialKind,
    pub configured: bool,
    pub masked_hint: Option<String>,
}

#[cfg(test)]
mod tests {
    use super::{mask_secret, CredentialKind, CredentialSummary, SecretValue};
    use zeroize::{Zeroize, ZeroizeOnDrop};

    #[test]
    fn debug_never_exposes_secret_material() {
        let secret = SecretValue::new("sk-example-secret-A9f2".to_owned()).unwrap();

        assert_eq!(format!("{secret:?}"), "SecretValue([REDACTED])");
        assert!(!format!("{secret:?}").contains("example"));
        assert_eq!(secret.expose_secret(), "sk-example-secret-A9f2");
    }

    #[test]
    fn empty_and_whitespace_only_secrets_are_rejected_without_echoing_input() {
        for fixture in ["", "   ", "\n\t", "\u{2003}"] {
            let error = SecretValue::new(fixture.to_owned()).unwrap_err();
            let rendered = format!("{error:?}");
            if !fixture.is_empty() {
                assert!(!rendered.contains(fixture));
            }
        }
    }

    #[test]
    fn secret_value_supports_explicit_zeroization_and_zeroizes_on_drop() {
        fn assert_zeroize_on_drop<T: ZeroizeOnDrop>() {}
        assert_zeroize_on_drop::<SecretValue>();

        let mut secret = SecretValue::new("sk-example-secret-A9f2".to_owned()).unwrap();
        secret.zeroize();
        assert!(!secret.expose_secret().contains("example-secret"));
        assert!(secret.expose_secret().bytes().all(|byte| byte == 0));
        assert_eq!(format!("{secret:?}"), "SecretValue([REDACTED])");
    }

    #[test]
    fn mask_keeps_only_a_small_fixed_identifying_hint() {
        assert_eq!(mask_secret("sk-example-secret-A9f2"), "sk-••••••••A9f2");
        assert_eq!(mask_secret("short"), "••••••••");
        assert_eq!(mask_secret("identifier-A9f2"), "••••••••A9f2");
    }

    #[test]
    fn credential_dtos_use_the_exact_ipc_spellings_and_never_serialize_plaintext() {
        let fixtures = [
            (CredentialKind::DeepseekApiKey, "deepseek_api_key"),
            (CredentialKind::YoudaoAppId, "youdao_app_id"),
            (CredentialKind::YoudaoAppSecret, "youdao_app_secret"),
        ];

        for (kind, spelling) in fixtures {
            assert_eq!(
                serde_json::to_string(&kind).unwrap(),
                format!("\"{spelling}\"")
            );
        }

        let summary = CredentialSummary {
            kind: CredentialKind::DeepseekApiKey,
            configured: true,
            masked_hint: Some("sk-••••••••A9f2".to_owned()),
        };
        let json = serde_json::to_string(&summary).unwrap();
        assert_eq!(
            json,
            r#"{"kind":"deepseek_api_key","configured":true,"maskedHint":"sk-••••••••A9f2"}"#
        );
        assert!(!json.contains("example-secret"));
    }
}
