use sha2::{Digest, Sha256};

pub(super) fn truncate_for_sign(input: &str) -> String {
    let characters = input.chars().collect::<Vec<_>>();
    if characters.len() <= 20 {
        return input.to_owned();
    }

    let prefix = characters[..10].iter().collect::<String>();
    let suffix = characters[characters.len() - 10..]
        .iter()
        .collect::<String>();
    format!("{prefix}{}{suffix}", characters.len())
}

pub(super) fn sign_v3(
    app_id: &str,
    query: &str,
    salt: &str,
    current_time: &str,
    app_secret: &str,
) -> String {
    let truncated = truncate_for_sign(query);
    let mut hasher = Sha256::new();
    hasher.update(app_id.as_bytes());
    hasher.update(truncated.as_bytes());
    hasher.update(salt.as_bytes());
    hasher.update(current_time.as_bytes());
    hasher.update(app_secret.as_bytes());
    hex::encode(hasher.finalize())
}
