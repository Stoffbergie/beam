use crate::{api, output};
use anyhow::{anyhow, bail, Result};
use bytes::Bytes;
use futures_channel::mpsc;
use futures_util::{SinkExt, StreamExt};
use serde::{Deserialize, Serialize};
use serde_json::json;
use std::borrow::Cow;
use std::collections::HashMap;
use std::sync::Arc;
use std::time::{Duration, Instant};
use tokio::task::AbortHandle;
use tokio_tungstenite::tungstenite::{
    client::IntoClientRequest,
    http::{HeaderName, HeaderValue},
    Message,
};

const REQUEST_BODY: u8 = 1;
const RESPONSE_BODY: u8 = 2;
const SOCKET_MESSAGE: u8 = 3;
const CHUNK: usize = 256 * 1024;
const BUFFERED_BODY: usize = 32 * 1024 * 1024;
const SKIPPED_REQUEST: [&str; 6] = [
    "host",
    "connection",
    "keep-alive",
    "transfer-encoding",
    "upgrade",
    "content-length",
];
const SKIPPED_SOCKET: [&str; 8] = [
    "host",
    "connection",
    "upgrade",
    "sec-websocket-key",
    "sec-websocket-version",
    "sec-websocket-extensions",
    "content-length",
    "transfer-encoding",
];

pub struct Target {
    pub http: String,
    pub socket: String,
    pub display: String,
    pub port: Option<u16>,
}

impl Target {
    pub fn parse(input: &str) -> Result<Self> {
        let input = input.trim().trim_end_matches('/');
        if let Ok(port) = input.parse::<u16>() {
            return Ok(Self {
                http: format!("http://localhost:{port}"),
                socket: format!("ws://localhost:{port}"),
                display: format!("localhost:{port}"),
                port: Some(port),
            });
        }
        let http = if input.contains("://") {
            input.to_string()
        } else {
            format!("http://{input}")
        };
        let rest = http
            .split_once("://")
            .map(|(_, rest)| rest.to_string())
            .ok_or_else(|| anyhow!("could not read {input} as a port or URL"))?;
        let socket = if http.starts_with("https://") {
            format!("wss://{rest}")
        } else {
            format!("ws://{rest}")
        };
        let port = rest
            .split('/')
            .next()
            .and_then(|host| host.rsplit_once(':'))
            .and_then(|(_, port)| port.parse().ok());
        Ok(Self {
            http,
            socket,
            display: rest,
            port,
        })
    }
}

#[derive(Deserialize)]
struct Control<'a> {
    #[serde(borrow)]
    t: Cow<'a, str>,
    #[serde(default)]
    id: u32,
    url: Option<String>,
    method: Option<String>,
    #[serde(rename = "hasBody")]
    has_body: Option<bool>,
    path: Option<String>,
    headers: Option<Vec<(String, String)>>,
    data: Option<String>,
    code: Option<u16>,
    reason: Option<String>,
}

type Outbox = mpsc::UnboundedSender<Message>;

#[derive(Serialize)]
#[serde(tag = "t")]
enum Outgoing<'a> {
    #[serde(rename = "res")]
    Head {
        id: u32,
        status: u16,
        headers: Vec<(String, String)>,
    },
    #[serde(rename = "end")]
    End { id: u32 },
    #[serde(rename = "ws-fail")]
    SocketFailed { id: u32 },
    #[serde(rename = "ws-ok")]
    SocketReady { id: u32, protocol: &'a str },
    #[serde(rename = "wst")]
    SocketText { id: u32, data: &'a str },
    #[serde(rename = "wsc")]
    SocketClosed { id: u32, code: u16, reason: &'a str },
}

pub async fn run(name: &str, token: &str, target: Target) -> Result<()> {
    let target = Arc::new(target);
    let mut delay = 1;
    let mut announced = false;
    loop {
        let started = Instant::now();
        match session(name, token, &target, &mut announced).await {
            Err(error) if error.downcast_ref::<api::Refused>().is_some() => return Err(error),
            Err(error) => output::note(&format!("Disconnected: {error}. Reconnecting…")),
            Ok(()) => output::note("Disconnected. Reconnecting…"),
        }
        if started.elapsed() > Duration::from_secs(30) {
            delay = 1;
        }
        tokio::time::sleep(Duration::from_secs(delay)).await;
        delay = (delay * 2).min(30);
    }
}

async fn session(
    name: &str,
    token: &str,
    target: &Arc<Target>,
    announced: &mut bool,
) -> Result<()> {
    let mut request = api::socket_url(name).into_client_request()?;
    request.headers_mut().insert(
        "Authorization",
        HeaderValue::from_str(&format!("Bearer {token}"))?,
    );
    let socket = match tokio_tungstenite::connect_async(request).await {
        Ok((socket, _)) => socket,
        Err(tokio_tungstenite::tungstenite::Error::Http(response)) => {
            return Err(api::Refused(response.status().as_u16()).into())
        }
        Err(error) => return Err(error.into()),
    };
    let (mut sink, mut stream) = socket.split();
    let (outbox, inbox) = mpsc::unbounded::<Message>();

    let writer = tokio::spawn(async move {
        let mut messages = inbox.map(Ok);
        let _ = sink.send_all(&mut messages).await;
    });
    let pinger = {
        let outbox = outbox.clone();
        tokio::spawn(async move {
            loop {
                tokio::time::sleep(Duration::from_secs(25)).await;
                if outbox
                    .unbounded_send(Message::text(r#"{"t":"ping"}"#))
                    .is_err()
                {
                    break;
                }
            }
        })
    };

    let client = reqwest::Client::builder()
        .redirect(reqwest::redirect::Policy::none())
        .build()?;
    let mut bodies: HashMap<u32, mpsc::Sender<Result<Bytes, std::io::Error>>> = HashMap::new();
    let mut sockets: HashMap<u32, (Outbox, AbortHandle)> = HashMap::new();
    let mut tasks: HashMap<u32, AbortHandle> = HashMap::new();

    let result = loop {
        let Some(message) = stream.next().await else {
            break Ok(());
        };
        let message = match message {
            Ok(message) => message,
            Err(error) => break Err(error.into()),
        };
        match message {
            Message::Binary(bytes) if bytes.len() >= 5 => {
                let kind = bytes[0];
                let id = u32::from_be_bytes([bytes[1], bytes[2], bytes[3], bytes[4]]);
                let payload = bytes.slice(5..);
                if kind == REQUEST_BODY {
                    if let Some(body) = bodies.get_mut(&id) {
                        let _ = body.send(Ok(payload)).await;
                    }
                } else if kind == SOCKET_MESSAGE {
                    if let Some((local, _)) = sockets.get(&id) {
                        let _ = local.unbounded_send(Message::Binary(payload));
                    }
                }
            }
            Message::Text(text) => {
                let Ok(control) = serde_json::from_str::<Control>(&text) else {
                    continue;
                };
                match control.t.as_ref() {
                    "req" => {
                        let method = control.method.unwrap_or_else(|| "GET".to_string());
                        let headers = control.headers.unwrap_or_default();
                        let length = headers
                            .iter()
                            .find(|(name, _)| name.eq_ignore_ascii_case("content-length"))
                            .and_then(|(_, value)| value.parse::<u64>().ok());
                        let has_body = control.has_body.unwrap_or_else(|| {
                            length.map(|length| length > 0).unwrap_or(!matches!(
                                method.as_str(),
                                "GET" | "HEAD" | "OPTIONS" | "DELETE"
                            ))
                        });
                        let body = if has_body {
                            let (sender, receiver) = mpsc::channel(16);
                            bodies.insert(control.id, sender);
                            Some(receiver)
                        } else {
                            None
                        };
                        let task = tokio::spawn(proxy(
                            client.clone(),
                            target.clone(),
                            control.id,
                            method,
                            control.path.unwrap_or_else(|| "/".to_string()),
                            headers,
                            body,
                            outbox.clone(),
                        ));
                        tasks.insert(control.id, task.abort_handle());
                    }
                    "end" => {
                        bodies.remove(&control.id);
                    }
                    "cancel" => {
                        bodies.remove(&control.id);
                        if let Some(task) = tasks.remove(&control.id) {
                            task.abort();
                        }
                        if let Some((_, task)) = sockets.remove(&control.id) {
                            task.abort();
                        }
                    }
                    "ws" => {
                        let (local, receiver) = mpsc::unbounded::<Message>();
                        let task = tokio::spawn(passthrough(
                            target.clone(),
                            control.id,
                            control.path.unwrap_or_else(|| "/".to_string()),
                            control.headers.unwrap_or_default(),
                            receiver,
                            outbox.clone(),
                        ));
                        sockets.insert(control.id, (local, task.abort_handle()));
                    }
                    "wst" => {
                        if let Some((local, _)) = sockets.get(&control.id) {
                            let _ = local
                                .unbounded_send(Message::text(control.data.unwrap_or_default()));
                        }
                    }
                    "wsc" => {
                        if let Some((local, _)) = sockets.remove(&control.id) {
                            let frame = control.code.filter(|code| sendable(*code)).map(|code| {
                                tokio_tungstenite::tungstenite::protocol::CloseFrame {
                                    code: code.into(),
                                    reason: control.reason.unwrap_or_default().into(),
                                }
                            });
                            let _ = local.unbounded_send(Message::Close(frame));
                        }
                    }
                    "hello" => {
                        if *announced {
                            output::note("Reconnected");
                        } else if let Some(url) = control.url {
                            println!("{url} → {}", target.display);
                            output::note("Stop anytime: Ctrl+C");
                            *announced = true;
                        }
                    }
                    _ => {}
                }
            }
            Message::Close(frame) => {
                if let Some(frame) = frame {
                    if u16::from(frame.code) == 4000 {
                        break Err(api::Refused(4000).into());
                    }
                }
                break Ok(());
            }
            _ => {}
        }
        tasks.retain(|_, task| !task.is_finished());
    };

    for (_, task) in tasks {
        task.abort();
    }
    for (_, (_, task)) in sockets {
        task.abort();
    }
    pinger.abort();
    writer.abort();
    result
}

#[allow(clippy::too_many_arguments)]
async fn proxy(
    client: reqwest::Client,
    target: Arc<Target>,
    id: u32,
    method: String,
    path: String,
    headers: Vec<(String, String)>,
    body: Option<mpsc::Receiver<Result<Bytes, std::io::Error>>>,
    outbox: Outbox,
) {
    let started = Instant::now();
    let Ok(verb) = reqwest::Method::from_bytes(method.as_bytes()) else {
        let _ = outbox.unbounded_send(control(
            json!({"t": "err", "id": id, "message": "Unsupported method\n"}),
        ));
        return;
    };
    let length = headers
        .iter()
        .find(|(name, _)| name.eq_ignore_ascii_case("content-length"))
        .and_then(|(_, value)| value.parse::<usize>().ok());
    let mut request = client.request(verb, format!("{}{}", target.http, path));
    for (name, value) in headers {
        if SKIPPED_REQUEST
            .iter()
            .any(|skipped| name.eq_ignore_ascii_case(skipped))
        {
            continue;
        }
        request = request.header(name, value);
    }
    if let Some(mut body) = body {
        match length {
            Some(length) if length <= BUFFERED_BODY => {
                let mut bytes = Bytes::new();
                while let Some(Ok(chunk)) = body.next().await {
                    if bytes.is_empty() && chunk.len() == length {
                        bytes = chunk;
                        continue;
                    }
                    let mut joined = Vec::with_capacity(length);
                    joined.extend_from_slice(&bytes);
                    joined.extend_from_slice(&chunk);
                    drop(bytes);
                    drop(chunk);
                    while let Some(Ok(chunk)) = body.next().await {
                        joined.extend_from_slice(&chunk);
                    }
                    bytes = joined.into();
                    break;
                }
                request = request.body(bytes);
            }
            _ => request = request.body(reqwest::Body::wrap_stream(body)),
        }
    }

    let response = match request.send().await {
        Ok(response) => response,
        Err(error) => {
            let message = format!(
                "Nothing answered on {}: {}\n",
                target.display,
                root_cause(&error)
            );
            let _ =
                outbox.unbounded_send(control(json!({"t": "err", "id": id, "message": message})));
            output::request(
                &method,
                &path,
                Some(502),
                &format!("nothing answered on {}", target.display),
            );
            return;
        }
    };

    let status = response.status().as_u16();
    let response_headers: Vec<(String, String)> = response
        .headers()
        .iter()
        .map(|(name, value)| {
            (
                name.to_string(),
                String::from_utf8_lossy(value.as_bytes()).to_string(),
            )
        })
        .collect();
    let _ = outbox.unbounded_send(control(Outgoing::Head {
        id,
        status,
        headers: response_headers,
    }));
    let mut stream = response.bytes_stream();
    while let Some(chunk) = stream.next().await {
        match chunk {
            Ok(chunk) => {
                for part in chunk.chunks(CHUNK) {
                    let _ = outbox.unbounded_send(frame(RESPONSE_BODY, id, part));
                }
            }
            Err(error) => {
                let _ = outbox.unbounded_send(control(
                    json!({"t": "err", "id": id, "message": error.to_string()}),
                ));
                return;
            }
        }
    }
    let _ = outbox.unbounded_send(control(Outgoing::End { id }));
    output::request(
        &method,
        &path,
        Some(status),
        &output::duration(started.elapsed()),
    );
}

async fn passthrough(
    target: Arc<Target>,
    id: u32,
    path: String,
    headers: Vec<(String, String)>,
    mut from_beam: mpsc::UnboundedReceiver<Message>,
    outbox: Outbox,
) {
    let fail = |outbox: &Outbox| {
        let _ = outbox.unbounded_send(control(Outgoing::SocketFailed { id }));
    };
    let Ok(mut request) = format!("{}{}", target.socket, path).into_client_request() else {
        return fail(&outbox);
    };
    for (name, value) in headers {
        if SKIPPED_SOCKET
            .iter()
            .any(|skipped| name.eq_ignore_ascii_case(skipped))
        {
            continue;
        }
        if let (Ok(name), Ok(value)) = (
            HeaderName::try_from(name.as_str()),
            HeaderValue::try_from(value),
        ) {
            request.headers_mut().insert(name, value);
        }
    }
    let (socket, response) = match tokio_tungstenite::connect_async(request).await {
        Ok(connected) => connected,
        Err(_) => {
            output::request(
                "WS",
                &path,
                Some(502),
                &format!("nothing answered on {}", target.display),
            );
            return fail(&outbox);
        }
    };
    let protocol = response
        .headers()
        .get("sec-websocket-protocol")
        .and_then(|value| value.to_str().ok())
        .unwrap_or_default();
    let _ = outbox.unbounded_send(control(Outgoing::SocketReady { id, protocol }));
    output::request("WS", &path, Some(101), "connected");

    let (mut local_sink, mut local_stream) = socket.split();
    loop {
        tokio::select! {
            message = from_beam.next() => match message {
                Some(Message::Close(frame)) => {
                    let _ = local_sink.send(Message::Close(frame)).await;
                    break;
                }
                Some(message) => {
                    if local_sink.send(message).await.is_err() {
                        break;
                    }
                }
                None => break,
            },
            message = local_stream.next() => match message {
                Some(Ok(Message::Text(text))) => {
                    let _ = outbox.unbounded_send(control(Outgoing::SocketText { id, data: text.as_str() }));
                }
                Some(Ok(Message::Binary(bytes))) => {
                    let _ = outbox.unbounded_send(frame(SOCKET_MESSAGE, id, &bytes));
                }
                Some(Ok(Message::Close(frame))) => {
                    let (code, reason) = match frame.as_ref() {
                        Some(frame) => (u16::from(frame.code), frame.reason.as_str()),
                        None => (1000, ""),
                    };
                    let _ = outbox.unbounded_send(control(Outgoing::SocketClosed { id, code, reason }));
                    break;
                }
                Some(Ok(_)) => {}
                Some(Err(_)) | None => {
                    let _ = outbox.unbounded_send(control(Outgoing::SocketClosed { id, code: 1001, reason: "" }));
                    break;
                }
            },
        }
    }
}

pub async fn wait_for_port(target: &Target, child: &mut tokio::process::Child) -> Result<()> {
    let Some(port) = target.port else {
        return Ok(());
    };
    let started = Instant::now();
    while started.elapsed() < Duration::from_secs(60) {
        if tokio::net::TcpStream::connect(("localhost", port))
            .await
            .is_ok()
        {
            return Ok(());
        }
        if let Some(status) = child.try_wait()? {
            bail!("the command exited ({status}) before port {port} opened");
        }
        tokio::time::sleep(Duration::from_millis(250)).await;
    }
    output::note(&format!(
        "Port {port} is not open after 60 seconds; sharing it anyway."
    ));
    Ok(())
}

fn sendable(code: u16) -> bool {
    matches!(code, 1000..=1003 | 1007..=1014 | 3000..=4999)
}

fn control(value: impl Serialize) -> Message {
    Message::text(serde_json::to_string(&value).expect("control messages serialize to JSON"))
}

fn frame(kind: u8, id: u32, payload: &[u8]) -> Message {
    let mut bytes = Vec::with_capacity(5 + payload.len());
    bytes.push(kind);
    bytes.extend_from_slice(&id.to_be_bytes());
    bytes.extend_from_slice(payload);
    Message::binary(bytes)
}

fn root_cause(error: &reqwest::Error) -> &dyn std::error::Error {
    let mut source: &dyn std::error::Error = error;
    while let Some(next) = source.source() {
        source = next;
    }
    source
}
