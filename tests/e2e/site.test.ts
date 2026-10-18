import { strict as assert } from "node:assert";
import { test } from "vite-plus/test";
import { baseUrl, createBeam } from "../helpers/beam";

test("browsers get the homepage and curl gets usage text", async () => {
  const page = await fetch(baseUrl, { headers: { Accept: "text/html" } });
  assert.match(page.headers.get("content-type") ?? "", /text\/html/);
  assert.match(await page.text(), /Your localhost, on the internet\./);

  const text = await (await fetch(baseUrl)).text();
  assert.match(text, /^beam: your localhost, on the internet\./);
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
