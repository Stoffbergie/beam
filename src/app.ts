import { Hono, type Context } from "hono";
import type { Beam, BeamMeta } from "./beam";
import type { Env } from "./env";
import { randomName, validName } from "./names";
import { homePage, homeText, notFoundPage, viewerPage } from "./pages";

type AppContext = Context<{ Bindings: Env }>;
type Access = { meta: BeamMeta; stub: DurableObjectStub<Beam>; owner: boolean } | { response: Response };

export const app = new Hono<{ Bindings: Env }>();

app.use("*", async (c, next) => {
  await next();
  if (c.res.status !== 101) c.res.headers.set("Cache-Control", "no-store");
});

app.onError((error) => {
  console.error(error);
  return text("Something went wrong\n", 500);
});

app.get("/", (c) => {
  const origin = new URL(c.req.url).origin;
  if (wantsHtml(c.req.raw.headers)) return c.html(homePage(origin, c.env.TUNNEL_DOMAIN));
  return text(homeText(origin, c.env.TUNNEL_DOMAIN));
});

app.get("/robots.txt", (c) => text(`User-agent: *\nAllow: /\nSitemap: ${new URL(c.req.url).origin}/sitemap.xml\n`));

app.get("/sitemap.xml", (c) => {
  const origin = new URL(c.req.url).origin;
  return c.body(`<?xml version="1.0" encoding="UTF-8"?><urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9"><url><loc>${origin}/</loc></url></urlset>`, 200, {
    "Content-Type": "application/xml; charset=utf-8"
  });
});

app.post("/", async (c) => {
  if (!(await allowed(c, c.env.CREATES))) return tooMany();
  const owner = isOwner(c);
  const requested = c.req.query("name");
  if (requested !== undefined && !owner) return text("Choosing a name needs the owner token\n", 403);
  if (requested !== undefined && !validName(requested)) return text("Names use 1-32 lowercase letters, digits and dashes\n", 400);

  for (let attempt = 0; attempt < 8; attempt += 1) {
    const name = requested ?? randomName();
    const meta = await c.env.BEAMS.getByName(name).create(name, owner);
    if (meta) return created(c, meta);
    if (requested !== undefined) return text("That name is taken\n", 409);
  }
  throw new Error("Could not allocate a beam name");
});

app.get("/:name", async (c) => {
  if (wantsHtml(c.req.raw.headers) && !c.req.header("authorization")) return c.html(viewerPage(c.req.param("name"), c.env.TUNNEL_DOMAIN));
  const access = await authorize(c);
  if ("response" in access) return access.response;
  const { meta, stub } = access;
  const expiresAt = await stub.expiresAt();
  return Response.json({
    name: meta.name,
    url: beamUrl(meta.name, c.env.TUNNEL_DOMAIN),
    owned: meta.owned,
    forwarding: await stub.forwarding(),
    expiresAt: expiresAt ? new Date(expiresAt).toISOString() : null,
    requests: await stub.list(0, 50)
  });
});

app.delete("/:name", async (c) => {
  const access = await authorize(c);
  if ("response" in access) return access.response;
  await access.stub.remove();
  return text("deleted\n");
});

app.get("/:name/requests", async (c) => {
  const access = await authorize(c);
  if ("response" in access) return access.response;
  const after = Number.parseInt(c.req.query("after") ?? "0", 10) || 0;
  const limit = Math.min(Math.max(Number.parseInt(c.req.query("limit") ?? "50", 10) || 50, 1), 100);
  return Response.json(await access.stub.list(after, limit));
});

app.get("/:name/requests/:id", async (c) => {
  const access = await authorize(c);
  if ("response" in access) return access.response;
  const detail = await access.stub.detail(Number.parseInt(c.req.param("id"), 10) || 0);
  if (!detail) return text("No such request\n", 404);
  return Response.json(detail);
});

app.get("/:name/connect", async (c) => {
  const access = await authorize(c);
  if ("response" in access) return access.response;
  const role = c.req.query("role") === "forward" ? "forward" : "watch";
  if (role === "forward" && !(access.owner && access.meta.owned)) return text("Forwarding needs the owner token and a beam created with it\n", 403);
  if (c.req.header("upgrade")?.toLowerCase() !== "websocket") return text("Connect with a WebSocket\n", 426);
  return access.stub.fetch(new Request(`https://beam.internal/connect?role=${role}`, c.req.raw));
});

app.notFound((c) => (wantsHtml(c.req.raw.headers) ? c.html(notFoundPage(), 404) : text("Not found\n", 404)));

async function authorize(c: AppContext): Promise<Access> {
  if (!(await allowed(c, c.env.LOOKUPS))) return { response: tooMany() };
  const name = c.req.param("name") ?? "";
  if (!validName(name)) return { response: text("No such beam\n", 404) };
  const stub = c.env.BEAMS.getByName(name);
  const meta = await stub.meta();
  if (!meta) return { response: text("No such beam\n", 404) };
  const owner = isOwner(c);
  const key = credential(c);
  if (!owner && (!key || !same(key, meta.key))) return { response: text("This beam needs its key\n", 401) };
  return { meta, stub, owner };
}

function created(c: AppContext, meta: BeamMeta): Response {
  const url = beamUrl(meta.name, c.env.TUNNEL_DOMAIN);
  const watch = `${new URL(c.req.url).origin}/${meta.name}#${meta.key}`;
  const headers = { "X-Beam-Name": meta.name, "X-Beam-Key": meta.key, "X-Beam-Watch": watch };
  if (c.req.header("accept")?.includes("application/json")) {
    return Response.json({ name: meta.name, url, key: meta.key, watch, owned: meta.owned }, { status: 201, headers });
  }
  return text(`${url}\n`, 201, headers);
}

function credential(c: AppContext): string | null {
  const authorization = c.req.header("authorization");
  if (authorization?.startsWith("Bearer ")) return authorization.slice(7).trim();
  const protocols = (c.req.header("sec-websocket-protocol") ?? "").split(",").map((value) => value.trim());
  if (protocols[0] === "beam" && protocols[1]) return protocols[1];
  return null;
}

function isOwner(c: AppContext): boolean {
  const token = c.env.BEAM_TOKEN;
  const presented = credential(c);
  return Boolean(token && presented && same(presented, token));
}

function same(a: string, b: string): boolean {
  const encoder = new TextEncoder();
  const left = encoder.encode(a);
  const right = encoder.encode(b);
  return left.byteLength === right.byteLength && crypto.subtle.timingSafeEqual(left, right);
}

async function allowed(c: AppContext, limiter: RateLimit): Promise<boolean> {
  const address = c.req.header("cf-connecting-ip");
  if (!address) return true;
  return (await limiter.limit({ key: address })).success;
}

function beamUrl(name: string, domain: string): string {
  return `https://${name}.${domain}`;
}

function wantsHtml(headers: Headers): boolean {
  const crawler = /WhatsApp|facebookexternalhit|Facebot|meta-externalagent|Twitterbot|LinkedInBot|Slackbot|Discordbot|TelegramBot|Googlebot|bingbot/i;
  return (headers.get("accept") ?? "").includes("text/html") || crawler.test(headers.get("user-agent") ?? "");
}

function tooMany(): Response {
  return text("Too many requests. Try again in a minute.\n", 429, { "Retry-After": "60" });
}

function text(body: string, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(body, { status, headers: { "Content-Type": "text/plain; charset=utf-8", ...headers } });
}
