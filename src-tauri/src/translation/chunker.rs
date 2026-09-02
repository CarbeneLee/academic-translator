use crate::errors::TranslationDomainError;

use super::{
    derive_mode, normalize_fragments, output_budget, PreparedTranslation, SelectedFragmentInput,
    TranslationChunk, TranslationMode,
};

const DIRECT_REQUEST_MAX_CHARS: usize = 4_000;
const TOTAL_SELECTION_MAX_CHARS: usize = 12_000;
const CHUNK_TARGET_CHARS: usize = 2_500;
const CHUNK_MAX_CHARS: usize = 3_000;

pub fn prepare_translation(
    fragments: &[SelectedFragmentInput],
) -> Result<PreparedTranslation, TranslationDomainError> {
    let normalized_text = normalize_fragments(fragments)?;
    let character_count = normalized_text.chars().count();
    if character_count > TOTAL_SELECTION_MAX_CHARS {
        return Err(TranslationDomainError::SelectionTooLarge);
    }

    let mode = derive_mode(&normalized_text)?;
    let chunks = if character_count <= DIRECT_REQUEST_MAX_CHARS {
        vec![TranslationChunk {
            index: 0,
            max_output_tokens: output_budget(mode, &normalized_text),
            text: normalized_text.clone(),
        }]
    } else {
        chunk_text(&normalized_text, mode)
    };

    Ok(PreparedTranslation {
        normalized_text,
        mode,
        chunks,
    })
}

fn chunk_text(source: &str, mode: TranslationMode) -> Vec<TranslationChunk> {
    let chars = source.chars().collect::<Vec<_>>();
    let mut chunks = Vec::new();
    let mut start = 0;

    while chars.len() - start > CHUNK_MAX_CHARS {
        let window = &chars[start..start + CHUNK_MAX_CHARS];
        let cut = preferred_cut(window).unwrap_or(CHUNK_MAX_CHARS);
        let text = window[..cut].iter().collect::<String>();
        chunks.push(TranslationChunk {
            index: chunks.len(),
            max_output_tokens: output_budget(mode, &text),
            text,
        });
        start += cut;
    }

    let text = chars[start..].iter().collect::<String>();
    if !text.is_empty() {
        chunks.push(TranslationChunk {
            index: chunks.len(),
            max_output_tokens: output_budget(mode, &text),
            text,
        });
    }

    chunks
}

fn preferred_cut(window: &[char]) -> Option<usize> {
    choose_near_target(paragraph_boundaries(window))
        .or_else(|| choose_near_target(sentence_boundaries(window)))
        .or_else(|| choose_near_target(whitespace_boundaries(window)))
}

fn paragraph_boundaries(window: &[char]) -> Vec<usize> {
    window
        .windows(2)
        .enumerate()
        .filter_map(|(index, pair)| (pair == ['\n', '\n']).then_some(index + 2))
        .collect()
}

fn sentence_boundaries(window: &[char]) -> Vec<usize> {
    let mut boundaries = Vec::new();
    let mut index = 0;

    while index < window.len() {
        if !matches!(window[index], '.' | '!' | '?') {
            index += 1;
            continue;
        }

        let mut cursor = index + 1;
        while cursor < window.len()
            && matches!(window[cursor], '"' | '\'' | ')' | ']' | '}' | '’' | '”')
        {
            cursor += 1;
        }
        if cursor >= window.len() || !window[cursor].is_whitespace() {
            index += 1;
            continue;
        }
        while cursor < window.len() && window[cursor].is_whitespace() {
            cursor += 1;
        }
        boundaries.push(cursor);
        index = cursor;
    }

    boundaries
}

fn whitespace_boundaries(window: &[char]) -> Vec<usize> {
    let mut boundaries = Vec::new();
    let mut index = 0;

    while index < window.len() {
        if !window[index].is_whitespace() {
            index += 1;
            continue;
        }
        while index < window.len() && window[index].is_whitespace() {
            index += 1;
        }
        boundaries.push(index);
    }

    boundaries
}

fn choose_near_target(boundaries: Vec<usize>) -> Option<usize> {
    boundaries
        .into_iter()
        .filter(|boundary| *boundary > 0 && *boundary <= CHUNK_MAX_CHARS)
        .min_by_key(|boundary| (boundary.abs_diff(CHUNK_TARGET_CHARS), *boundary))
}
