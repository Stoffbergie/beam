import { DurableObject } from "cloudflare:workers";
import type { Env } from "./env";
import { offlinePage } from "./pages";

export type BeamMeta = {
  name: string;
  key: string;
  owned: boolean;
  createdAt: number;
};

export type RequestSummary = {
  id: number;
  at: string;
  method: string;
  path: string;
  size: number;
  status: number | null;
  duration: number | null;
  forwarded: boolean;
};

export type RequestDetail = RequestSummary & {
  headers: Record<string, string>;
  truncated: boolean;
  body: string;
  bodyEncoding: "utf8" | "base64";
};

type Row = {
  id: number;
  at: number;
  method: string;
  path: string;
  headers: string;
  body: ArrayBuffer | null;
  size: number;
  truncated: number;
  status: number | null;
  duration: number | null;
  forwarded: number;
};

type Head = { status: number; headers: [string, string][] };

type Pending = {
  resolve: (head: Head | Response) => void;
  timer: ReturnType<typeof setTimeout>;
  streaming: boolean;
  chunks: Uint8Array[];
  done: boolean;
  error?: string;
  wake?: () => void;
};

type Passthrough = {
  socket?: WebSocket;
  resolve?: (accepted: { protocol: string } | null) => void;
};

const ttlMs = 7 * 24 * 60 * 60 * 1000;
const keepRequests = 100;
const maxStoredBody = 1024 * 1024;
const chunkSize = 256 * 1024;
const responseTimeoutMs = 100_000;
const frame = { requestBody: 1, responseBody: 2, socketMessage: 3 } as const;
const hopByHop = new Set(["connection", "keep-alive", "proxy-connection", "transfer-encoding", "upgrade", "te", "trailer", "content-length"]);
const textDecoder = new TextDecoder("utf-8", { fatal: true, ignoreBOM: false });

export class Beam extends DurableObject<Env> {
  private forwarder?: WebSocket;
  private pending = new Map<number, Pending>();
  private sockets = new Map<number, Passthrough>();
  private nextStream = 0;
  private lastBump = 0;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    ctx.storage.sql.exec(`CREATE TABLE IF NOT EXISTS requests (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      at INTEGER NOT NULL,
      method TEXT NOT NULL,
      path TEXT NOT NULL,
      headers TEXT NOT NULL,
      body BLOB,
      size INTEGER NOT NULL,
      truncated INTEGER NOT NULL,
      status INTEGER,
      duration INTEGER,
      forwarded INTEGER NOT NULL
    )`);
  }

  async create(name: string, owned: boolean): Promise<BeamMeta | null> {
    const existing = await this.meta();
    if (existing) return owned && existing.owned ? existing : null;
    const meta: BeamMeta = { name, key: randomKey(), owned, createdAt: Date.now() };
    await this.ctx.storage.put("meta", meta);
    await this.bump(true);
    return meta;
  }

  async meta(): Promise<BeamMeta | undefined> {
    return this.ctx.storage.get<BeamMeta>("meta");
  }

  forwarding(): boolean {
    return this.forwarder !== undefined;
  }

  async expiresAt(): Promise<number | null> {
    return this.ctx.storage.getAlarm();
  }

  list(after: number, limit: number): RequestSummary[] {
    const rows = this.ctx.storage.sql.exec<Row>("SELECT id, at, method, path, size, status, duration, forwarded FROM requests WHERE id > ? ORDER BY id DESC LIMIT ?", after, limit).toArray();
    return rows.map(summary);
  }

  detail(id: number): RequestDetail | null {
    const row = this.ctx.storage.sql.exec<Row>("SELECT * FROM requests WHERE id = ?", id).toArray()[0];
    if (!row) return null;
    const bytes = new Uint8Array(row.body ?? new ArrayBuffer(0));
    let body: string;
    let bodyEncoding: "utf8" | "base64" = "utf8";
    try {
      body = textDecoder.decode(bytes);
    } catch {
      body = toBase64(bytes);
      bodyEncoding = "base64";
    }
    return { ...summary(row), headers: JSON.parse(row.headers) as Record<string, string>, truncated: row.truncated === 1, body, bodyEncoding };
  }

  async remove(): Promise<void> {
    this.disconnectAll();
    await this.ctx.storage.deleteAll();
  }

  async alarm(): Promise<void> {
    if (this.forwarder) {
      await this.ctx.storage.setAlarm(Date.now() + ttlMs);
      return;
    }
    this.disconnectAll();
    await this.ctx.storage.deleteAll();
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    if (url.hostname === "beam.internal") return this.openSocket(request, url.searchParams.get("role"));
    return this.traffic(request, url);
  }

  async webSocketMessage(): Promise<void> {}

  async webSocketClose(socket: WebSocket, code: number): Promise<void> {
    socket.close(code === 1005 ? 1000 : code);
  }

  private async openSocket(request: Request, role: string | null): Promise<Response> {
    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair);
    const protocols = (request.headers.get("sec-websocket-protocol") ?? "").split(",").map((value) => value.trim());
    const headers = protocols.includes("beam") ? { "Sec-WebSocket-Protocol": "beam" } : undefined;

    if (role === "forward") {
      server.accept();
      server.binaryType = "arraybuffer";
      this.forwarder?.close(4000, "Replaced by a newer connection");
      this.forwarder = server;
      server.addEventListener("message", (event) => this.fromForwarder(server, event.data));
      server.addEventListener("close", () => this.forwarderGone(server));
      server.addEventListener("error", () => this.forwarderGone(server));
      this.broadcast({ t: "forwarding", forwarding: true });
    } else {
      this.ctx.acceptWebSocket(server, ["watch"]);
      server.send(JSON.stringify({ t: "hello", forwarding: this.forwarding() }));
    }
    await this.bump(true);
    return new Response(null, { status: 101, webSocket: client, headers });
  }

  private async traffic(request: Request, url: URL): Promise<Response> {
    const meta = await this.meta();
    if (!meta) return new Response("No beam here\n", { status: 404, headers: { "Content-Type": "text/plain; charset=utf-8" } });
    await this.bump(false);

    const started = Date.now();
    const path = url.pathname + url.search;
    const headers = Object.fromEntries([...request.headers].filter(([name]) => !name.startsWith("cf-") && name !== "x-forwarded-proto" && name !== "x-real-ip"));
    const upgrade = request.headers.get("upgrade")?.toLowerCase() === "websocket";
    const forwarder = meta.owned ? this.forwarder : undefined;

    let captured: Promise<{ body: Uint8Array; size: number; truncated: boolean }>;
    let forwardBody: ReadableStream<Uint8Array> | null = null;
    if (request.body && forwarder && !upgrade) {
      const [capture, forward] = request.body.tee();
      captured = capture_(capture);
      forwardBody = forward;
    } else {
      captured = capture_(request.body);
    }

    const id = this.record(request.method, path, headers, forwarder !== undefined);
    if (!forwarder || upgrade) {
      const body = await captured;
      this.storeBody(id, body);
      if (upgrade && forwarder) return this.passthrough(id, request, path, started);
      const offline = meta.owned && (request.headers.get("accept") ?? "").includes("text/html");
      const status = offline ? 503 : 200;
      this.finish(id, status, started);
      if (offline) return new Response(offlinePage(meta.name), { status, headers: { "Content-Type": "text/html; charset=utf-8" } });
      return new Response("ok\n", { status, headers: { "Content-Type": "text/plain; charset=utf-8" } });
    }

    const stream = ++this.nextStream;
    const response = new Promise<Head | Response>((resolve) => {
      const timer = setTimeout(() => this.fail(stream, 504, "Your local server took too long to answer\n"), responseTimeoutMs);
      this.pending.set(stream, { resolve, timer, streaming: false, chunks: [], done: false });
    });
    forwarder.send(JSON.stringify({ t: "req", id: stream, method: request.method, path, headers: forwardHeaders(request, url) }));
    this.ctx.waitUntil(this.pump(forwarder, stream, forwardBody));
    this.ctx.waitUntil(captured.then((body) => this.storeBody(id, body)));

    const head = await response;
    const result = head instanceof Response ? head : this.streamedResponse(stream, head);
    this.finish(id, result.status, started);
    return result;
  }

  private streamedResponse(stream: number, head: Head): Response {
    const headers = new Headers(head.headers.filter(([name]) => !hopByHop.has(name.toLowerCase())));
    const body = new ReadableStream<Uint8Array>({
      pull: async (controller) => {
        const entry = this.pending.get(stream);
        if (!entry) return controller.close();
        while (entry.chunks.length === 0 && !entry.done) await new Promise<void>((resolve) => (entry.wake = resolve));
        const chunk = entry.chunks.shift();
        if (chunk) return controller.enqueue(chunk);
        this.pending.delete(stream);
        if (entry.error) controller.error(new Error(entry.error));
        else controller.close();
      },
      cancel: () => {
        this.pending.delete(stream);
      }
    });
    const encodeBody = headers.has("content-encoding") ? "manual" : "automatic";
    return new Response(body, { status: head.status, headers, encodeBody });
  }

  private async pump(forwarder: WebSocket, stream: number, body: ReadableStream<Uint8Array> | null): Promise<void> {
    try {
      if (body) {
        for await (const chunk of body) {
          for (let offset = 0; offset < chunk.byteLength; offset += chunkSize) {
            forwarder.send(binaryFrame(frame.requestBody, stream, chunk.subarray(offset, offset + chunkSize)));
          }
        }
      }
      forwarder.send(JSON.stringify({ t: "end", id: stream }));
    } catch {
      this.fail(stream, 502, "The request body could not be sent to your machine\n");
    }
  }

  private async passthrough(id: number, request: Request, path: string, started: number): Promise<Response> {
    const forwarder = this.forwarder;
    if (!forwarder) return new Response("This beam is offline\n", { status: 502 });
    const stream = ++this.nextStream;
    const entry: Passthrough = {};
    this.sockets.set(stream, entry);
    const accepted = await new Promise<{ protocol: string } | null>((resolve) => {
      entry.resolve = resolve;
      setTimeout(() => resolve(null), 10_000);
      forwarder.send(
        JSON.stringify({
          t: "ws",
          id: stream,
          path,
          headers: forwardHeaders(request, new URL(request.url)),
          protocols: request.headers.get("sec-websocket-protocol") ?? ""
        })
      );
    });
    if (!accepted) {
      this.sockets.delete(stream);
      this.finish(id, 502, started);
      return new Response("Your local server refused the WebSocket\n", { status: 502 });
    }

    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair);
    server.accept();
    server.binaryType = "arraybuffer";
    entry.socket = server;
    server.addEventListener("message", (event) => {
      if (typeof event.data === "string") this.forwarder?.send(JSON.stringify({ t: "wst", id: stream, data: event.data }));
      else this.forwarder?.send(binaryFrame(frame.socketMessage, stream, new Uint8Array(event.data)));
    });
    server.addEventListener("close", (event) => {
      this.sockets.delete(stream);
      this.forwarder?.send(JSON.stringify({ t: "wsc", id: stream, code: event.code, reason: event.reason }));
    });
    this.finish(id, 101, started);
    const headers = accepted.protocol ? { "Sec-WebSocket-Protocol": accepted.protocol } : undefined;
    return new Response(null, { status: 101, webSocket: client, headers });
  }

  private fromForwarder(socket: WebSocket, data: string | ArrayBuffer): void {
    if (socket !== this.forwarder) return;
    if (typeof data !== "string") {
      const bytes = new Uint8Array(data);
      const view = new DataView(data);
      const type = view.getUint8(0);
      const stream = view.getUint32(1);
      const payload = bytes.subarray(5);
      if (type === frame.responseBody) this.push(stream, payload);
      if (type === frame.socketMessage) this.sockets.get(stream)?.socket?.send(payload);
      return;
    }

    const message = JSON.parse(data) as { t: string; id: number; status?: number; headers?: [string, string][]; message?: string; protocol?: string; data?: string; code?: number; reason?: string };
    const pending = this.pending.get(message.id);
    if (message.t === "res" && pending) {
      clearTimeout(pending.timer);
      const status = message.status ?? 502;
      if (status === 101 || status === 204 || status === 304 || status < 200) {
        this.pending.delete(message.id);
        const headers = new Headers((message.headers ?? []).filter(([name]) => !hopByHop.has(name.toLowerCase())));
        pending.resolve(new Response(null, { status: status < 200 ? 502 : status, headers }));
        return;
      }
      pending.streaming = true;
      pending.resolve({ status, headers: message.headers ?? [] });
    } else if (message.t === "end" && pending) {
      pending.done = true;
      pending.wake?.();
    } else if (message.t === "err" && pending) {
      this.fail(message.id, 502, message.message ?? "Your local server did not answer\n");
    } else if (message.t === "ws-ok") {
      this.sockets.get(message.id)?.resolve?.({ protocol: message.protocol ?? "" });
    } else if (message.t === "ws-fail") {
      this.sockets.get(message.id)?.resolve?.(null);
    } else if (message.t === "wst") {
      this.sockets.get(message.id)?.socket?.send(message.data ?? "");
    } else if (message.t === "wsc") {
      const entry = this.sockets.get(message.id);
      this.sockets.delete(message.id);
      entry?.socket?.close(validCloseCode(message.code), message.reason ?? "");
    }
  }

  private fail(stream: number, status: number, text: string): void {
    const pending = this.pending.get(stream);
    if (!pending) return;
    clearTimeout(pending.timer);
    if (pending.streaming) {
      pending.error = text;
      pending.done = true;
      pending.wake?.();
      return;
    }
    this.pending.delete(stream);
    pending.resolve(new Response(text, { status, headers: { "Content-Type": "text/plain; charset=utf-8" } }));
  }

  private push(stream: number, chunk: Uint8Array): void {
    const entry = this.pending.get(stream);
    if (!entry?.streaming) return;
    entry.chunks.push(chunk.slice());
    entry.wake?.();
  }

  private forwarderGone(socket: WebSocket): void {
    if (socket !== this.forwarder) return;
    this.forwarder = undefined;
    for (const stream of this.pending.keys()) this.fail(stream, 502, "Your machine disconnected\n");
    for (const entry of this.sockets.values()) {
      entry.resolve?.(null);
      entry.socket?.close(1001, "Beam disconnected");
    }
    this.sockets.clear();
    this.broadcast({ t: "forwarding", forwarding: false });
  }

  private disconnectAll(): void {
    this.forwarder?.close(1000, "Beam deleted");
    this.forwarderGone(this.forwarder as WebSocket);
    for (const socket of this.ctx.getWebSockets("watch")) socket.close(1000, "Beam deleted");
  }

  private record(method: string, path: string, headers: Record<string, string>, forwarded: boolean): number {
    const at = Date.now();
    const id = this.ctx.storage.sql
      .exec<{ id: number }>(
        "INSERT INTO requests (at, method, path, headers, size, truncated, forwarded) VALUES (?, ?, ?, ?, 0, 0, ?) RETURNING id",
        at,
        method,
        path,
        JSON.stringify(headers),
        forwarded ? 1 : 0
      )
      .one().id;
    this.ctx.storage.sql.exec("DELETE FROM requests WHERE id <= ?", id - keepRequests);
    this.broadcast({ t: "request", request: summary({ id, at, method, path, size: 0, status: null, duration: null, forwarded: forwarded ? 1 : 0 } as Row) });
    return id;
  }

  private storeBody(id: number, captured: { body: Uint8Array; size: number; truncated: boolean }): void {
    this.ctx.storage.sql.exec("UPDATE requests SET body = ?, size = ?, truncated = ? WHERE id = ?", captured.body, captured.size, captured.truncated ? 1 : 0, id);
    this.broadcast({ t: "size", id, size: captured.size });
  }

  private finish(id: number, status: number, started: number): void {
    const duration = Date.now() - started;
    this.ctx.storage.sql.exec("UPDATE requests SET status = ?, duration = ? WHERE id = ?", status, duration, id);
    this.broadcast({ t: "status", id, status, duration });
  }

  private broadcast(message: unknown): void {
    const text = JSON.stringify(message);
    for (const socket of this.ctx.getWebSockets("watch")) {
      try {
        socket.send(text);
      } catch {
        socket.close(1011, "Send failed");
      }
    }
  }

  private async bump(force: boolean): Promise<void> {
    const now = Date.now();
    if (!force && now - this.lastBump < 60 * 60 * 1000) return;
    this.lastBump = now;
    await this.ctx.storage.setAlarm(now + ttlMs);
  }
}

async function capture_(body: ReadableStream<Uint8Array> | null): Promise<{ body: Uint8Array; size: number; truncated: boolean }> {
  if (!body) return { body: new Uint8Array(0), size: 0, truncated: false };
  const chunks: Uint8Array[] = [];
  let stored = 0;
  let size = 0;
  for await (const chunk of body) {
    size += chunk.byteLength;
    if (stored < maxStoredBody) {
      const part = chunk.subarray(0, maxStoredBody - stored);
      chunks.push(part);
      stored += part.byteLength;
    }
  }
  const bytes = new Uint8Array(stored);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return { body: bytes, size, truncated: size > stored };
}

function forwardHeaders(request: Request, url: URL): [string, string][] {
  const headers = [...request.headers].filter(
    ([name]) => !name.startsWith("cf-") && !name.startsWith("x-forwarded-") && (!hopByHop.has(name) || name === "content-length") && name !== "host" && name !== "x-real-ip"
  );
  headers.push(["x-forwarded-host", url.host], ["x-forwarded-proto", "https"]);
  const address = request.headers.get("cf-connecting-ip");
  if (address) headers.push(["x-forwarded-for", address]);
  if (request.headers.get("upgrade")) headers.push(["upgrade", request.headers.get("upgrade") ?? ""]);
  return headers;
}

function summary(row: Row): RequestSummary {
  return {
    id: row.id,
    at: new Date(row.at).toISOString(),
    method: row.method,
    path: row.path,
    size: row.size,
    status: row.status,
    duration: row.duration,
    forwarded: row.forwarded === 1
  };
}

function binaryFrame(type: number, stream: number, payload: Uint8Array): Uint8Array {
  const bytes = new Uint8Array(5 + payload.byteLength);
  const view = new DataView(bytes.buffer);
  view.setUint8(0, type);
  view.setUint32(1, stream);
  bytes.set(payload, 5);
  return bytes;
}

function validCloseCode(code: number | undefined): number {
  if (code === 1000 || (code !== undefined && code >= 3000 && code <= 4999)) return code;
  return 1000;
}

function randomKey(): string {
  return toBase64(crypto.getRandomValues(new Uint8Array(18)))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

function toBase64(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}
