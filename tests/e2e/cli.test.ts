import { strict as assert } from "node:assert";
import { createServer, request as httpRequest } from "node:http";
import type { AddressInfo } from "node:net";
import { WebSocket, WebSocketServer } from "ws";
import { test } from "vite-plus/test";
import { baseUrl, runCli, sleep, startCli, startLocal, traffic, trafficSocket, uniqueName, waitFor, textOf } from "../helpers/beam";

const nameOf = (url: string) => new URL(url).hostname.split(".")[0];

test("help, version and invalid arguments exit without starting a beam", async () => {
  const help = await runCli(["--help"]);
  assert.equal(help.code, 0);
  assert.match(help.output, /Usage: beam/);
  assert.match(help.output, /beam 3000 -- npm run dev/);
  const version = await runCli(["--version"]);
  assert.equal(version.code, 0);
  assert.match(version.output, /^beam \d+\.\d+\.\d+\s*$/);
  const invalid = await runCli(["--does-not-exist"]);
  assert.equal(invalid.code, 2);
  assert.match(invalid.output, /unexpected argument/);
});

test("beam <port> puts a local server online without token setup", async () => {
  const local = await startLocal();
  const name = uniqueName("app");
  const cli = await startCli([String(local.port), "--name", name]);
  try {
    assert.equal(nameOf(cli.url), name);

    const get = await traffic(name, "/hello?x=1", { headers: { accept: "application/json" } });
    assert.equal(get.status, 200, cli.output());
    assert.equal(get.headers["x-local"], "yes");
    const echoed = JSON.parse(get.text) as { method: string; url: string; host: string; forwardedHost: string };
    assert.equal(echoed.url, "/hello?x=1");
    assert.equal(echoed.host, `localhost:${local.port}`);
    assert.equal(echoed.forwardedHost, `${name}.beam.test`);

    for (const body of ["payload", "é-😀".repeat(100_000)]) {
      const post = await traffic(name, "/submit", { method: "POST", headers: { "content-type": "text/plain" }, body });
      assert.equal(JSON.parse(post.text).body, body);
      const submitted = local.received.at(-1);
      assert.equal(submitted?.headers["content-length"], String(Buffer.byteLength(body)));
    }

    await waitFor(
      () => (cli.output().includes("/submit") ? true : undefined),
      () => `CLI did not print the request\n${cli.output()}`
    );
  } finally {
    cli.stop();
    await local.close();
  }
});

test("large binary downloads arrive intact across response chunks", async () => {
  const local = await startLocal();
  const payload = Buffer.alloc(4 * 1024 * 1024);
  for (let index = 0; index < payload.length; index++) payload[index] = index % 251;
  local.server.removeAllListeners("request");
  local.server.on("request", (_request, response) => response.end(payload));
  const name = uniqueName("download");
  const cli = await startCli([String(local.port), "--name", name]);
  try {
    const downloaded = await new Promise<Buffer>((resolve, reject) => {
      const request = httpRequest(`${baseUrl}/download`, { headers: { host: `${name}.beam.test` } }, (response) => {
        const chunks: Buffer[] = [];
        response.on("data", (chunk: Buffer) => chunks.push(chunk));
        response.on("end", () => resolve(Buffer.concat(chunks)));
        response.on("error", reject);
      });
      request.on("error", reject);
      request.end();
    });
    assert.deepEqual(downloaded, payload);
  } finally {
    cli.stop();
    await local.close();
  }
});

test("WebSockets pass through to the local server, so hot reload works", async () => {
  const local = await startLocal();
  const name = uniqueName("ws");
  const cli = await startCli([String(local.port), "--name", name]);
  try {
    const socket = trafficSocket(name, "/hmr");
    await new Promise((resolve, reject) => {
      socket.on("open", resolve);
      socket.on("error", reject);
    });
    for (const message of ["hi", JSON.stringify({ value: '"quotes" \\ backslash 😀' }), "line\n\r\tend", "large-message".repeat(8192)]) {
      const reply = new Promise<string>((resolve) => socket.once("message", (data) => resolve(textOf(data))));
      socket.send(message);
      assert.equal(await reply, `echo:${message}`);
    }
    socket.terminate();
    await sleep(500);
    const again = trafficSocket(name, "/hmr");
    await new Promise((resolve, reject) => {
      again.on("open", resolve);
      again.on("error", reject);
    });
    again.close();
  } finally {
    cli.stop();
    await local.close();
  }
});

test("binary WebSockets preserve empty and large messages", async () => {
  const local = await startLocal();
  const name = uniqueName("binary");
  const cli = await startCli([String(local.port), "--name", name]);
  const socket = trafficSocket(name, "/hmr");
  try {
    await new Promise((resolve, reject) => {
      socket.on("open", resolve);
      socket.on("error", reject);
    });
    for (const size of [0, 1, 512 * 1024]) {
      const payload = Buffer.alloc(size);
      for (let index = 0; index < payload.length; index++) payload[index] = index % 251;
      const reply = new Promise<{ data: Buffer; binary: boolean }>((resolve, reject) => {
        socket.once("message", (data, binary) => {
          resolve({ data: Buffer.from(data as Buffer), binary });
        });
        socket.once("error", reject);
      });
      socket.send(payload);
      const received = await reply;
      assert.equal(received.binary, true);
      assert.deepEqual(received.data, payload);
    }
  } finally {
    socket.terminate();
    cli.stop();
    await local.close();
  }
});

test("a stopped local server gets a clear 502", async () => {
  const local = await startLocal();
  const port = local.port;
  await local.close();
  const name = uniqueName("down");
  const cli = await startCli([String(port), "--name", name]);
  try {
    const reply = await traffic(name, "/");
    assert.equal(reply.status, 502);
    assert.match(reply.text, /Nothing answered on localhost/);
  } finally {
    cli.stop();
  }
});

test("DELETE uploads still arrive without a content length", async () => {
  const local = await startLocal();
  const name = uniqueName("delete");
  const cli = await startCli([String(local.port), "--name", name]);
  try {
    const reply = await new Promise<{ status: number; body: string }>((resolve, reject) => {
      const request = httpRequest(`${baseUrl}/delete`, { method: "DELETE", headers: { host: `${name}.beam.test`, "transfer-encoding": "chunked" } }, (response) => {
        let body = "";
        response.on("data", (chunk: Buffer) => (body += chunk.toString()));
        response.on("end", () => resolve({ status: response.statusCode ?? 0, body }));
        response.on("error", reject);
      });
      request.on("error", reject);
      request.write("part one");
      request.end("part two");
    });
    assert.equal(reply.status, 200, cli.output());
    assert.equal(JSON.parse(reply.body).body, "part onepart two");
  } finally {
    cli.stop();
    await local.close();
  }
});

test("rejecting a takeover keeps streams open, and stopping the beam closes them", async () => {
  const firstLocal = await startLocal();
  firstLocal.server.removeAllListeners("request");
  firstLocal.server.on("request", (_request, response) => response.write("stream started"));
  const secondLocal = await startLocal();
  const name = uniqueName("streams");
  const first = await startCli([String(firstLocal.port), "--name", name]);
  const socket = trafficSocket(name, "/hmr");
  let socketClosed = false;
  socket.on("close", () => (socketClosed = true));
  let body = "";
  let responseClosed = false;
  const request = httpRequest(`${baseUrl}/stream`, { headers: { host: `${name}.beam.test` } }, (response) => {
    response.on("data", (chunk: Buffer) => (body += chunk.toString()));
    response.on("end", () => (responseClosed = true));
    response.on("error", () => (responseClosed = true));
  });
  request.on("error", () => (responseClosed = true));
  let second: Awaited<ReturnType<typeof startCli>> | undefined;
  try {
    await new Promise((resolve, reject) => {
      socket.on("open", resolve);
      socket.on("error", reject);
    });
    request.end();
    await waitFor(
      () => (body === "stream started" ? true : undefined),
      () => "The original response did not start streaming"
    );
    const refused = await runCli([String(secondLocal.port), "--name", name]);
    assert.equal(refused.code, 1);
    assert.match(refused.output, /already in use/);
    assert.equal(responseClosed, false);
    assert.equal(socketClosed, false);
    first.stop();
    await waitFor(
      () => (responseClosed && socketClosed ? true : undefined),
      () => `Stopping left old connections open: HTTP closed=${responseClosed}, WebSocket closed=${socketClosed}`,
      2000
    );
    second = await startCli([String(secondLocal.port), "--name", name]);
    const reply = await traffic(name, "/replacement");
    assert.equal(reply.status, 200, second.output());
    assert.equal(JSON.parse(reply.text).host, `localhost:${secondLocal.port}`);
  } finally {
    request.destroy();
    socket.terminate();
    first.stop();
    second?.stop();
    await Promise.all([firstLocal.close(), secondLocal.close()]);
  }
});

test("local response status and repeated cookies survive the tunnel", async () => {
  const local = await startLocal();
  const cookies = ["session=one; Path=/; HttpOnly", "theme=dark; Path=/"];
  const message = 'say "hello" \\ again';
  local.server.removeAllListeners("request");
  local.server.on("request", (_request, response) => {
    response.statusCode = 201;
    response.setHeader("set-cookie", cookies);
    response.setHeader("x-message", message);
    response.end("saved");
  });
  const name = uniqueName("headers");
  const cli = await startCli([String(local.port), "--name", name]);
  try {
    const reply = await traffic(name, "/created");
    assert.equal(reply.status, 201);
    assert.deepEqual(reply.headers["set-cookie"], cookies);
    assert.equal(reply.headers["x-message"], message);
    assert.equal(reply.text, "saved");
  } finally {
    cli.stop();
    await local.close();
  }
});

test("another CLI cannot replace an active beam, but can use the name after it stops", async () => {
  const local = await startLocal();
  const name = uniqueName("claimed");
  const cli = await startCli([String(local.port), "--name", name]);
  try {
    const other = await runCli([String(local.port), "--name", name]);
    assert.equal(other.code, 1);
    assert.match(other.output, /already in use/);
    assert.equal((await traffic(name, "/still-original")).status, 200);
    await waitFor(
      () => (cli.output().includes("/still-original") ? true : undefined),
      () => "The original CLI stopped receiving traffic"
    );
    cli.stop();
    await waitFor(
      async () => ((await traffic(name, "/")).status === 502 ? true : undefined),
      () => "Beam did not go offline"
    );
    const next = await startCli([String(local.port), "--name", name]);
    try {
      assert.equal((await traffic(name, "/reused")).status, 200);
    } finally {
      next.stop();
    }
  } finally {
    cli.stop();
    await local.close();
  }
});

test("the CLI reconnects to the same URL even when its old connection is still open", async () => {
  const local = await startLocal();
  const proxy = createServer();
  const sockets = new WebSocketServer({ server: proxy });
  const connections: { client: WebSocket; upstream: WebSocket }[] = [];
  sockets.on("connection", (client, request) => {
    const upstream = new WebSocket(`${baseUrl.replace(/^http/, "ws")}${request.url}`, { headers: { authorization: request.headers.authorization ?? "" } });
    connections.push({ client, upstream });
    client.on("message", (data, binary) => {
      if (upstream.readyState === WebSocket.OPEN) upstream.send(data, { binary });
    });
    upstream.on("message", (data, binary) => {
      if (client.readyState === WebSocket.OPEN) client.send(data, { binary });
    });
    upstream.on("close", () => client.close());
    upstream.on("error", () => client.close());
  });
  await new Promise<void>((resolve) => proxy.listen(0, "127.0.0.1", resolve));
  const port = (proxy.address() as AddressInfo).port;
  const name = uniqueName("reconnect");
  const cli = await startCli([String(local.port), "--name", name], { baseUrl: `http://127.0.0.1:${port}` });
  try {
    assert.equal((await traffic(name, "/before-disconnect")).status, 200);
    const original = connections[0];
    original.client.terminate();
    await waitFor(
      async () => {
        if (connections.length <= 1 || original.upstream.readyState !== WebSocket.CLOSED) return undefined;
        const reply = await traffic(name, "/after-reconnect");
        return reply.status === 200 ? true : undefined;
      },
      () => `CLI did not reconnect to the same URL\n${cli.output()}`
    );
    await waitFor(
      () => (cli.output().includes("/after-reconnect") ? true : undefined),
      () => "The reconnected CLI did not receive traffic"
    );
  } finally {
    cli.stop();
    for (const { client, upstream } of connections) {
      client.terminate();
      upstream.terminate();
    }
    sockets.close();
    await new Promise<void>((resolve) => proxy.close(() => resolve()));
    await local.close();
  }
});

test("a random URL works without --name and goes offline when beam stops", async () => {
  const local = await startLocal();
  const cli = await startCli([String(local.port)]);
  const name = nameOf(cli.url);
  assert.match(name, /^[a-z0-9]{8}$/);
  assert.equal((await traffic(name, "/")).status, 200, cli.output());
  cli.stop();
  await waitFor(
    () => (cli.process.exitCode !== null || cli.process.signalCode !== null ? true : undefined),
    () => "CLI did not exit"
  );
  await sleep(300);
  const page = await traffic(name, "/", { headers: { accept: "text/html" } });
  assert.equal(page.status, 503);
  assert.match(page.text, /This beam is offline/);
  assert.equal((await traffic(name, "/")).status, 502);
  await local.close();
});

test("beam <port> -- <command> starts the app, waits for it, then shares it", async () => {
  const probe = await startLocal();
  const port = probe.port;
  await probe.close();
  const name = uniqueName("run");
  const server = `require('http').createServer((q, r) => r.end('started-by-beam')).listen(${port}, '127.0.0.1')`;
  const cli = await startCli([String(port), "--name", name, "--", "node", "-e", server]);
  try {
    const reply = await traffic(name, "/");
    assert.equal(reply.text, "started-by-beam", cli.output());
  } finally {
    cli.stop();
  }
  await waitFor(
    () => (cli.process.exitCode !== null || cli.process.signalCode !== null ? true : undefined),
    () => "CLI did not exit"
  );
  await sleep(500);
  const afterExit = await fetch(`http://127.0.0.1:${port}/`).then(
    () => "still running",
    () => "stopped"
  );
  assert.equal(afterExit, "stopped");
});

test("a single quoted command after -- runs through the shell", async () => {
  const probe = await startLocal();
  const port = probe.port;
  await probe.close();
  const name = uniqueName("sh");
  const line = `PORT=${port} node -e "require('http').createServer((q, r) => r.end('shell:' + process.env.PORT)).listen(process.env.PORT, '127.0.0.1')"`;
  const cli = await startCli([String(port), "--name", name, "--", line]);
  try {
    const reply = await traffic(name, "/");
    assert.equal(reply.text, `shell:${port}`, cli.output());
  } finally {
    cli.stop();
  }
});

test("requests without bodies keep their method and empty payload", async () => {
  const local = await startLocal();
  const name = uniqueName("empty");
  const cli = await startCli([String(local.port), "--name", name]);
  try {
    for (const method of ["GET", "HEAD", "OPTIONS", "DELETE", "POST"]) {
      const reply = await traffic(name, "/empty", { method });
      assert.equal(reply.status, 200, cli.output());
      const received = local.received.at(-1);
      assert.equal(received?.method, method);
      assert.equal(received?.body, "");
    }
  } finally {
    cli.stop();
    await local.close();
  }
});
