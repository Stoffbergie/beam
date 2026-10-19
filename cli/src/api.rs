const DEFAULT_URL: &str = "https://beam.stoff.dev";

pub fn socket_url(name: &str) -> String {
    let custom = std::env::var("BEAM_URL").ok().filter(|url| !url.is_empty());
    let base = custom
        .as_deref()
        .unwrap_or(DEFAULT_URL)
        .trim_end_matches('/');
    let (scheme, rest) = if let Some(rest) = base.strip_prefix("https://") {
        ("wss://", rest)
    } else if let Some(rest) = base.strip_prefix("http://") {
        ("ws://", rest)
    } else {
        ("", base)
    };
    format!("{scheme}{rest}/{name}/connect")
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
    Ok(bytes.iter().map(|byte| format!("{byte:02x}")).collect())
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
