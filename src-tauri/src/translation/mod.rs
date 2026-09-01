mod budget;
mod cache_key;
mod chunker;
mod coordinator;
mod normalizer;
mod provider;
mod request_registry;
mod types;

pub use budget::{derive_mode, output_budget};
pub use cache_key::{cache_key, source_text_hash};
pub use chunker::prepare_translation;
pub use coordinator::TranslationCoordinator;
pub use normalizer::normalize_fragments;
pub use provider::{ProviderRequest, ProviderResult, TokenUsage, TranslationProvider};
pub use request_registry::RequestRegistry;
pub use types::{
    DiagnosticCode, ModelMetadata, PreparedTranslation, ProviderId, SelectedFragmentInput,
    TranslationChunk, TranslationMode, TranslationRequestDto, TranslationResultDto,
    CACHE_KEY_VERSION, NORMALIZATION_VERSION, SOURCE_LANGUAGE, TARGET_LANGUAGE,
};

#[cfg(test)]
mod tests {
    use super::*;

    fn fragment(order: u32, text: impl Into<String>) -> SelectedFragmentInput {
        SelectedFragmentInput {
            id: format!("fragment-{order}"),
            order,
            text: text.into(),
        }
    }

    fn reconstructed_text(prepared: &PreparedTranslation) -> String {
        prepared
            .chunks
            .iter()
            .map(|chunk| chunk.text.as_str())
            .collect()
    }

    #[test]
    fn normalizes_pdf_artifacts_without_inventing_context() {
        let fragments = vec![
            fragment(0, "The efﬁcient co-\nordinate is x = 3.\n\nSee Eq. (2)."),
            fragment(1, "β = 0.5\u{00ad} mol L⁻¹"),
        ];

        assert_eq!(
            normalize_fragments(&fragments).unwrap(),
            "The efficient coordinate is x = 3.\n\nSee Eq. (2).\n\nβ = 0.5 mol L⁻¹"
        );
    }

    #[test]
    fn preserves_user_addition_order_and_rejects_empty_input() {
        let fragments = vec![fragment(1, "second"), fragment(0, "first")];

        assert_eq!(normalize_fragments(&fragments).unwrap(), "first\n\nsecond");
        assert_eq!(
            normalize_fragments(&[]).unwrap_err().code(),
            "SELECTION_EMPTY"
        );
        assert_eq!(
            normalize_fragments(&[fragment(0, " \t\n")])
                .unwrap_err()
                .code(),
            "SELECTION_EMPTY"
        );
    }

    #[test]
    fn preserves_paragraphs_and_non_wrap_hyphens_and_only_converts_approved_ligatures() {
        let fragments = [fragment(
            0,
            "A ﬁne ﬂow and ﬀ.\r\nnext line\n\nco-\n\nordinate\n\n3-\n4; α-\nβ; E = mc² [7].",
        )];

        assert_eq!(
            normalize_fragments(&fragments).unwrap(),
            "A fine flow and ﬀ. next line\n\nco-\n\nordinate\n\n3- 4; α- β; E = mc² [7]."
        );
    }

    #[test]
    fn repairs_only_multi_letter_latin_prose_wraps() {
        let fragments = [fragment(0, "co-\nordinate; multi-\nmodal")];

        assert_eq!(
            normalize_fragments(&fragments).unwrap(),
            "coordinate; multimodal"
        );
    }

    #[test]
    fn preserves_greek_mixed_script_and_single_letter_variable_hyphens() {
        let fragments = [fragment(
            0,
            "α-\nβ; x-\ny; α-\nbeta; alpha-\nβ; x-\nvelocity; value-\ny",
        )];

        assert_eq!(
            normalize_fragments(&fragments).unwrap(),
            "α- β; x- y; α- beta; alpha- β; x- velocity; value- y"
        );
    }

    #[test]
    fn preserves_spaced_blank_lines_and_uses_exact_fragment_separators() {
        let fragments = [
            fragment(1, "\n\nsecond\n\n"),
            fragment(0, "\n\nfirst\n \t\nparagraph\n\n"),
        ];

        assert_eq!(
            normalize_fragments(&fragments).unwrap(),
            "first\n\nparagraph\n\nsecond"
        );
    }

    #[test]
    fn selected_fragment_input_is_strict_camel_case() {
        let input: SelectedFragmentInput =
            serde_json::from_str(r#"{"id":"fragment-1","order":1,"text":"selected"}"#).unwrap();
        assert_eq!(input, fragment(1, "selected"));

        let unknown = serde_json::from_str::<SelectedFragmentInput>(
            r#"{"id":"fragment-1","order":1,"text":"selected","pageText":"context"}"#,
        );
        assert!(unknown.is_err());
    }

    #[test]
    fn derives_modes_and_output_budgets() {
        assert_eq!(
            derive_mode("graph neural network").unwrap(),
            TranslationMode::Term
        );
        assert_eq!(
            derive_mode("one two three four five six seven eight nine ten").unwrap(),
            TranslationMode::Term
        );
        assert_eq!(
            derive_mode("one two three four five six seven eight nine ten eleven").unwrap(),
            TranslationMode::Passage
        );
        assert_eq!(
            output_budget(TranslationMode::Term, "graph neural network"),
            128
        );
        assert_eq!(
            output_budget(TranslationMode::Passage, &"word ".repeat(100)),
            304
        );
        assert_eq!(
            output_budget(TranslationMode::Passage, "short passage"),
            256
        );
        assert_eq!(
            output_budget(TranslationMode::Passage, &"word ".repeat(1_000)),
            2048
        );
        assert_eq!(derive_mode(" \n\t").unwrap_err().code(), "SELECTION_EMPTY");
    }

    #[test]
    fn uses_unicode_scalar_counts_at_all_exact_selection_limits() {
        let at_4000 = prepare_translation(&[fragment(0, "β".repeat(4_000))]).unwrap();
        assert_eq!(at_4000.normalized_text.chars().count(), 4_000);
        assert_eq!(at_4000.chunks.len(), 1);
        assert_eq!(at_4000.chunks[0].text.chars().count(), 4_000);

        let at_4001 = prepare_translation(&[fragment(0, "β".repeat(4_001))]).unwrap();
        assert!(at_4001.chunks.len() > 1);
        assert_eq!(reconstructed_text(&at_4001), at_4001.normalized_text);

        let at_12000 = prepare_translation(&[fragment(0, "β".repeat(12_000))]).unwrap();
        assert_eq!(at_12000.normalized_text.chars().count(), 12_000);
        assert_eq!(reconstructed_text(&at_12000), at_12000.normalized_text);

        let over_limit = prepare_translation(&[fragment(0, "β".repeat(12_001))]).unwrap_err();
        assert_eq!(over_limit.code(), "SELECTION_TOO_LARGE");
    }

    #[test]
    fn chunks_4001_through_12000_chars_sequentially_under_3000() {
        let source = "A complete academic sentence. ".repeat(180);
        let prepared = prepare_translation(&[fragment(0, &source)]).unwrap();

        assert!(prepared.chunks.len() > 1);
        assert!(prepared
            .chunks
            .iter()
            .all(|chunk| !chunk.text.is_empty() && chunk.text.chars().count() <= 3_000));
        assert_eq!(
            prepared
                .chunks
                .iter()
                .map(|chunk| chunk.index)
                .collect::<Vec<_>>(),
            (0..prepared.chunks.len()).collect::<Vec<_>>()
        );
        assert_eq!(reconstructed_text(&prepared), prepared.normalized_text);
        assert!(prepared
            .chunks
            .iter()
            .all(|chunk| { chunk.max_output_tokens == output_budget(prepared.mode, &chunk.text) }));
    }

    #[test]
    fn prefers_paragraph_then_sentence_boundaries_and_preserves_boundary_content() {
        let paragraph_source = format!("{}\n\n{}", "A".repeat(2_400), "B".repeat(2_000));
        let paragraph = prepare_translation(&[fragment(0, &paragraph_source)]).unwrap();
        assert_eq!(paragraph.chunks[0].text.chars().count(), 2_402);
        assert!(paragraph.chunks[0].text.ends_with("\n\n"));
        assert_eq!(reconstructed_text(&paragraph), paragraph.normalized_text);

        let sentence_source = format!("{}Done. {}", "word ".repeat(498), "tail ".repeat(400));
        let sentence = prepare_translation(&[fragment(0, &sentence_source)]).unwrap();
        assert!(sentence.chunks[0].text.ends_with("Done. "));
        assert_eq!(reconstructed_text(&sentence), sentence.normalized_text);
    }

    #[test]
    fn hard_splits_pathological_unicode_text_without_splitting_utf8() {
        let source = "🧪".repeat(7_001);
        let prepared = prepare_translation(&[fragment(0, &source)]).unwrap();

        assert!(prepared
            .chunks
            .iter()
            .all(|chunk| !chunk.text.is_empty() && chunk.text.chars().count() <= 3_000));
        assert_eq!(reconstructed_text(&prepared), source);
        assert_eq!(
            prepared
                .chunks
                .iter()
                .map(|chunk| chunk.index)
                .collect::<Vec<_>>(),
            vec![0, 1, 2]
        );
    }

    #[test]
    fn rejects_more_than_12000_characters_before_provider_work() {
        let error = prepare_translation(&[fragment(0, "a".repeat(12_001))]).unwrap_err();
        assert_eq!(error.code(), "SELECTION_TOO_LARGE");
    }

    #[test]
    fn cache_key_matches_the_version_one_canonical_vector() {
        let metadata = ModelMetadata {
            model_id: "deepseek-v4-flash".into(),
            model_revision: "DeepSeek-V4-Flash-0731".into(),
            prompt_version: "academic-zh-v1".into(),
        };

        assert_eq!(
            source_text_hash("hello"),
            "2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824"
        );
        assert_eq!(
            cache_key("hello", ProviderId::Deepseek, &metadata).unwrap(),
            "5f238604629c4da48ad21885cde4c4d53852a6c3d61e8de6cdd9133301c9b3f3"
        );
    }
}
