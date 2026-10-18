import { spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { createServer, request as httpRequest, type IncomingHttpHeaders, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { inject } from "vite-plus/test";
import { WebSocket, WebSocketServer, type RawData } from "ws";

export const baseUrl = inject("baseUrl");
export const tunnelDomain = inject("tunnelDomain");
export const ownerToken = inject("ownerToken");
const cliPath = inject("cli");
const serverPort = new URL(baseUrl).port;

export type Created = { name: string; url: string; key: string; watch: string; owned: boolean };
export type Reply = { status: number; headers: IncomingHttpHeaders; text: string };
export type Summary = { id: number; method: string; path: string; size: number; status: number | null; forwarded: boolean };
export type Detail = Summary & { headers: Record<string, string>; body: string; bodyEncoding: string; truncated: boolean };

export async function createBeam(options: { token?: string; name?: string } = {}): Promise<Created> {
  const query = options.name ? `?name=${options.name}` : "";
  const headers: Record<string, string> = { Accept: "application/json" };
  if (options.token) headers.Authorization = `Bearer ${options.token}`;
  const response = await fetch(`${baseUrl}/${query}`, { method: "POST", headers });
  if (response.status !== 201) throw new Error(`create failed: ${response.status} ${await response.text()}`);
  return (await response.json()) as Created;
}

export function traffic(name: string, path: string, init: { method?: string; headers?: Record<string, string>; body?: string } = {}): Promise<Reply> {
  return new Promise((resolve, reject) => {
    const length = init.body === undefined ? {} : { "content-length": String(Buffer.byteLength(init.body)) };
    const headers = { ...length, ...init.headers, host: `${name}.${tunnelDomain}` };
    const request = httpRequest({ host: "127.0.0.1", port: serverPort, path, method: init.method ?? "GET", headers }, (response) => {
      const chunks: Buffer[] = [];
      response.on("data", (chunk: Buffer) => chunks.push(chunk));
      response.on("end", () => resolve({ status: response.statusCode ?? 0, headers: response.headers, text: Buffer.concat(chunks).toString("utf8") }));
    });
    request.on("error", reject);
    if (init.body) request.write(init.body);
    request.end();
  });
}

export function trafficSocket(name: string, path: string): WebSocket {
  return new WebSocket(`ws://127.0.0.1:${serverPort}${path}`, { headers: { host: `${name}.${tunnelDomain}` } });
}

export async function requests(name: string, credential: string): Promise<Summary[]> {
  const response = await fetch(`${baseUrl}/${name}/requests`, { headers: { Authorization: `Bearer ${credential}` } });
  return (await response.json()) as Summary[];
}

export async function detail(name: string, credential: string, id: number): Promise<Detail> {
  const response = await fetch(`${baseUrl}/${name}/requests/${id}`, { headers: { Authorization: `Bearer ${credential}` } });
  return (await response.json()) as Detail;
}

export type Cli = { process: ChildProcess; output: () => string; url: string; stop: () => void };

export async function startCli(args: string[], options: { token?: string } = {}): Promise<Cli> {
  const home = mkdtempSync(join(tmpdir(), "beam-cli-"));
  const env: Record<string, string> = { ...(process.env as Record<string, string>), BEAM_URL: baseUrl, HOME: home, XDG_CONFIG_HOME: home, NO_COLOR: "1" };
  if (options.token) env.BEAM_TOKEN = options.token;
  else delete env.BEAM_TOKEN;
  const child = spawn(cliPath, args, { env });
  let text = "";
  child.stdout.on("data", (chunk: Buffer) => (text += chunk.toString()));
  child.stderr.on("data", (chunk: Buffer) => (text += chunk.toString()));
  const output = () => text;
  const stop = () => {
    if (child.exitCode === null) child.kill("SIGINT");
  };
  const url = await waitFor(
    () => output().match(new RegExp(`https://[a-z0-9-]+\\.${tunnelDomain.replace(".", "\\.")}`))?.[0],
    () => `CLI did not print a URL\n${output()}`,
    20_000
  );
  if (args.length > 0 && !args[0].startsWith("-") && !["watch", "replay", "ls", "rm", "config"].includes(args[0])) {
    await waitFor(
      () => (output().includes("Stop anytime") ? true : undefined),
      () => `CLI did not connect\n${output()}`
    );
    await sleep(300);
  }
  return { process: child, output, url, stop };
}

export async function runCli(args: string[], options: { token?: string; home?: string } = {}): Promise<{ code: number | null; output: string }> {
  const home = options.home ?? mkdtempSync(join(tmpdir(), "beam-cli-"));
  const env: Record<string, string> = { ...(process.env as Record<string, string>), BEAM_URL: baseUrl, HOME: home, XDG_CONFIG_HOME: home, NO_COLOR: "1" };
  if (options.token) env.BEAM_TOKEN = options.token;
  else delete env.BEAM_TOKEN;
  const child = spawn(cliPath, args, { env });
  let text = "";
  child.stdout.on("data", (chunk: Buffer) => (text += chunk.toString()));
  child.stderr.on("data", (chunk: Buffer) => (text += chunk.toString()));
  const code = await new Promise<number | null>((resolve) => child.on("exit", resolve));
  return { code, output: text };
}

export type Local = { port: number; server: Server; received: { method: string; url: string; headers: IncomingHttpHeaders; body: string }[]; close: () => Promise<void> };

export async function startLocal(): Promise<Local> {
  const received: Local["received"] = [];
  const server = createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on("data", (chunk: Buffer) => chunks.push(chunk));
    request.on("end", () => {
      const body = Buffer.concat(chunks).toString("utf8");
      received.push({ method: request.method ?? "", url: request.url ?? "", headers: request.headers, body });
      response.setHeader("x-local", "yes");
      response.setHeader("content-type", "application/json");
      response.end(JSON.stringify({ method: request.method, url: request.url, host: request.headers.host, forwardedHost: request.headers["x-forwarded-host"], body }));
    });
  });
  const sockets = new WebSocketServer({ server });
  sockets.on("connection", (socket) => socket.on("message", (data, binary) => socket.send(binary ? data : `echo:${textOf(data)}`)));
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as AddressInfo).port;
  return {
    port,
    server,
    received,
    close: () =>
      new Promise((resolve) => {
        sockets.close();
        server.closeAllConnections();
        server.close(() => resolve());
      })
  };
}

export async function waitFor<T>(check: () => T | undefined | Promise<T | undefined>, message: () => string, timeoutMs = 10_000): Promise<T> {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    const value = await check();
    if (value !== undefined) return value;
    await sleep(50);
  }
  throw new Error(message());
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function uniqueName(prefix: string): string {
  return `${prefix}-${Math.random().toString(36).slice(2, 8)}`;
}

export function textOf(data: RawData): string {
  if (Array.isArray(data)) return Buffer.concat(data).toString("utf8");
  return Buffer.from(data as ArrayBuffer).toString("utf8");
}
