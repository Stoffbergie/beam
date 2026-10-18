const SOURCE_URL = "https://github.com/Stoffbergie/beam";
const TAGLINE = "Your localhost, on the internet.";

const STYLE = `
:root{--bg:#fafafa;--fg:#171717;--muted:#737373;--line:#e5e5e5;color-scheme:light dark}
@media (prefers-color-scheme:dark){:root{--bg:#0a0a0a;--fg:#ededed;--muted:#8f8f8f;--line:#262626}}
*{box-sizing:border-box;margin:0;padding:0}
html{background:var(--bg);color:var(--fg);font:14px/1.7 ui-monospace,SFMono-Regular,"SF Mono",Menlo,Consolas,"Liberation Mono",monospace;-webkit-text-size-adjust:100%}
body{max-width:52rem;margin:0 auto;padding:14vh 1.5rem 6rem}
a{color:inherit;text-decoration-color:var(--muted);text-underline-offset:3px}
header{margin-bottom:3.5rem}
header a{font-weight:600;text-decoration:none}
h1{font-size:1rem;font-weight:600;overflow-wrap:anywhere}
h2{margin:3rem 0 .75rem;color:var(--muted);font-size:.75rem;font-weight:400;letter-spacing:.08em;text-transform:uppercase}
p{color:var(--muted)}
dt,code{font:inherit;overflow-wrap:anywhere;user-select:all}
footer{margin-top:4rem}
.commands{display:grid;grid-template-columns:minmax(0,1fr) 12rem;gap:.8rem 2rem}
.commands dd{margin:0;color:var(--muted)}
details{margin-top:2.5rem}
summary{color:var(--muted);cursor:pointer}
details p{margin-top:2rem}
.log{margin-top:2rem;border-top:1px solid var(--line)}
.row{display:grid;grid-template-columns:5.5rem 4.5rem minmax(0,1fr) 3.5rem 5rem;gap:1rem;padding:.35rem 0;border-bottom:1px solid var(--line);cursor:pointer;width:100%;background:none;border-left:0;border-right:0;border-top:0;color:inherit;font:inherit;text-align:left}
.row span:nth-child(3){overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.row .dim,.dim{color:var(--muted)}
pre{margin:.5rem 0 1rem;padding:.75rem 0;overflow-x:auto;white-space:pre-wrap;overflow-wrap:anywhere;color:var(--fg)}
@media(max-width:600px){.commands{grid-template-columns:1fr;gap:0}.commands dd{margin-bottom:1rem}.row{grid-template-columns:4rem minmax(0,1fr) 3rem}.row span:nth-child(1),.row span:nth-child(5){display:none}}
:focus-visible{outline:2px solid var(--fg);outline-offset:3px}
`;

type Row = [command: string, label: string, description: string];
type Section = { title: string; rows: Row[] };

function usage(origin: string, domain: string): Section[] {
  return [
    {
      title: "Catch webhooks",
      rows: [
        [
          `curl -i -X POST ${origin}`,
          "Get a URL",
          "Creates a URL that records every request sent to it and replies ok. The response has the URL, an X-Beam-Key header for reading what arrived and an X-Beam-Watch link that shows requests live in a browser. Anyone can make one, and it lasts 7 days after its last request."
        ],
        [
          `curl https://<name>.${domain}/stripe -d '{"paid":true}'`,
          "Send it a webhook",
          "Any method, path, header and body is recorded. Bodies are kept up to 1 MB each, and the latest 100 requests are kept."
        ],
        [
          `curl -H 'Authorization: Bearer <key>' ${origin}/<name>`,
          "See what arrived",
          "Returns JSON with the URL, whether it is forwarding, when it expires and the latest requests. Add /requests/<id> for one request with its headers and body."
        ]
      ]
    },
    {
      title: "Share a local port",
      rows: [
        ["brew install stoffbergie/tap/beam", "Install the CLI", "The beam CLI for macOS and Linux. Catching works for anyone; forwarding needs the owner token, set once with beam config --token."],
        [
          `beam 3000`,
          "Put localhost:3000 online",
          `Gives localhost:3000 a public https URL on ${domain}. WebSockets pass through, so hot reload works. Every request is recorded too, and beam reconnects on its own if the network drops.`
        ],
        [`beam 3000 -- npm run dev`, "Start an app and share it", "Starts the command, waits for the port to open, then shares it. Stopping beam stops the app."]
      ]
    },
    {
      title: "More",
      rows: [
        ["beam", "Catch in your terminal", "Creates a catching URL and prints each request as it arrives."],
        ["beam 3000 --name app", "Pick the name", `Uses a fixed URL like app.${domain} and keeps it every time you start beam with that name.`],
        [
          "beam replay <name> --to 3000",
          "Replay a webhook",
          "Sends the latest recorded request again, or the request ids you list, to a local port or URL. Useful for webhooks that arrived while your server was down."
        ],
        ["beam watch <name>", "Watch a beam", "Prints requests to a beam created earlier as they arrive."],
        [`curl -X DELETE -H 'Authorization: Bearer <key>' ${origin}/<name>`, "Delete a beam", "Removes the URL and everything it recorded straight away."]
      ]
    }
  ];
}

const LIMITS =
  "Beams last 7 days after their last request or connection. Each keeps its latest 100 requests with bodies up to 1 MB. Errors are plain text: 401 missing key, 403 owner only, 404 unknown beam, 429 too many requests. A forwarded request waits up to 100 seconds for your server.";

export function homeText(origin: string, domain: string): string {
  const lines = [`beam: ${TAGLINE.toLowerCase()}`, ""];
  for (const section of usage(origin, domain)) {
    lines.push(section.title.toUpperCase());
    for (const [command, , description] of section.rows) lines.push(`  ${command}`, `      ${description}`);
    lines.push("");
  }
  lines.push(LIMITS, "");
  return lines.join("\n");
}

export function homePage(origin: string, domain: string): string {
  const sections = usage(origin, domain).map((section) => {
    const rows = section.rows.map(([command, label, description]) => `<dt>${escapeHtml(command)}</dt><dd>${escapeHtml(label)}<span hidden> ${escapeHtml(description)}</span></dd>`).join("");
    return `<h2>${section.title}</h2><dl class="commands">${rows}</dl>`;
  });
  return layout(
    `beam · ${TAGLINE}`,
    `<h1>${TAGLINE}</h1>
${sections.slice(0, 2).join("")}
<details><summary>More options</summary>${sections.slice(2).join("")}<p>${escapeHtml(LIMITS)}</p></details>
<footer><p><a href="${SOURCE_URL}">Source</a></p></footer>
<script type="application/ld+json">${JSON.stringify({ "@context": "https://schema.org", "@type": "WebSite", name: "beam", url: `${origin}/`, description: TAGLINE })}</script>`,
    {
      description: `${TAGLINE} Share a local port with a public URL, or catch and replay webhooks. No accounts.`,
      url: `${origin}/`,
      image: `${origin}/social/beam.png`,
      index: true
    }
  );
}

export function viewerPage(name: string, domain: string): string {
  const url = `https://${name}.${domain}`;
  return layout(
    `${name} · beam`,
    `<h1>${escapeHtml(url)}</h1>
<p id="state">Connecting…</p>
<div class="log" id="log"></div>
<script>${VIEWER_SCRIPT.replace("__NAME__", JSON.stringify(name))}</script>`,
    { description: "Requests to a beam, live." }
  );
}

export function offlinePage(name: string): string {
  return layout(`${name} · beam`, `<h1>This beam is offline</h1>\n<p>Nothing is forwarding to it right now. Try again in a moment.</p>`, { description: "This beam is offline." });
}

export function notFoundPage(): string {
  return layout("Not found · beam", `<h1>Not found</h1>\n<p>Nothing is beaming here.</p>`, { description: "Nothing is beaming here." });
}

const VIEWER_SCRIPT = `
const name = __NAME__
const key = location.hash.slice(1)
const state = document.getElementById("state")
const log = document.getElementById("log")
const rows = new Map()
const size = (bytes) => bytes < 1024 ? bytes + " B" : bytes < 1048576 ? (bytes / 1024).toFixed(1) + " KB" : (bytes / 1048576).toFixed(1) + " MB"
const time = (iso) => new Date(iso).toLocaleTimeString()
const render = (request, prepend) => {
  let row = rows.get(request.id)
  if (!row) {
    row = document.createElement("button")
    row.className = "row"
    row.innerHTML = "<span class=dim></span><span></span><span></span><span class=dim></span><span class=dim></span>"
    row.addEventListener("click", () => toggle(request.id, row))
    rows.set(request.id, row)
    if (prepend) log.prepend(row)
    else log.append(row)
  }
  const cells = row.children
  cells[0].textContent = time(request.at)
  cells[1].textContent = request.method
  cells[2].textContent = request.path
  cells[3].textContent = request.status ?? "…"
  cells[4].textContent = size(request.size)
}
const toggle = async (id, row) => {
  const open = row.nextElementSibling
  if (open && open.tagName === "PRE") return open.remove()
  const pre = document.createElement("pre")
  pre.textContent = "Loading…"
  row.after(pre)
  const response = await fetch("/" + name + "/requests/" + id, { headers: { Authorization: "Bearer " + key } })
  const detail = await response.json()
  let body = detail.bodyEncoding === "base64" ? "(binary, " + size(detail.size) + ")" : detail.body
  try { body = JSON.stringify(JSON.parse(body), null, 2) } catch {}
  const headers = Object.entries(detail.headers).map(([k, v]) => k + ": " + v).join("\\n")
  pre.textContent = detail.method + " " + detail.path + "\\n" + headers + (body ? "\\n\\n" + body : "") + (detail.truncated ? "\\n\\n(body cut at 1 MB)" : "")
}
const describe = (forwarding) => {
  state.textContent = forwarding ? "Forwarding to a local server. New requests appear below." : "Catching. Send requests to the URL above; they appear below."
}
const start = async () => {
  if (!key) return void (state.textContent = "This link is missing its key. Use the full link with #key at the end.")
  const response = await fetch("/" + name, { headers: { Authorization: "Bearer " + key } })
  if (!response.ok) return void (state.textContent = response.status === 401 ? "That key does not match this beam." : "This beam does not exist or has expired.")
  const beam = await response.json()
  describe(beam.forwarding)
  beam.requests.forEach((request) => render(request, false))
  const connect = () => {
    const socket = new WebSocket((location.protocol === "https:" ? "wss://" : "ws://") + location.host + "/" + name + "/connect", ["beam", key])
    socket.onmessage = (event) => {
      const message = JSON.parse(event.data)
      if (message.t === "request") render(message.request, true)
      if (message.t === "hello" || message.t === "forwarding") describe(message.forwarding)
      const row = rows.get(message.id)
      if (row && message.t === "status") row.children[3].textContent = message.status
      if (row && message.t === "size") row.children[4].textContent = size(message.size)
    }
    socket.onclose = () => setTimeout(connect, 2000)
  }
  connect()
}
start()
`;

function layout(title: string, body: string, metadata: { description: string; url?: string; image?: string; index?: boolean }): string {
  const social =
    metadata.url && metadata.image
      ? `<link rel="canonical" href="${escapeHtml(metadata.url)}">
<meta property="og:type" content="website">
<meta property="og:site_name" content="beam">
<meta property="og:title" content="${escapeHtml(title)}">
<meta property="og:description" content="${escapeHtml(metadata.description)}">
<meta property="og:url" content="${escapeHtml(metadata.url)}">
<meta property="og:image" content="${escapeHtml(metadata.image)}">
<meta property="og:image:width" content="1200">
<meta property="og:image:height" content="630">
<meta property="og:image:alt" content="${escapeHtml(TAGLINE)}">
<meta name="twitter:card" content="summary_large_image">
<meta name="twitter:title" content="${escapeHtml(title)}">
<meta name="twitter:description" content="${escapeHtml(metadata.description)}">
<meta name="twitter:image" content="${escapeHtml(metadata.image)}">`
      : "";
  return `<!doctype html>
<html lang="en" prefix="og: https://ogp.me/ns#">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="color-scheme" content="light dark">
<title>${escapeHtml(title)}</title>
<meta name="description" content="${escapeHtml(metadata.description)}">
<meta name="robots" content="${metadata.index ? "index, follow" : "noindex, nofollow"}">
${social}
<link rel="icon" href="/favicon.png" type="image/png">
<link rel="apple-touch-icon" href="/apple-touch-icon.png">
<style>${STYLE}</style>
</head>
<body>
<header><a href="/">beam</a></header>
<main>
${body}
</main>
</body>
</html>`;
}

function escapeHtml(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}
