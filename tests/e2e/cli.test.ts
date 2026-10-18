import { strict as assert } from "node:assert";
import { request as httpRequest } from "node:http";
import { test } from "vite-plus/test";
import { baseUrl, ownerToken, runCli, sleep, startCli, startLocal, traffic, trafficSocket, uniqueName, waitFor, textOf } from "../helpers/beam";

const nameOf = (url: string) => new URL(url).hostname.split(".")[0];

test("beam <port> puts a local server online", async () => {
  const local = await startLocal();
  const name = uniqueName("app");
  const cli = await startCli([String(local.port), "--name", name], { token: ownerToken });
  try {
    assert.equal(nameOf(cli.url), name);

    const get = await traffic(name, "/hello?x=1", { headers: { accept: "application/json" } });
    assert.equal(get.status, 200, cli.output());
    assert.equal(get.headers["x-local"], "yes");
    const echoed = JSON.parse(get.text) as { method: string; url: string; host: string; forwardedHost: string };
    assert.equal(echoed.url, "/hello?x=1");
    assert.equal(echoed.host, `localhost:${local.port}`);
    assert.equal(echoed.forwardedHost, `${name}.beam.test`);

    const post = await traffic(name, "/submit", { method: "POST", headers: { "content-type": "text/plain" }, body: "payload" });
    assert.equal(JSON.parse(post.text).body, "payload");
    const submitted = local.received.find((request) => request.url === "/submit");
    assert.equal(submitted?.headers["content-length"], "7");

    await waitFor(
      () => (cli.output().includes("/submit") ? true : undefined),
      () => `CLI did not print the request\n${cli.output()}`
    );
  } finally {
    cli.stop();
    await local.close();
  }
});

test("WebSockets pass through to the local server, so hot reload works", async () => {
  const local = await startLocal();
  const name = uniqueName("ws");
  const cli = await startCli([String(local.port), "--name", name], { token: ownerToken });
  try {
    const socket = trafficSocket(name, "/hmr");
    await new Promise((resolve, reject) => {
      socket.on("open", resolve);
      socket.on("error", reject);
    });
    const reply = new Promise<string>((resolve) => socket.on("message", (data) => resolve(textOf(data))));
    socket.send("hi");
    assert.equal(await reply, "echo:hi");
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

test("a stopped local server gets a clear 502", async () => {
  const local = await startLocal();
  const port = local.port;
  await local.close();
  const name = uniqueName("down");
  const cli = await startCli([String(port), "--name", name], { token: ownerToken });
  try {
    const reply = await traffic(name, "/");
    assert.equal(reply.status, 502);
    assert.match(reply.text, /Nothing answered on localhost/);
  } finally {
    cli.stop();
  }
});

test("replacing a beam closes its old response streams and WebSockets", async () => {
  const firstLocal = await startLocal();
  firstLocal.server.removeAllListeners("request");
  firstLocal.server.on("request", (_request, response) => response.write("stream started"));
  const secondLocal = await startLocal();
  const name = uniqueName("streams");
  const first = await startCli([String(firstLocal.port), "--name", name], { token: ownerToken });
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
    second = await startCli([String(secondLocal.port), "--name", name], { token: ownerToken });
    first.stop();
    await waitFor(
      () => (responseClosed && socketClosed ? true : undefined),
      () => `Replacement left old connections open: HTTP closed=${responseClosed}, WebSocket closed=${socketClosed}`,
      2000
    );
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

test("sharing needs the right owner token", async () => {
  const missing = await runCli(["3000"]);
  assert.equal(missing.code, 1);
  assert.match(missing.output, /owner token/);

  const wrong = await fetch(`${baseUrl}/app/connect`, { headers: { Authorization: "Bearer not-the-token" } });
  assert.equal(wrong.status, 401);
  const right = await fetch(`${baseUrl}/app/connect`, { headers: { Authorization: `Bearer ${ownerToken}` } });
  assert.equal(right.status, 426);
});

test("a random URL works without --name and goes offline when beam stops", async () => {
  const local = await startLocal();
  const cli = await startCli([String(local.port)], { token: ownerToken });
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
  const cli = await startCli([String(port), "--name", name, "--", "node", "-e", server], { token: ownerToken });
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
  const cli = await startCli([String(port), "--name", name, "--", line], { token: ownerToken });
  try {
    const reply = await traffic(name, "/");
    assert.equal(reply.text, `shell:${port}`, cli.output());
  } finally {
    cli.stop();
  }
});
