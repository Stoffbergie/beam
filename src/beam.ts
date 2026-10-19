import { DurableObject } from "cloudflare:workers";
import type { Env } from "./env";
import { offlinePage } from "./pages";

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

const chunkSize = 256 * 1024;
const responseTimeoutMs = 100_000;
const frame = { requestBody: 1, responseBody: 2, socketMessage: 3 } as const;
const hopByHop = new Set(["connection", "keep-alive", "proxy-connection", "transfer-encoding", "upgrade", "te", "trailer", "content-length"]);

export class Beam extends DurableObject<Env> {
  private forwarder?: WebSocket;
  private connectionToken?: string;
  private pending = new Map<number, Pending>();
  private sockets = new Map<number, Passthrough>();
  private nextStream = 0;

  async alarm(): Promise<void> {
    await this.ctx.storage.deleteAll();
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    if (url.hostname === "beam.internal") return this.attach(request, url.searchParams.get("url") ?? "");
    return this.traffic(request, url);
  }

  private attach(request: Request, publicUrl: string): Response {
    const token = request.headers.get("authorization")?.match(/^Bearer ([a-f0-9]{64})$/)?.[1];
    if (!token) return new Response("Connect with the beam CLI\n", { status: 400 });
    if (this.forwarder && this.connectionToken !== token) return new Response("That beam name is already in use\n", { status: 409 });
    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair);
    server.accept();
    server.binaryType = "arraybuffer";
    const previous = this.forwarder;
    if (previous) {
      previous.close(4000, "Replaced by a newer connection");
      this.forwarderGone(previous);
    }
    this.forwarder = server;
    this.connectionToken = token;
    server.addEventListener("message", (event) => this.fromForwarder(server, event.data));
    server.addEventListener("close", () => this.forwarderGone(server));
    server.addEventListener("error", () => this.forwarderGone(server));
    server.send(JSON.stringify({ t: "hello", url: publicUrl }));
    const protocols = (request.headers.get("sec-websocket-protocol") ?? "").split(",").map((value) => value.trim());
    const headers = protocols.includes("beam") ? { "Sec-WebSocket-Protocol": "beam" } : undefined;
    return new Response(null, { status: 101, webSocket: client, headers });
  }

  private async traffic(request: Request, url: URL): Promise<Response> {
    const forwarder = this.forwarder;
    if (!forwarder) {
      if ((request.headers.get("accept") ?? "").includes("text/html")) {
        return new Response(offlinePage(url.hostname), { status: 503, headers: { "Content-Type": "text/html; charset=utf-8" } });
      }
      return new Response("This beam is offline\n", { status: 502, headers: { "Content-Type": "text/plain; charset=utf-8" } });
    }
    const path = url.pathname + url.search;
    if (request.headers.get("upgrade")?.toLowerCase() === "websocket") return this.passthrough(request, path);

    const stream = ++this.nextStream;
    const response = new Promise<Head | Response>((resolve) => {
      const timer = setTimeout(() => this.fail(stream, 504, "Your local server took too long to answer\n"), responseTimeoutMs);
      this.pending.set(stream, { resolve, timer, streaming: false, chunks: [], done: false });
    });
    forwarder.send(JSON.stringify({ t: "req", id: stream, method: request.method, path, headers: forwardHeaders(request, url), hasBody: request.body !== null }));
    this.ctx.waitUntil(this.pump(forwarder, stream, request.body));
    const head = await response;
    return head instanceof Response ? head : this.streamedResponse(stream, head, forwarder, request.signal);
  }

  private streamedResponse(stream: number, head: Head, forwarder: WebSocket, signal: AbortSignal): Response {
    const headers = new Headers(head.headers.filter(([name]) => !hopByHop.has(name.toLowerCase())));
    let streamController: ReadableStreamDefaultController<Uint8Array>;
    const cancel = () => {
      signal.removeEventListener("abort", abort);
      const entry = this.pending.get(stream);
      if (!entry) return;
      this.pending.delete(stream);
      entry.done = true;
      entry.wake?.();
      if (forwarder.readyState === WebSocket.OPEN) forwarder.send(JSON.stringify({ t: "cancel", id: stream }));
    };
    const abort = () => {
      cancel();
      streamController.error(new Error("The request was cancelled"));
    };
    const body = new ReadableStream<Uint8Array>({
      start: (controller) => {
        streamController = controller;
      },
      pull: async (controller) => {
        const entry = this.pending.get(stream);
        if (!entry) return controller.close();
        while (entry.chunks.length === 0 && !entry.done) await new Promise<void>((resolve) => (entry.wake = resolve));
        if (!this.pending.has(stream)) return;
        const chunk = entry.chunks.shift();
        if (chunk) return controller.enqueue(chunk);
        this.pending.delete(stream);
        signal.removeEventListener("abort", abort);
        if (entry.error) controller.error(new Error(entry.error));
        else controller.close();
      },
      cancel
    });
    if (signal.aborted) abort();
    else signal.addEventListener("abort", abort, { once: true });
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

  private async passthrough(request: Request, path: string): Promise<Response> {
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
      this.forwarder?.send(JSON.stringify({ t: "wsc", id: stream, code: validCloseCode(event.code), reason: event.reason }));
    });
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
      if (status === 101 || status === 204 || status === 205 || status === 304 || status < 200) {
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
    entry.chunks.push(chunk);
    entry.wake?.();
  }

  private forwarderGone(socket: WebSocket): void {
    if (socket !== this.forwarder) return;
    this.forwarder = undefined;
    this.connectionToken = undefined;
    for (const stream of this.pending.keys()) this.fail(stream, 502, "Your machine disconnected\n");
    for (const entry of this.sockets.values()) {
      entry.resolve?.(null);
      entry.socket?.close(1001, "Beam disconnected");
    }
    this.sockets.clear();
  }
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
