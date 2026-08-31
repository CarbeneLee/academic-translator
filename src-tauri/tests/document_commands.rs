use std::path::PathBuf;

use academic_translator_lib::document::sessions::DocumentSessionStore;

#[test]
fn descriptor_never_contains_the_selected_path() {
    let store = DocumentSessionStore::default();
    let descriptor = store
        .register(PathBuf::from("/private/papers/a.pdf"), 42)
        .unwrap();
    let json = serde_json::to_string(&descriptor).unwrap();

    assert!(!json.contains("/private/papers"));
    assert_eq!(descriptor.file_name, "a.pdf");
}

#[test]
fn closing_a_session_prevents_future_reads() {
    let store = DocumentSessionStore::default();
    let descriptor = store.register(PathBuf::from("paper.pdf"), 42).unwrap();

    store.close(descriptor.document_session_id);

    assert!(store.path_for(descriptor.document_session_id).is_none());
}
