use std::sync::OnceLock;

use regex::Regex;

use crate::errors::TranslationDomainError;

use super::SelectedFragmentInput;

pub fn normalize_fragments(
    fragments: &[SelectedFragmentInput],
) -> Result<String, TranslationDomainError> {
    if fragments.is_empty() {
        return Err(TranslationDomainError::SelectionEmpty);
    }

    let mut ordered = fragments.iter().collect::<Vec<_>>();
    ordered.sort_by_key(|fragment| fragment.order);

    let normalized = ordered
        .into_iter()
        .map(|fragment| normalize_fragment(&fragment.text))
        .collect::<Vec<_>>()
        .join("\n\n");

    if normalized.trim().is_empty() {
        return Err(TranslationDomainError::SelectionEmpty);
    }

    Ok(normalized)
}

fn normalize_fragment(source: &str) -> String {
    let line_endings = source.replace("\r\n", "\n").replace('\r', "\n");
    let safe_unicode = line_endings
        .replace('ﬁ', "fi")
        .replace('ﬂ', "fl")
        .replace('\u{00ad}', "");
    let repaired_hyphenation = wrap_hyphen_pattern().replace_all(&safe_unicode, "$1$2");

    collapse_single_line_wraps(&repaired_hyphenation)
        .trim()
        .to_owned()
}

fn wrap_hyphen_pattern() -> &'static Regex {
    static PATTERN: OnceLock<Regex> = OnceLock::new();
    PATTERN.get_or_init(|| {
        Regex::new(r"\b(\p{Latin}{2,})-[ \t]*\n[ \t]*(\p{Latin}{2,})\b")
            .expect("the fixed wrap-hyphen regex must compile")
    })
}

fn collapse_single_line_wraps(source: &str) -> String {
    let chars = source.chars().collect::<Vec<_>>();
    let mut normalized = String::with_capacity(source.len());
    let mut index = 0;

    while index < chars.len() {
        if chars[index] != '\n' {
            normalized.push(chars[index]);
            index += 1;
            continue;
        }

        let mut cursor = index + 1;
        while cursor < chars.len() && is_horizontal_space(chars[cursor]) {
            cursor += 1;
        }

        if cursor < chars.len() && chars[cursor] == '\n' {
            while normalized.ends_with([' ', '\t']) {
                normalized.pop();
            }
            cursor += 1;
            loop {
                while cursor < chars.len() && is_horizontal_space(chars[cursor]) {
                    cursor += 1;
                }
                if cursor >= chars.len() || chars[cursor] != '\n' {
                    break;
                }
                cursor += 1;
            }
            normalized.push_str("\n\n");
            index = cursor;
            continue;
        }

        while normalized.ends_with([' ', '\t']) {
            normalized.pop();
        }
        index = cursor;
        if !normalized.is_empty() && index < chars.len() {
            normalized.push(' ');
        }
    }

    normalized
}

const fn is_horizontal_space(character: char) -> bool {
    matches!(character, ' ' | '\t')
}
