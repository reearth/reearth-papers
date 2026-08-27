// The credits page every tile's short credit points at (/attribution,
// and /attribution.json for the same thing machine-readable).
//
// Nothing here is written by hand twice. The sources and licences come
// from src/credits.ts; which tilesets sit under each of them is read
// back off the registries that serve those tilesets — `credits` on a
// TilesetDef, the theme list for the rendered rasters, the paint
// manifest for the paint shelf. A tileset therefore cannot be served
// without appearing on this page, which is the condition under which
// its sources may be folded out of the map credit at all.

import {
  CREDIT_GROUPS,
  type Credit,
  type CreditGroup,
  type CreditGroupId,
  attributionOf,
} from "./credits.js";
import { paintStyles } from "./paint_styles.js";
import { THEMES } from "./style.js";
import { TILESETS } from "./tilesets.js";

/** Public ids of everything covered by each credit group, in the order
 *  a reader meets them: rendered themes, then registered tilesets, then
 *  the paint shelf (which is published to R2 rather than compiled in). */
async function membership(env: Env): Promise<Record<CreditGroupId, string[]>> {
  const ids = {} as Record<CreditGroupId, string[]>;
  for (const id of Object.keys(CREDIT_GROUPS) as CreditGroupId[]) ids[id] = [];

  // The themed rasters are style permutations of one source and live
  // outside the tileset registry (see style.ts), so they are named here.
  for (const theme of THEMES) ids.osm.push(`styles/${theme}`);

  // The route id, not the catalog id: this page is read next to a URL.
  for (const t of TILESETS) ids[t.credits].push(t.id);

  // A paint style is published without a deploy; an unreadable manifest
  // leaves the shelf unlisted rather than the page broken.
  for (const s of await paintStyles(env)) ids.paint.push(`styles/${s.name}`);

  return ids;
}

const ESCAPES: Record<string, string> = {
  "&": "&amp;",
  "<": "&lt;",
  ">": "&gt;",
  '"': "&quot;",
};

const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ESCAPES[c]);

function creditHtml(c: Credit): string {
  const name = c.url ? `<a href="${esc(c.url)}">${esc(c.name)}</a>` : esc(c.name);
  const license = c.licenseUrl
    ? `<a href="${esc(c.licenseUrl)}">${esc(c.license)}</a>`
    : esc(c.license);
  const note = c.note ? `<p class="note">${esc(c.note)}</p>` : "";
  const onMap = c.onMap
    ? '<span class="tag" title="This licence requires its notice on the map itself">on the map</span>'
    : "";
  return `<li><span class="src">${name}</span>${onMap}<span class="lic">${license}</span>${note}</li>`;
}

function groupHtml(id: CreditGroupId, g: CreditGroup, ids: string[]): string {
  return `<section>
  <h2>${esc(g.title)}</h2>
  <p class="ids">${ids.length ? esc(ids.join(" · ")) : "&mdash;"}</p>
  ${g.note ? `<p class="note">${esc(g.note)}</p>` : ""}
  <ul>${g.credits.map(creditHtml).join("")}</ul>
  <p class="credit">Map credit: ${attributionOf(id)}</p>
</section>`;
}

const PAGE_CSS = `
/* EB Garamond (SIL OFL 1.1), self-hosted under /webfont/ — the same
   face the preview page and the social card are set in, so the wordmark
   is one wordmark. See public/index.html for the pair of subsets. */
@font-face { font-family:'EB Garamond'; font-style:normal; font-weight:400 700;
  font-display:swap; src:url(/webfont/ebgaramond-latin.woff2) format('woff2');
  unicode-range:U+0000-00FF,U+0131,U+0152-0153,U+02BB-02BC,U+02C6,U+02DA,U+02DC,
    U+0304,U+0308,U+0329,U+2000-206F,U+20AC,U+2122,U+2191,U+2193,U+2212,U+2215,
    U+FEFF,U+FFFD; }
@font-face { font-family:'EB Garamond'; font-style:normal; font-weight:400 700;
  font-display:swap; src:url(/webfont/ebgaramond-latin-ext.woff2) format('woff2');
  unicode-range:U+0100-02BA,U+02BD-02C5,U+02C7-02CC,U+02CE-02D7,U+02DD-02FF,U+0304,
    U+0308,U+0329,U+1D00-1DBF,U+1E00-1E9F,U+1EF2-1EFF,U+2020,U+20A0-20AB,U+20AD-20C0,
    U+2113,U+2C60-2C7F,U+A720-A7FF; }
:root { --paper:#f7f4ee; --edge:#e3ded3; --ink:#1f1c17; --soft:#8a8273; --accent:#b4490e; --card:#fffdf9;
        --font-display:'EB Garamond','Iowan Old Style','Palatino Linotype',Palatino,Georgia,serif;
        --font-sans:system-ui,-apple-system,sans-serif;
        --font-mono:ui-monospace,SFMono-Regular,Menlo,monospace; }
* { box-sizing:border-box; }
body { margin:0; padding:32px 20px 64px; background:var(--paper); color:var(--ink);
       font:14px/1.6 var(--font-sans); }
main { max-width:760px; margin:0 auto; }
h1 { margin:0 0 4px; font:400 27px/1.2 var(--font-display); letter-spacing:.027em; }
.sub { margin:0 0 24px; color:var(--soft); font-size:12px; letter-spacing:.14em; text-transform:uppercase; }
.lede { margin:0 0 28px; }
a { color:var(--accent); }
section { margin:0 0 22px; padding:14px 16px; background:var(--card);
          border:1px solid var(--edge); border-radius:10px; }
h2 { margin:0 0 2px; font:500 17px/1.3 var(--font-display); }
.ids { margin:0 0 10px; font:11px/1.5 var(--font-mono);
       color:var(--soft); overflow-wrap:anywhere; }
ul { margin:0; padding:0; list-style:none; }
li { padding:8px 0; border-top:1px solid var(--edge); }
.src { font-weight:600; }
.lic { display:block; font-size:12px; color:var(--soft); }
.tag { margin-left:8px; font:600 9px/1 var(--font-mono);
       letter-spacing:.1em; text-transform:uppercase; color:var(--accent);
       border:1px solid var(--accent); border-radius:4px; padding:3px 5px; vertical-align:2px; }
.note { margin:4px 0 0; font-size:12px; color:var(--soft); }
.credit { margin:10px 0 0; padding-top:10px; border-top:1px dashed #c9c2b2; font-size:12px; color:var(--soft); }
.credit a { color:var(--accent); }
footer { margin-top:28px; font-size:12px; color:var(--soft); }
`;

function page(ids: Record<CreditGroupId, string[]>): string {
  const sections = (Object.keys(CREDIT_GROUPS) as CreditGroupId[])
    .map((id) => groupHtml(id, CREDIT_GROUPS[id], ids[id]))
    .join("\n");
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<title>Attribution — Re:Earth Papers</title>
<meta name="viewport" content="width=device-width,initial-scale=1" />
<meta property="og:type" content="website" />
<meta property="og:site_name" content="Re:Earth Papers" />
<meta property="og:title" content="Attribution — Re:Earth Papers" />
<meta property="og:description" content="What each tileset is built from, and under which licence." />
<meta property="og:image" content="https://papers.reearth.land/og.png" />
<meta property="og:image:width" content="1200" />
<meta property="og:image:height" content="630" />
<meta name="twitter:card" content="summary_large_image" />
<link rel="icon" href="/favicon.ico" sizes="any" />
<link rel="apple-touch-icon" href="/apple-touch-icon.png" />
<style>${PAGE_CSS}</style>
</head>
<body>
<main>
<h1>Attribution</h1>
<p class="sub">Re:Earth Papers</p>
<p class="lede">
  Every tile we serve carries a short credit in its TileJSON, and that
  credit links here. This page is the rest of it: what each tileset is
  built from, under which licence. A name marked <span class="tag">on the
  map</span> is one whose licence requires the notice on the map itself —
  display those wherever the tiles are shown. The others are satisfied by
  a link to this page, which is what the credit does for you.
</p>
${sections}
<footer>
  Machine-readable: <a href="/attribution.json">attribution.json</a>.
  Source: <a href="https://github.com/reearth/reearth-papers">reearth/reearth-papers</a>.
</footer>
</main>
</body>
</html>`;
}

function json(ids: Record<CreditGroupId, string[]>): unknown {
  return {
    name: "Re:Earth Papers — attribution",
    description:
      "Sources behind every tileset. Credits marked `onMap` must be " +
      "displayed on the map itself; the rest are satisfied by a link to " +
      "https://papers.reearth.land/attribution.",
    groups: (Object.keys(CREDIT_GROUPS) as CreditGroupId[]).map((id) => {
      const g = CREDIT_GROUPS[id];
      return {
        id,
        title: g.title,
        ...(g.note ? { note: g.note } : {}),
        tilesets: ids[id],
        attribution: attributionOf(id),
        credits: g.credits.map((c) => ({
          name: c.name,
          ...(c.url ? { url: c.url } : {}),
          license: c.license,
          ...(c.licenseUrl ? { licenseUrl: c.licenseUrl } : {}),
          ...(c.note ? { note: c.note } : {}),
          onMap: Boolean(c.onMap),
        })),
      };
    }),
  };
}

export async function handleAttribution(env: Env, asJson: boolean): Promise<Response> {
  const ids = await membership(env);
  return asJson
    ? new Response(JSON.stringify(json(ids), null, 2), {
        headers: {
          "content-type": "application/json; charset=utf-8",
          "access-control-allow-origin": "*",
          "cache-control": "public, max-age=3600",
        },
      })
    : new Response(page(ids), {
        headers: {
          "content-type": "text/html; charset=utf-8",
          "cache-control": "public, max-age=3600",
        },
      });
}
