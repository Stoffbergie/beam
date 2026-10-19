import { strict as assert } from "node:assert";
import { test } from "vite-plus/test";
import { baseUrl } from "../helpers/beam";

test("browsers get the homepage and curl gets usage text", async () => {
  const page = await fetch(baseUrl, { headers: { Accept: "text/html" } });
  assert.match(page.headers.get("content-type") ?? "", /text\/html/);
  const html = await page.text();
  assert.match(html, /<h1>Share local servers through public HTTPS URLs\.<\/h1>/);
  assert.match(html, /<p hidden id="automation">Agents and automation:/);
  assert.ok(html.indexOf("beam 3000") < html.indexOf("<details>"), "everyday commands come before the hidden details");
  assert.ok(html.indexOf("<dt>beam config --token") > html.indexOf("<details>"), "setup details sit inside More options");

  const text = await (await fetch(baseUrl)).text();
  assert.match(text, /^beam: Share local servers through public HTTPS URLs\.\n\nAgents and automation:/);
  assert.match(text, /beam 3000 -- npm run dev/);
});
