use unicode_segmentation::UnicodeSegmentation;

use crate::errors::TranslationDomainError;

use super::TranslationMode;

pub fn derive_mode(source: &str) -> Result<TranslationMode, TranslationDomainError> {
    if source.trim().is_empty() {
        return Err(TranslationDomainError::SelectionEmpty);
    }

    let word_count = source.unicode_words().count();
    Ok(if (1..=10).contains(&word_count) {
        TranslationMode::Term
    } else {
        TranslationMode::Passage
    })
}

pub fn output_budget(mode: TranslationMode, source: &str) -> u32 {
    match mode {
        TranslationMode::Term => 128,
        TranslationMode::Passage => {
            let words = source.unicode_words().count() as f64;
            ((words * 2.4 + 64.0).ceil() as u32).clamp(256, 2048)
        }
    }
}
