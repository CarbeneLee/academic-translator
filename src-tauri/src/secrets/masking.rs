const MASK: &str = "••••••••";
const VISIBLE_SUFFIX_LENGTH: usize = 4;
const MINIMUM_LENGTH_FOR_HINT: usize = 9;

pub fn mask_secret(secret: &str) -> String {
    let characters = secret.chars().collect::<Vec<_>>();
    if characters.len() < MINIMUM_LENGTH_FOR_HINT {
        return MASK.to_owned();
    }

    let suffix = characters[characters.len() - VISIBLE_SUFFIX_LENGTH..]
        .iter()
        .collect::<String>();
    if secret.starts_with("sk-") {
        format!("sk-{MASK}{suffix}")
    } else {
        format!("{MASK}{suffix}")
    }
}
