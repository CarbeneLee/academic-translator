const MASK: &str = "••••••••";
const VISIBLE_SUFFIX_LENGTH: usize = 4;
const MINIMUM_LENGTH_FOR_HINT: usize = 9;

pub fn mask_secret(secret: &str) -> String {
    let character_count = secret.chars().count();
    if character_count < MINIMUM_LENGTH_FOR_HINT {
        return MASK.to_owned();
    }

    let suffix_start = secret
        .char_indices()
        .nth(character_count - VISIBLE_SUFFIX_LENGTH)
        .map(|(index, _)| index)
        .unwrap_or(secret.len());
    let suffix = &secret[suffix_start..];
    if secret.starts_with("sk-") {
        format!("sk-{MASK}{suffix}")
    } else {
        format!("{MASK}{suffix}")
    }
}
