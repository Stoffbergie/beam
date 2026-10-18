use crate::{api, forward::Target, output};
use anyhow::{bail, Result};
use base64::Engine;
use std::time::Instant;

const SKIPPED: [&str; 7] = [
    "host",
    "content-length",
    "connection",
    "transfer-encoding",
    "keep-alive",
    "x-forwarded-host",
    "x-forwarded-for",
];

pub async fn run(beam: &api::Beam, ids: Vec<u64>, target: &Target) -> Result<()> {
    let ids = if ids.is_empty() {
        match api::list(beam).await?.first() {
            Some(latest) => vec![latest.id],
            None => bail!("{} has not received any requests yet", beam.name),
        }
    } else {
        ids
    };
    let client = reqwest::Client::builder()
        .redirect(reqwest::redirect::Policy::none())
        .build()?;
    for id in ids {
        let detail = api::detail(beam, id).await?;
        if detail.truncated {
            output::note(&format!(
                "request {id} was larger than 1 MB; only the first 1 MB is replayed"
            ));
        }
        let body = if detail.body_encoding == "base64" {
            base64::engine::general_purpose::STANDARD.decode(detail.body)?
        } else {
            detail.body.into_bytes()
        };
        let method = reqwest::Method::from_bytes(detail.method.as_bytes())?;
        let mut request = client.request(method, format!("{}{}", target.http, detail.path));
        for (name, value) in &detail.headers {
            if !SKIPPED.contains(&name.as_str()) {
                request = request.header(name, value);
            }
        }
        let started = Instant::now();
        match request.body(body).send().await {
            Ok(response) => output::request(
                &detail.method,
                &detail.path,
                Some(response.status().as_u16()),
                &output::duration(started.elapsed()),
            ),
            Err(error) => bail!("nothing answered on {}: {error}", target.display),
        }
    }
    Ok(())
}
