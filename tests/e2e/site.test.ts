import { strict as assert } from "node:assert";
import { test } from "vite-plus/test";
import { baseUrl, createBeam } from "../helpers/beam";

test("browsers get the homepage and curl gets usage text", async () => {
  const page = await fetch(baseUrl, { headers: { Accept: "text/html" } });
  assert.match(page.headers.get("content-type") ?? "", /text\/html/);
  const html = await page.text();
  assert.match(html, /<h1>Share a port\. Catch a webhook\.<\/h1>/);
  assert.match(html, /<p hidden id="automation">Agents and automation:/);
  assert.ok(html.indexOf("beam 3000") < html.indexOf("<details>"), "everyday commands come before the hidden details");
  assert.ok(html.indexOf("curl -i -X POST") > html.indexOf("<details>"), "the curl API sits inside More options");

  const text = await (await fetch(baseUrl)).text();
  assert.match(text, /^beam: your localhost, on the internet\.\n\nAgents and automation:/);
  assert.match(text, /beam 3000 -- npm run dev/);
});

test("a beam's watch link opens a live viewer page", async () => {
  const beam = await createBeam();
  const page = await fetch(`${baseUrl}/${beam.name}`, { headers: { Accept: "text/html" } });
  assert.equal(page.status, 200);
  const html = await page.text();
  assert.match(html, new RegExp(`https://${beam.name}\\.beam\\.test`));
  assert.match(html, /new WebSocket/);
});
