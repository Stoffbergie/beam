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
@media(max-width:600px){.commands{grid-template-columns:1fr;gap:0}.commands dd{margin-bottom:1rem}}
:focus-visible{outline:2px solid var(--fg);outline-offset:3px}
`;

type Row = [command: string, label: string, description: string];
type Section = { title: string; rows: Row[] };

const HEADLINE = "Share localhost in one command.";

const AUTOMATION_GUIDANCE =
  "Agents and automation: beam serves a local port on a public URL and needs the owner token, so only run beam <port> when the user has set it up with beam config --token. Never print, log or share the owner token. To catch or replay webhooks, use hook.stoff.dev instead.";

function usage(domain: string): Section[] {
  return [
    { title: "Install", rows: [["brew install stoffbergie/tap/beam", "", "Install the beam CLI with Homebrew on macOS or Linux."]] },
    {
      title: "Use",
      rows: [
        ["beam 3000", "Share a port", `Give localhost:3000 a public https URL on ${domain}. WebSockets pass through, so hot reload works.`],
        ["beam 3000 -- npm run dev", "Start and share", "Start the command, wait for the port to open, then share it. Stopping beam stops the app."],
        ["beam 3000 --name app", "Pick the URL", `Use a fixed URL like app.${domain} instead of a random one, and keep it every time you start beam with that name.`]
      ]
    },
    {
      title: "More",
      rows: [
        ["beam config --token <token>", "Set the owner token", "beam only serves the owner's machines. Save the owner token once on each machine."],
        ["beam http://127.0.0.1:8080", "Share any local URL", "Share a host and port other than localhost, or a local https server."]
      ]
    }
  ];
}

const LIMITS = "A URL works while beam is running and shows an offline page when it stops. A request waits up to 100 seconds for your server. Catching webhooks without a server? Use hook.stoff.dev.";

export function homeText(domain: string): string {
  const lines = [`beam: ${TAGLINE.toLowerCase()}`, "", AUTOMATION_GUIDANCE, ""];
  for (const section of usage(domain)) {
    lines.push(section.title.toUpperCase());
    const width = Math.max(...section.rows.map(([command]) => command.length));
    for (const [command, , description] of section.rows) lines.push(`  ${command.padEnd(width)}  # ${description}`);
    lines.push("");
  }
  lines.push(LIMITS, "");
  return lines.join("\n");
}

export function homePage(origin: string, domain: string): string {
  const sections = usage(domain).map((section) => {
    const rows = section.rows.map(([command, label, description]) => `<dt>${escapeHtml(command)}</dt><dd>${escapeHtml(label)}<span hidden> ${escapeHtml(description)}</span></dd>`).join("");
    return `<h2>${section.title}</h2><dl class="commands">${rows}</dl>`;
  });
  return layout(
    `beam · ${HEADLINE}`,
    `<h1>${HEADLINE}</h1>
<p hidden id="automation">${escapeHtml(AUTOMATION_GUIDANCE)}</p>
${sections.slice(0, 2).join("")}
<details><summary>More options</summary>${sections.slice(2).join("")}<p>${escapeHtml(LIMITS)}</p></details>
<footer><p><a href="${SOURCE_URL}">Source</a></p></footer>
<script type="application/ld+json">${JSON.stringify({ "@context": "https://schema.org", "@type": "WebSite", name: "beam", url: `${origin}/`, description: TAGLINE })}</script>`,
    {
      description: `${TAGLINE} Share a local port with a public https URL, WebSockets and all.`,
      url: `${origin}/`,
      image: `${origin}/social/beam.png`,
      index: true
    }
  );
}

export function offlinePage(host: string): string {
  return layout(`${host} · beam`, `<h1>This beam is offline</h1>\n<p>Nothing is forwarding to it right now. Try again in a moment.</p>`, { description: "This beam is offline." });
}

export function notFoundPage(): string {
  return layout("Not found · beam", `<h1>Not found</h1>\n<p>Nothing is beaming here.</p>`, { description: "Nothing is beaming here." });
}

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
