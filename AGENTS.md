Contract notes for this repo:

- beam is one Cloudflare Worker, one Durable Object per beam, and a Rust CLI. Keep it that way: no accounts, no database beyond each Durable Object's SQLite.
- beam.stoff.dev serves the homepage, the API and the live viewer. Every `<name>.beam.stoff.dev` URL is routed to the Durable Object named after it. The managed certificate for the beam.stoff.dev custom domain also covers `*.beam.stoff.dev`; removing that custom domain would remove the wildcard certificate too.
- Anyone can create a catching beam; it records requests and replies `ok`. Choosing a name and forwarding need the owner token (`BEAM_TOKEN` secret), so strangers can never serve content from the domain.
- Reading or deleting a beam needs its key or the owner token. Browsers carry the key in the URL fragment and the WebSocket subprotocol, never in a query string.
- The CLI and the Durable Object speak JSON control frames plus binary frames of `[type u8][stream id u32 BE][payload]`: 1 request body, 2 response body, 3 WebSocket message. Change both sides together.
- In the Durable Object, streams must be read and written in the request context that created them. Response bodies are pull-based streams fed from an in-memory queue, and sockets that carry binary set `binaryType = "arraybuffer"`.
- Each beam keeps its latest 100 requests with bodies up to 1 MB and deletes itself with an alarm 7 days after its last use.
- The usage rows in `src/pages.ts` are the documentation: the homepage, its hidden descriptions for agents and the text that curl gets come from them.
- Pages are monospace, monotone and framework-free, with system fonts only, matching keep.stoff.dev and reach.stoff.dev.
- Tests are end-to-end in `tests/e2e` against the real Worker with the real CLI and real local servers. Cover user workflows, not internals.
