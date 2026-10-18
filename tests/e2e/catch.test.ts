import { strict as assert } from "node:assert";
import { test } from "vite-plus/test";
import { WebSocket } from "ws";
import { baseUrl, createBeam, detail, ownerToken, requests, traffic, tunnelDomain, uniqueName, textOf } from "../helpers/beam";

test("anyone can create a URL that records webhooks and read them back with its key", async () => {
  const beam = await createBeam();
  assert.equal(beam.url, `https://${beam.name}.${tunnelDomain}`);
  assert.equal(beam.owned, false);

  const reply = await traffic(beam.name, "/stripe/events?live=1", { method: "POST", headers: { "content-type": "application/json", "stripe-signature": "t=1,v1=abc" }, body: '{"paid":true}' });
  assert.equal(reply.status, 200);
  assert.equal(reply.text, "ok\n");

  const [latest] = await requests(beam.name, beam.key);
  assert.equal(latest.method, "POST");
  assert.equal(latest.path, "/stripe/events?live=1");
  assert.equal(latest.status, 200);
  assert.equal(latest.size, 13);

  const full = await detail(beam.name, beam.key, latest.id);
  assert.equal(full.body, '{"paid":true}');
  assert.equal(full.headers["stripe-signature"], "t=1,v1=abc");
});

test("reading a beam needs its key", async () => {
  const beam = await createBeam();
  const other = await createBeam();
  assert.equal((await fetch(`${baseUrl}/${beam.name}`)).status, 401);
  assert.equal((await fetch(`${baseUrl}/${beam.name}`, { headers: { Authorization: `Bearer ${other.key}` } })).status, 401);
  assert.equal((await fetch(`${baseUrl}/${beam.name}`, { headers: { Authorization: `Bearer ${beam.key}` } })).status, 200);
  assert.equal((await fetch(`${baseUrl}/zzzzzzzz`, { headers: { Authorization: `Bearer ${beam.key}` } })).status, 404);
  assert.equal((await traffic("zzzzzzzz", "/")).status, 404);
});

test("choosing a name and forwarding are for the owner only", async () => {
  const named = await fetch(`${baseUrl}/?name=${uniqueName("mine")}`, { method: "POST" });
  assert.equal(named.status, 403);

  const beam = await createBeam();
  const refused = (await fetch(`${baseUrl}/${beam.name}/connect?role=forward`, { headers: { Authorization: `Bearer ${beam.key}` } })).status;
  assert.equal(refused, 403);

  const name = uniqueName("owned");
  const owned = await createBeam({ token: ownerToken, name });
  assert.equal(owned.name, name);
  assert.equal(owned.owned, true);
  const again = await createBeam({ token: ownerToken, name });
  assert.equal(again.key, owned.key);
});

test("watchers see requests live over a WebSocket", async () => {
  const beam = await createBeam();
  const socket = new WebSocket(`${baseUrl.replace("http", "ws")}/${beam.name}/connect`, ["beam", beam.key]);
  const events: { t: string; request?: { path: string }; status?: number }[] = [];
  socket.on("message", (data) => events.push(JSON.parse(textOf(data))));
  await new Promise((resolve) => socket.on("open", resolve));
  assert.equal(socket.protocol, "beam");

  await traffic(beam.name, "/live", { method: "PUT", body: "x" });
  const started = Date.now();
  while (!events.some((event) => event.t === "status") && Date.now() - started < 5000) await new Promise((resolve) => setTimeout(resolve, 50));
  socket.close();
  assert.ok(events.some((event) => event.t === "request" && event.request?.path === "/live"));
  assert.ok(events.some((event) => event.t === "status" && event.status === 200));
});

test("deleting a beam removes the URL and what it recorded", async () => {
  const beam = await createBeam();
  await traffic(beam.name, "/gone");
  const deleted = await fetch(`${baseUrl}/${beam.name}`, { method: "DELETE", headers: { Authorization: `Bearer ${beam.key}` } });
  assert.equal(deleted.status, 200);
  assert.equal((await traffic(beam.name, "/gone")).status, 404);
});

test("creating too many beams from one address is refused", async () => {
  const statuses: number[] = [];
  for (let index = 0; index < 35; index += 1) {
    statuses.push((await fetch(baseUrl, { method: "POST", headers: { "cf-connecting-ip": "203.0.113.7" } })).status);
  }
  assert.equal(statuses[0], 201);
  assert.equal(statuses.at(-1), 429);
});
