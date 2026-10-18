use crate::{api, output};
use anyhow::Result;
use futures_util::StreamExt;
use serde::Deserialize;
use std::collections::HashMap;
use std::time::Duration;
use tokio_tungstenite::tungstenite::{client::IntoClientRequest, http::HeaderValue, Message};

#[derive(Deserialize)]
struct Event {
    t: String,
    id: Option<u64>,
    status: Option<u16>,
    size: Option<u64>,
    request: Option<Request>,
}

#[derive(Deserialize)]
struct Request {
    id: u64,
    method: String,
    path: String,
}

pub async fn run(beam: &api::Beam) -> Result<()> {
    let mut delay = 1;
    loop {
        match session(beam).await {
            Ok(()) => delay = 1,
            Err(error) if error.downcast_ref::<api::Refused>().is_some() => return Err(error),
            Err(error) => output::note(&format!("Disconnected: {error}")),
        }
        tokio::time::sleep(Duration::from_secs(delay)).await;
        delay = (delay * 2).min(30);
    }
}

async fn session(beam: &api::Beam) -> Result<()> {
    let mut request = api::socket_url(&beam.name, "watch").into_client_request()?;
    request.headers_mut().insert(
        "Authorization",
        HeaderValue::from_str(&format!("Bearer {}", beam.credential))?,
    );
    let (mut socket, _) = match tokio_tungstenite::connect_async(request).await {
        Ok(connected) => connected,
        Err(tokio_tungstenite::tungstenite::Error::Http(response)) => {
            return Err(api::Refused(response.status().as_u16()).into())
        }
        Err(error) => return Err(error.into()),
    };
    let mut seen: HashMap<u64, (Request, Option<u64>)> = HashMap::new();
    while let Some(message) = socket.next().await {
        let Message::Text(text) = message? else {
            continue;
        };
        let Ok(event) = serde_json::from_str::<Event>(&text) else {
            continue;
        };
        match event.t.as_str() {
            "request" => {
                if let Some(request) = event.request {
                    seen.insert(request.id, (request, None));
                }
            }
            "size" => {
                if let Some(entry) = event.id.and_then(|id| seen.get_mut(&id)) {
                    entry.1 = event.size;
                }
            }
            "status" => {
                if let Some((request, size)) = event.id.and_then(|id| seen.remove(&id)) {
                    let detail = size.map(output::size).unwrap_or_default();
                    output::request(&request.method, &request.path, event.status, &detail);
                }
            }
            _ => {}
        }
    }
    Ok(())
}
