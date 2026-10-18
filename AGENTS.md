Contract notes for this repo:

- beam is one Cloudflare Worker, one Durable Object per beam, and a Rust CLI. Keep it that way: no accounts and nothing stored. Webhook catching and replay live in Stoffbergie/hook.
- beam.stoff.dev serves the homepage and the CLI's `/<name>/connect` WebSocket. Every `<name>.beam.stoff.dev` URL is routed to the Durable Object named after it. The managed certificate for the beam.stoff.dev custom domain also covers `*.beam.stoff.dev`; removing that custom domain would remove the wildcard certificate too.
- Connecting needs the owner token (`BEAM_TOKEN` secret), so strangers can never serve content from the domain. The CLI picks a random name unless given `--name`, and the Durable Object sends the public URL in a `hello` frame.
- With nothing connected, a beam URL answers 503 with an offline page for browsers and 502 text otherwise. Durable Objects from the old recording version clear their storage when their alarm fires.
- The CLI and the Durable Object speak JSON control frames plus binary frames of `[type u8][stream id u32 BE][payload]`: 1 request body, 2 response body, 3 WebSocket message. Change both sides together.
- In the Durable Object, streams must be read and written in the request context that created them. Response bodies are pull-based streams fed from an in-memory queue, and sockets that carry binary set `binaryType = "arraybuffer"`.
- The usage rows in `src/pages.ts` are the documentation: the homepage, its hidden descriptions for agents and the text that curl gets come from them.
- Pages are monospace, monotone and framework-free, with system fonts only, matching keep.stoff.dev and reach.stoff.dev.
- Tests are end-to-end in `tests/e2e` against the real Worker with the real CLI and real local servers. Cover user workflows, not internals.
