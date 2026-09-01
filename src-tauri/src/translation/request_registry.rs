use std::{collections::HashMap, sync::Arc};

use tokio_util::sync::CancellationToken;
use uuid::Uuid;

#[derive(Clone, Default)]
pub struct RequestRegistry {
    inner: Arc<RegistryInner>,
}

#[derive(Default)]
struct RegistryInner {
    entries: std::sync::Mutex<HashMap<Uuid, RegistryEntry>>,
}

struct RegistryEntry {
    registration_id: Uuid,
    token: CancellationToken,
}

impl RequestRegistry {
    pub(crate) fn register(&self, request_id: Uuid) -> RequestRegistration {
        let token = CancellationToken::new();
        let registration_id = Uuid::new_v4();
        let mut entries = self
            .inner
            .entries
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        if let Some(previous) = entries.insert(
            request_id,
            RegistryEntry {
                registration_id,
                token: token.clone(),
            },
        ) {
            previous.token.cancel();
        }
        drop(entries);

        RequestRegistration {
            request_id,
            registration_id,
            token,
            registry: self.clone(),
        }
    }

    pub fn cancel(&self, request_id: Uuid) {
        let token = self
            .inner
            .entries
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .get(&request_id)
            .map(|entry| entry.token.clone());
        if let Some(token) = token {
            token.cancel();
        }
    }

    fn remove_if_current(&self, request_id: Uuid, registration_id: Uuid) {
        let mut entries = self
            .inner
            .entries
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        let is_current = entries
            .get(&request_id)
            .is_some_and(|entry| entry.registration_id == registration_id);
        if is_current {
            entries.remove(&request_id);
        }
    }
}

pub(crate) struct RequestRegistration {
    request_id: Uuid,
    registration_id: Uuid,
    token: CancellationToken,
    registry: RequestRegistry,
}

impl RequestRegistration {
    pub(crate) fn token(&self) -> CancellationToken {
        self.token.clone()
    }
}

impl Drop for RequestRegistration {
    fn drop(&mut self) {
        self.registry
            .remove_if_current(self.request_id, self.registration_id);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn entry_count(registry: &RequestRegistry) -> usize {
        registry
            .inner
            .entries
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .len()
    }

    #[test]
    fn registration_guard_removes_the_current_entry_on_every_drop_path() {
        let registry = RequestRegistry::default();
        let request_id = Uuid::new_v4();

        let registration = registry.register(request_id);
        assert_eq!(entry_count(&registry), 1);
        drop(registration);

        assert_eq!(entry_count(&registry), 0);
    }

    #[test]
    fn stale_guard_cannot_remove_a_same_id_replacement() {
        let registry = RequestRegistry::default();
        let request_id = Uuid::new_v4();
        let older = registry.register(request_id);
        let older_token = older.token();

        let replacement = registry.register(request_id);
        let replacement_token = replacement.token();
        assert!(older_token.is_cancelled());
        assert!(!replacement_token.is_cancelled());
        assert_eq!(entry_count(&registry), 1);

        drop(older);
        assert_eq!(entry_count(&registry), 1);
        registry.cancel(request_id);
        assert!(replacement_token.is_cancelled());

        drop(replacement);
        assert_eq!(entry_count(&registry), 0);
    }
}
