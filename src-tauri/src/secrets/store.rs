use std::fmt;

use async_trait::async_trait;
use keyring::{Entry, Error as KeyringError};
use secrecy::{ExposeSecret, SecretString};
use zeroize::{Zeroize, ZeroizeOnDrop};

use crate::errors::AppError;

use super::CredentialKind;

const KEYRING_SERVICE: &str = "com.carbene.academic-translator";

pub struct SecretValue(SecretString);

impl SecretValue {
    pub fn new(mut value: String) -> Result<Self, AppError> {
        if value.trim().is_empty() {
            value.zeroize();
            return Err(AppError::credential_value_invalid());
        }

        Ok(Self(SecretString::from(value)))
    }

    pub fn expose_secret(&self) -> &str {
        self.0.expose_secret()
    }
}

impl fmt::Debug for SecretValue {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str("SecretValue([REDACTED])")
    }
}

impl Zeroize for SecretValue {
    fn zeroize(&mut self) {
        self.0.zeroize();
    }
}

impl ZeroizeOnDrop for SecretValue {}

#[async_trait]
pub trait SecretStore: Send + Sync {
    async fn save(&self, kind: CredentialKind, value: SecretValue) -> Result<(), AppError>;
    async fn get(&self, kind: CredentialKind) -> Result<Option<SecretValue>, AppError>;
    async fn delete(&self, kind: CredentialKind) -> Result<(), AppError>;
}

#[derive(Debug, Default)]
pub struct KeyringSecretStore;

impl KeyringSecretStore {
    fn entry(kind: CredentialKind) -> Result<Entry, AppError> {
        Entry::new(KEYRING_SERVICE, kind.account_name()).map_err(|_| vault_unavailable())
    }
}

fn vault_unavailable() -> AppError {
    AppError::credential_store_unavailable()
}

fn join_failed(_: tokio::task::JoinError) -> AppError {
    vault_unavailable()
}

#[async_trait]
impl SecretStore for KeyringSecretStore {
    async fn save(&self, kind: CredentialKind, value: SecretValue) -> Result<(), AppError> {
        tokio::task::spawn_blocking(move || {
            let entry = Self::entry(kind)?;
            entry
                .set_password(value.expose_secret())
                .map_err(|_| vault_unavailable())
        })
        .await
        .map_err(join_failed)?
    }

    async fn get(&self, kind: CredentialKind) -> Result<Option<SecretValue>, AppError> {
        tokio::task::spawn_blocking(move || {
            let entry = Self::entry(kind)?;
            match entry.get_password() {
                Ok(value) => SecretValue::new(value).map(Some),
                Err(KeyringError::NoEntry) => Ok(None),
                Err(_) => Err(vault_unavailable()),
            }
        })
        .await
        .map_err(join_failed)?
    }

    async fn delete(&self, kind: CredentialKind) -> Result<(), AppError> {
        tokio::task::spawn_blocking(move || {
            let entry = Self::entry(kind)?;
            match entry.delete_credential() {
                Ok(()) | Err(KeyringError::NoEntry) => Ok(()),
                Err(_) => Err(vault_unavailable()),
            }
        })
        .await
        .map_err(join_failed)?
    }
}
