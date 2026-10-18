use anyhow::{Context, Result};
use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;
use std::io::ErrorKind;
use std::path::PathBuf;

#[derive(Default, Deserialize, Serialize)]
#[serde(default)]
pub struct Config {
    pub token: Option<String>,
    pub beams: BTreeMap<String, Saved>,
}

#[derive(Clone, Deserialize, Serialize)]
pub struct Saved {
    pub url: String,
    pub key: String,
}

pub fn load() -> Result<Config> {
    let path = path()?;
    match std::fs::read(&path) {
        Ok(bytes) => serde_json::from_slice(&bytes)
            .with_context(|| format!("could not read {}", path.display())),
        Err(error) if error.kind() == ErrorKind::NotFound => Ok(Config::default()),
        Err(error) => Err(error.into()),
    }
}

pub fn save(config: &Config) -> Result<()> {
    let path = path()?;
    std::fs::create_dir_all(path.parent().context("config directory is missing")?)?;
    let partial = path.with_extension("json.part");
    std::fs::write(&partial, serde_json::to_vec_pretty(config)?)?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(&partial, std::fs::Permissions::from_mode(0o600))?;
    }
    std::fs::rename(partial, &path)?;
    Ok(())
}

pub fn token() -> Result<Option<String>> {
    if let Ok(token) = std::env::var("BEAM_TOKEN") {
        if !token.is_empty() {
            return Ok(Some(token));
        }
    }
    Ok(load()?.token)
}

pub fn remember(name: &str, url: &str, key: &str) -> Result<()> {
    let mut config = load()?;
    config.beams.insert(
        name.to_string(),
        Saved {
            url: url.to_string(),
            key: key.to_string(),
        },
    );
    save(&config)
}

pub fn edit(token: Option<String>) -> Result<()> {
    let mut config = load()?;
    if let Some(token) = token {
        config.token = if token.is_empty() { None } else { Some(token) };
        save(&config)?;
    }
    let shown = match &config.token {
        Some(token) if token.len() > 8 => format!("{}…", &token[..6]),
        Some(_) => "set".to_string(),
        None => "not set".to_string(),
    };
    println!("token: {shown}");
    println!("config: {}", path()?.display());
    Ok(())
}

fn path() -> Result<PathBuf> {
    Ok(dirs::config_dir()
        .context("could not find a config directory")?
        .join("beam/config.json"))
}
