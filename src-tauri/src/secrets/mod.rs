mod masking;
mod store;

use serde::{Deserialize, Serialize};

pub use masking::mask_secret;
pub use store::{KeyringSecretStore, SecretStore, SecretValue, MAX_CREDENTIAL_SCALARS};

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
mod test_allocator {
    use std::{
        alloc::{GlobalAlloc, Layout, System},
        cell::Cell,
        slice,
    };

    thread_local! {
        static TRACK_MAXIMUM: Cell<bool> = const { Cell::new(false) };
        static MAXIMUM_ALLOCATION: Cell<usize> = const { Cell::new(0) };
        static WATCHED_POINTER: Cell<usize> = const { Cell::new(0) };
        static WATCHED_CAPACITY: Cell<usize> = const { Cell::new(0) };
        static WATCHED_DEALLOCATION_WAS_ZERO: Cell<bool> = const { Cell::new(false) };
    }

    pub struct TestAllocator;

    fn record_allocation(size: usize) {
        TRACK_MAXIMUM.with(|tracking| {
            if tracking.get() {
                MAXIMUM_ALLOCATION.with(|maximum| maximum.set(maximum.get().max(size)));
            }
        });
    }

    unsafe impl GlobalAlloc for TestAllocator {
        unsafe fn alloc(&self, layout: Layout) -> *mut u8 {
            record_allocation(layout.size());
            // SAFETY: the request is forwarded unchanged to the system allocator.
            unsafe { System.alloc(layout) }
        }

        unsafe fn alloc_zeroed(&self, layout: Layout) -> *mut u8 {
            record_allocation(layout.size());
            // SAFETY: the request is forwarded unchanged to the system allocator.
            unsafe { System.alloc_zeroed(layout) }
        }

        unsafe fn realloc(&self, pointer: *mut u8, layout: Layout, new_size: usize) -> *mut u8 {
            record_allocation(new_size);
            // SAFETY: the pointer and original layout came from this allocator and the
            // request is forwarded unchanged to the system allocator.
            unsafe { System.realloc(pointer, layout, new_size) }
        }

        unsafe fn dealloc(&self, pointer: *mut u8, layout: Layout) {
            WATCHED_POINTER.with(|watched_pointer| {
                if watched_pointer.get() == pointer as usize {
                    WATCHED_CAPACITY.with(|watched_capacity| {
                        let capacity = watched_capacity.get();
                        assert!(capacity <= layout.size());
                        // SAFETY: the allocator owns this live allocation until the
                        // delegated deallocation below, and capacity is within layout.
                        let was_zero = unsafe {
                            slice::from_raw_parts(pointer.cast_const(), capacity)
                                .iter()
                                .all(|byte| *byte == 0)
                        };
                        WATCHED_DEALLOCATION_WAS_ZERO.with(|observation| observation.set(was_zero));
                    });
                    watched_pointer.set(0);
                }
            });
            // SAFETY: the pointer and layout came from the system allocator.
            unsafe { System.dealloc(pointer, layout) }
        }
    }

    #[global_allocator]
    static ALLOCATOR: TestAllocator = TestAllocator;

    pub fn maximum_allocation_during<T>(action: impl FnOnce() -> T) -> (T, usize) {
        MAXIMUM_ALLOCATION.with(|maximum| maximum.set(0));
        TRACK_MAXIMUM.with(|tracking| tracking.set(true));
        let result = action();
        TRACK_MAXIMUM.with(|tracking| tracking.set(false));
        let maximum = MAXIMUM_ALLOCATION.with(Cell::get);
        (result, maximum)
    }

    pub fn observe_zeroized_deallocation<T>(
        pointer: *const u8,
        capacity: usize,
        action: impl FnOnce() -> T,
    ) -> (T, bool) {
        WATCHED_DEALLOCATION_WAS_ZERO.with(|observation| observation.set(false));
        WATCHED_CAPACITY.with(|watched_capacity| watched_capacity.set(capacity));
        WATCHED_POINTER.with(|watched_pointer| watched_pointer.set(pointer as usize));
        let result = action();
        let was_deallocated = WATCHED_POINTER.with(Cell::get) == 0;
        let was_zero = WATCHED_DEALLOCATION_WAS_ZERO.with(Cell::get);
        assert!(
            was_deallocated,
            "watched credential allocation was not released"
        );
        (result, was_zero)
    }
}

#[cfg(test)]
mod tests {
    use super::{
        mask_secret,
        test_allocator::{maximum_allocation_during, observe_zeroized_deallocation},
        CredentialKind, CredentialSummary, SecretValue,
    };
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
    fn unicode_masking_allocates_only_the_fixed_suffix_and_result() {
        let secret = format!("sk-{}🔬β文Ω", "学".repeat(10_000));

        let (hint, maximum_allocation) = maximum_allocation_during(|| mask_secret(&secret));

        assert_eq!(hint, "sk-••••••••🔬β文Ω");
        assert!(
            maximum_allocation <= 256,
            "masking allocated an input-sized plaintext buffer of {maximum_allocation} bytes"
        );
    }

    #[test]
    fn credential_scalar_limit_accepts_4096_and_zeroizes_rejected_4097_input() {
        let accepted = "🔐".repeat(4_096);
        assert_eq!(accepted.chars().count(), 4_096);
        let accepted_secret = SecretValue::new(accepted).unwrap();
        assert_eq!(accepted_secret.expose_secret().chars().count(), 4_096);
        drop(accepted_secret);

        let rejected = "🔐".repeat(4_097);
        assert_eq!(rejected.chars().count(), 4_097);
        let pointer = rejected.as_ptr();
        let capacity = rejected.capacity();
        let (error, allocation_was_zeroized) =
            observe_zeroized_deallocation(pointer, capacity, || {
                SecretValue::new(rejected).unwrap_err()
            });

        assert_eq!(error.code(), "CREDENTIAL_VALUE_INVALID");
        assert!(
            allocation_was_zeroized,
            "rejected credential allocation retained plaintext bytes"
        );
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
