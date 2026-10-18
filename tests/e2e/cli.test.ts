import { strict as assert } from "node:assert";
import { test } from "vite-plus/test";
import { createBeam, ownerToken, requests, runCli, sleep, startCli, startLocal, traffic, trafficSocket, uniqueName, waitFor, textOf } from "../helpers/beam";

const nameOf = (url: string) => new URL(url).hostname.split(".")[0];

test("beam <port> puts a local server online and records what passed through", async () => {
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

    const recorded = await requests(name, ownerToken);
    assert.ok(recorded.some((request) => request.path === "/submit" && request.status === 200 && request.forwarded));
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

test("forwarding without the owner token is refused with a hint", async () => {
  const result = await runCli(["3000"]);
  assert.equal(result.code, 1);
  assert.match(result.output, /owner token/);
});

test("beam on its own catches requests and prints them", async () => {
  const cli = await startCli([]);
  try {
    const name = nameOf(cli.url);
    await sleep(500);
    await traffic(name, "/hook", { method: "POST", body: "{}" });
    await waitFor(
      () => (/POST\s+200\s+\/hook/.test(cli.output()) ? true : undefined),
      () => `CLI did not print the webhook\n${cli.output()}`
    );
  } finally {
    cli.stop();
  }
});

test("replay sends a captured webhook to a local server again", async () => {
  const beam = await createBeam();
  await traffic(beam.name, "/stripe?attempt=1", { method: "POST", headers: { "stripe-signature": "t=2,v1=def", "content-type": "application/json" }, body: '{"id":"evt_1"}' });
  const local = await startLocal();
  try {
    const result = await runCli(["replay", `${beam.watch}`, "--to", String(local.port)]);
    assert.equal(result.code, 0, result.output);
    assert.match(result.output, /POST\s+200\s+\/stripe\?attempt=1/);
    const [received] = local.received;
    assert.equal(received.method, "POST");
    assert.equal(received.url, "/stripe?attempt=1");
    assert.equal(received.body, '{"id":"evt_1"}');
    assert.equal(received.headers["stripe-signature"], "t=2,v1=def");
  } finally {
    await local.close();
  }
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
