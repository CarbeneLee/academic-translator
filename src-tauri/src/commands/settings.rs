use crate::{
    errors::{AppError, CommandError},
    secrets::{
        mask_secret, CredentialKind, CredentialSummary, KeyringSecretStore, SecretStore,
        SecretValue,
    },
};

pub async fn save_credential_with_store<S: SecretStore + ?Sized>(
    store: &S,
    kind: CredentialKind,
    value: String,
) -> Result<CredentialSummary, AppError> {
    let secret = SecretValue::new(value)?;
    let masked_hint = mask_secret(secret.expose_secret());
    store.save(kind, secret).await?;
    Ok(CredentialSummary {
        kind,
        configured: true,
        masked_hint: Some(masked_hint),
    })
}

pub async fn delete_credential_with_store<S: SecretStore + ?Sized>(
    store: &S,
    kind: CredentialKind,
) -> Result<CredentialSummary, AppError> {
    store.delete(kind).await?;
    Ok(CredentialSummary {
        kind,
        configured: false,
        masked_hint: None,
    })
}

pub async fn credential_statuses_with_store<S: SecretStore + ?Sized>(
    store: &S,
) -> Result<Vec<CredentialSummary>, AppError> {
    let mut summaries = Vec::with_capacity(CredentialKind::ALL.len());
    for kind in CredentialKind::ALL {
        let secret = store.get(kind).await?;
        summaries.push(CredentialSummary {
            kind,
            configured: secret.is_some(),
            masked_hint: secret
                .as_ref()
                .map(|value| mask_secret(value.expose_secret())),
        });
    }
    Ok(summaries)
}

#[tauri::command]
pub async fn save_credential(
    store: tauri::State<'_, KeyringSecretStore>,
    kind: CredentialKind,
    value: String,
) -> Result<CredentialSummary, CommandError> {
    save_credential_with_store(store.inner(), kind, value)
        .await
        .map_err(CommandError::from)
}

#[tauri::command]
pub async fn delete_credential(
    store: tauri::State<'_, KeyringSecretStore>,
    kind: CredentialKind,
) -> Result<CredentialSummary, CommandError> {
    delete_credential_with_store(store.inner(), kind)
        .await
        .map_err(CommandError::from)
}

#[tauri::command]
pub async fn credential_statuses(
    store: tauri::State<'_, KeyringSecretStore>,
) -> Result<Vec<CredentialSummary>, CommandError> {
    credential_statuses_with_store(store.inner())
        .await
        .map_err(CommandError::from)
}

#[cfg(test)]
mod tests {
    use std::sync::Mutex;

    use async_trait::async_trait;

    use super::{
        credential_statuses_with_store, delete_credential_with_store, save_credential_with_store,
    };
    use crate::{
        errors::{AppError, CommandError},
        secrets::{CredentialKind, SecretStore, SecretValue},
    };

    #[derive(Default)]
    struct MemorySecretStore {
        values: Mutex<Vec<(CredentialKind, String)>>,
        calls: Mutex<Vec<String>>,
        fail_saves: bool,
    }

    impl MemorySecretStore {
        fn failing() -> Self {
            Self {
                fail_saves: true,
                ..Self::default()
            }
        }

        fn call_log(&self) -> Vec<String> {
            self.calls.lock().unwrap().clone()
        }

        fn stored_value(&self, kind: CredentialKind) -> Option<String> {
            self.values
                .lock()
                .unwrap()
                .iter()
                .find(|(candidate, _)| *candidate == kind)
                .map(|(_, value)| value.clone())
        }
    }

    #[async_trait]
    impl SecretStore for MemorySecretStore {
        async fn save(&self, kind: CredentialKind, value: SecretValue) -> Result<(), AppError> {
            self.calls.lock().unwrap().push(format!("save:{kind:?}"));
            if self.fail_saves {
                return Err(AppError::credential_store_unavailable());
            }

            let mut values = self.values.lock().unwrap();
            values.retain(|(candidate, _)| *candidate != kind);
            values.push((kind, value.expose_secret().to_owned()));
            Ok(())
        }

        async fn get(&self, kind: CredentialKind) -> Result<Option<SecretValue>, AppError> {
            self.calls.lock().unwrap().push(format!("get:{kind:?}"));
            self.stored_value(kind).map(SecretValue::new).transpose()
        }

        async fn delete(&self, kind: CredentialKind) -> Result<(), AppError> {
            self.calls.lock().unwrap().push(format!("delete:{kind:?}"));
            self.values
                .lock()
                .unwrap()
                .retain(|(candidate, _)| *candidate != kind);
            Ok(())
        }
    }

    #[tokio::test]
    async fn save_returns_only_masked_status_and_drops_plaintext() {
        let vault = MemorySecretStore::default();
        let summary = save_credential_with_store(
            &vault,
            CredentialKind::DeepseekApiKey,
            "sk-example-secret-A9f2".to_owned(),
        )
        .await
        .unwrap();

        let json = serde_json::to_string(&summary).unwrap();
        assert_eq!(summary.kind, CredentialKind::DeepseekApiKey);
        assert!(summary.configured);
        assert_eq!(summary.masked_hint.as_deref(), Some("sk-••••••••A9f2"));
        assert!(!json.contains("example-secret"));
        assert_eq!(
            vault
                .stored_value(CredentialKind::DeepseekApiKey)
                .as_deref(),
            Some("sk-example-secret-A9f2")
        );
    }

    #[tokio::test]
    async fn all_credential_kinds_replace_delete_and_report_in_stable_order() {
        let vault = MemorySecretStore::default();
        let fixtures = [
            (CredentialKind::DeepseekApiKey, "deepseek-original-A9f2"),
            (CredentialKind::YoudaoAppId, "youdao-app-id-72B4"),
            (CredentialKind::YoudaoAppSecret, "youdao-secret-91C7"),
        ];

        for (kind, value) in fixtures {
            save_credential_with_store(&vault, kind, value.to_owned())
                .await
                .unwrap();
        }
        save_credential_with_store(
            &vault,
            CredentialKind::YoudaoAppId,
            "youdao-replacement-55D8".to_owned(),
        )
        .await
        .unwrap();

        let summaries = credential_statuses_with_store(&vault).await.unwrap();
        assert_eq!(
            summaries
                .iter()
                .map(|summary| summary.kind)
                .collect::<Vec<_>>(),
            vec![
                CredentialKind::DeepseekApiKey,
                CredentialKind::YoudaoAppId,
                CredentialKind::YoudaoAppSecret,
            ]
        );
        let serialized = serde_json::to_string(&summaries).unwrap();
        for plaintext in [
            "deepseek-original-A9f2",
            "youdao-replacement-55D8",
            "youdao-secret-91C7",
        ] {
            assert!(!serialized.contains(plaintext));
        }

        let deleted = delete_credential_with_store(&vault, CredentialKind::YoudaoAppSecret)
            .await
            .unwrap();
        assert!(!deleted.configured);
        assert_eq!(deleted.masked_hint, None);
        assert_eq!(vault.stored_value(CredentialKind::YoudaoAppSecret), None);
        assert_eq!(
            vault.stored_value(CredentialKind::YoudaoAppId).as_deref(),
            Some("youdao-replacement-55D8")
        );
        assert_eq!(
            vault.call_log(),
            vec![
                "save:DeepseekApiKey",
                "save:YoudaoAppId",
                "save:YoudaoAppSecret",
                "save:YoudaoAppId",
                "get:DeepseekApiKey",
                "get:YoudaoAppId",
                "get:YoudaoAppSecret",
                "delete:YoudaoAppSecret",
            ]
        );
    }

    #[tokio::test]
    async fn failed_save_errors_never_retain_or_serialize_the_submitted_secret() {
        let vault = MemorySecretStore::failing();
        let fixture = "sk-never-echo-this-A9f2";

        let error =
            save_credential_with_store(&vault, CredentialKind::DeepseekApiKey, fixture.to_owned())
                .await
                .unwrap_err();
        let debug = format!("{error:?}");
        let ipc_json = serde_json::to_string(&CommandError::from(error)).unwrap();

        assert!(!debug.contains(fixture));
        assert!(!ipc_json.contains(fixture));
        assert_eq!(vault.stored_value(CredentialKind::DeepseekApiKey), None);
    }
}
