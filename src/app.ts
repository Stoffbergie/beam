import { HonoBase as Hono } from "hono/hono-base";
import { TrieRouter } from "hono/router/trie-router";
import type { Env } from "./env";
import { validName } from "./names";
import { homePage, homeText, notFoundPage } from "./pages";

export const app = new Hono<{ Bindings: Env }>({ router: new TrieRouter() });

app.use("*", async (c, next) => {
  await next();
  if (c.res.status !== 101) c.header("Cache-Control", "no-store");
});

app.onError((error) => {
  console.error(error);
  return text("Something went wrong\n", 500);
});

app.get("/", (c) => {
  const origin = new URL(c.req.url).origin;
  if (wantsHtml(c.req.raw.headers)) return c.html(homePage(origin, c.env.TUNNEL_DOMAIN));
  return text(homeText(c.env.TUNNEL_DOMAIN));
});

app.get("/robots.txt", (c) => text(`User-agent: *\nAllow: /\nSitemap: ${new URL(c.req.url).origin}/sitemap.xml\n`));

app.get("/sitemap.xml", (c) => {
  const origin = new URL(c.req.url).origin;
  return c.body(`<?xml version="1.0" encoding="UTF-8"?><urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9"><url><loc>${origin}/</loc></url></urlset>`, 200, {
    "Content-Type": "application/xml; charset=utf-8"
  });
});

app.get("/:name/connect", async (c) => {
  const name = c.req.param("name");
  if (!validName(name)) return text("Names use 1-32 lowercase letters, digits and dashes\n", 400);
  if (c.req.header("upgrade")?.toLowerCase() !== "websocket") return text("Connect with a WebSocket\n", 426);
  const publicUrl = encodeURIComponent(`https://${name}.${c.env.TUNNEL_DOMAIN}`);
  return c.env.BEAMS.getByName(name).fetch(new Request(`https://beam.internal/connect?url=${publicUrl}`, c.req.raw));
});

app.notFound((c) => (wantsHtml(c.req.raw.headers) ? c.html(notFoundPage, 404) : text("Not found\n", 404)));

function wantsHtml(headers: Headers): boolean {
  const crawler = /WhatsApp|facebookexternalhit|Facebot|meta-externalagent|Twitterbot|LinkedInBot|Slackbot|Discordbot|TelegramBot|Googlebot|bingbot/i;
  return (headers.get("accept") ?? "").includes("text/html") || crawler.test(headers.get("user-agent") ?? "");
}

function text(body: string, status = 200): Response {
  return new Response(body, { status, headers: { "Content-Type": "text/plain; charset=utf-8" } });
}
