use crate::config;
use anyhow::{bail, Context, Result};
use reqwest::{Client, RequestBuilder, Response};
use serde::Deserialize;
use std::time::Duration;

const DEFAULT_URL: &str = "https://beam.stoff.dev";

#[derive(Deserialize)]
pub struct Created {
    pub name: String,
    pub url: String,
    pub key: String,
    pub watch: String,
}

#[derive(Deserialize)]
pub struct Summary {
    pub id: u64,
    pub status: Option<u16>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Detail {
    pub method: String,
    pub path: String,
    pub headers: std::collections::BTreeMap<String, String>,
    pub truncated: bool,
    pub body: String,
    pub body_encoding: String,
}

pub struct Beam {
    pub name: String,
    pub credential: String,
}

pub fn base_url() -> String {
    match std::env::var("BEAM_URL") {
        Ok(url) if !url.is_empty() => url.trim_end_matches('/').to_string(),
        _ => DEFAULT_URL.to_string(),
    }
}

pub fn client() -> Result<Client> {
    Ok(Client::builder()
        .user_agent(concat!("beam/", env!("CARGO_PKG_VERSION")))
        .connect_timeout(Duration::from_secs(15))
        .build()?)
}

pub fn socket_url(name: &str, role: &str) -> String {
    let base = base_url();
    let base = base
        .strip_prefix("https://")
        .map(|rest| format!("wss://{rest}"))
        .or_else(|| {
            base.strip_prefix("http://")
                .map(|rest| format!("ws://{rest}"))
        })
        .unwrap_or(base);
    format!("{base}/{name}/connect?role={role}")
}

pub async fn create(name: Option<&str>, token: Option<&str>) -> Result<Created> {
    let client = client()?;
    let mut url = base_url();
    if let Some(name) = name {
        url = format!("{url}/?name={name}");
    }
    let mut request = client.post(url).header("Accept", "application/json");
    if let Some(token) = token {
        request = request.bearer_auth(token);
    }
    let created: Created = checked(request).await?.json().await?;
    config::remember(&created.name, &created.url, &created.key)?;
    Ok(created)
}

pub async fn list(beam: &Beam) -> Result<Vec<Summary>> {
    let request = client()?
        .get(format!("{}/{}/requests?limit=100", base_url(), beam.name))
        .bearer_auth(&beam.credential);
    Ok(checked(request).await?.json().await?)
}

pub async fn detail(beam: &Beam, id: u64) -> Result<Detail> {
    let request = client()?
        .get(format!("{}/{}/requests/{id}", base_url(), beam.name))
        .bearer_auth(&beam.credential);
    Ok(checked(request).await?.json().await?)
}

pub async fn delete(beam: &Beam) -> Result<()> {
    let request = client()?
        .delete(format!("{}/{}", base_url(), beam.name))
        .bearer_auth(&beam.credential);
    checked(request).await?;
    Ok(())
}

pub fn resolve(input: &str) -> Result<Beam> {
    let (address, fragment) = input.split_once('#').unwrap_or((input, ""));
    let address = address.trim().trim_end_matches('/');
    let name = if let Some(rest) = address.split_once("://").map(|(_, rest)| rest) {
        let host = rest.split('/').next().unwrap_or_default();
        let path_name = rest.split('/').nth(1).unwrap_or_default();
        if path_name.is_empty() {
            host.split('.').next().unwrap_or_default().to_string()
        } else {
            path_name.to_string()
        }
    } else {
        address.to_string()
    };
    if name.is_empty() {
        bail!("give a beam name or URL");
    }
    let saved = config::load()?
        .beams
        .get(&name)
        .map(|saved| saved.key.clone());
    let credential = if !fragment.is_empty() {
        fragment.to_string()
    } else if let Some(key) = saved {
        key
    } else {
        config::token()?.context(
            "this machine has no key for that beam; use its full watch link ending in #key",
        )?
    };
    Ok(Beam { name, credential })
}

async fn checked(request: RequestBuilder) -> Result<Response> {
    let response = request.send().await.context("could not reach beam")?;
    if response.status().is_success() {
        return Ok(response);
    }
    let status = response.status();
    let text = response.text().await.unwrap_or_default();
    bail!("{} ({})", text.trim(), status.as_u16())
}

#[derive(Debug)]
pub struct Refused(pub u16);

impl std::fmt::Display for Refused {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self.0 {
            401 => write!(formatter, "beam refused the key for this beam (401)"),
            403 => write!(formatter, "forwarding needs the owner token and a beam created with it (403); set it with beam config --token <token>"),
            404 => write!(formatter, "that beam does not exist or has expired (404)"),
            code => write!(formatter, "beam refused to connect ({code})"),
        }
    }
}

impl std::error::Error for Refused {}
