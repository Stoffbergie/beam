import { app } from "./app";
import type { Env } from "./env";
import { tunnelName, validName } from "./names";

export { Beam } from "./beam";

export default {
  async fetch(request, env, ctx) {
    const name = tunnelName(new URL(request.url).hostname, env.TUNNEL_DOMAIN);
    if (name === null) return app.fetch(request, env, ctx);
    if (!validName(name)) return new Response("No beam here\n", { status: 404, headers: { "Content-Type": "text/plain; charset=utf-8" } });
    return env.BEAMS.getByName(name).fetch(request);
  }
} satisfies ExportedHandler<Env>;
