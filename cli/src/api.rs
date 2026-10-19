use std::fmt::Write;

const DEFAULT_URL: &str = "https://beam.stoff.dev";

pub fn base_url() -> String {
    match std::env::var("BEAM_URL") {
        Ok(url) if !url.is_empty() => url.trim_end_matches('/').to_string(),
        _ => DEFAULT_URL.to_string(),
    }
}

pub fn socket_url(name: &str) -> String {
    let base = base_url();
    let base = base
        .strip_prefix("https://")
        .map(|rest| format!("wss://{rest}"))
        .or_else(|| {
            base.strip_prefix("http://")
                .map(|rest| format!("ws://{rest}"))
        })
        .unwrap_or(base);
    format!("{base}/{name}/connect")
}

pub fn random_name() -> anyhow::Result<String> {
    const ALPHABET: &[u8] = b"23456789abcdefghjkmnpqrstuvwxyz";
    let mut name = String::new();
    while name.len() < 8 {
        let mut bytes = [0u8; 8];
        getrandom::fill(&mut bytes).map_err(|error| anyhow::anyhow!("{error}"))?;
        for byte in bytes {
            if byte < 248 && name.len() < 8 {
                name.push(ALPHABET[byte as usize % ALPHABET.len()] as char);
            }
        }
    }
    Ok(name)
}

pub fn connection_token() -> anyhow::Result<String> {
    let mut bytes = [0u8; 32];
    getrandom::fill(&mut bytes).map_err(|error| anyhow::anyhow!("{error}"))?;
    let mut token = String::with_capacity(bytes.len() * 2);
    for byte in bytes {
        write!(token, "{byte:02x}")?;
    }
    Ok(token)
}

#[derive(Debug)]
pub struct Refused(pub u16);

impl std::fmt::Display for Refused {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self.0 {
            400 => write!(
                formatter,
                "names use 1-32 lowercase letters, digits and dashes (400)"
            ),
            409 => write!(
                formatter,
                "that beam name is already in use; choose another with --name (409)"
            ),
            4000 => write!(formatter, "another beam took over this name"),
            code => write!(formatter, "beam refused to connect ({code})"),
        }
    }
}

impl std::error::Error for Refused {}
