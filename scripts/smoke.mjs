#!/usr/bin/env node
// Post-deploy smoke test over the public API. Exits non-zero if any
// check fails, so the Deploy workflow goes red instead of leaving a
// broken pipeline in production.
//
// Every tileset in /catalog.json is exercised, and the themed rasters
// are fetched twice on purpose:
//
//   - a fixed Tokyo tile (the serving path: edge cache / R2 / worker
//     routing), and
//   - a RANDOM deep tile with a cache-buster (the render path: the
//     tile-cache key embeds the coordinates, so a random z14 tile is
//     never cached and forces mirror style → container → fonts on
//     every run).
//
// The distinction matters: a broken style pipeline once hid behind
// cached tiles for days and only surfaced after a STYLE_VERSION bump
// orphaned them (papers themes went fully blank). The random-tile leg
// would have caught that on the deploy that shipped it.
//
// Usage: node scripts/smoke.mjs [--base=https://papers.reearth.land]

const args = Object.fromEntries(
  process.argv.slice(2).map((a) => {
    const m = a.match(/^--([^=]+)=(.*)$/);
    return m ? [m[1], m[2]] : [a.replace(/^--/, ""), true];
  }),
);
const BASE = args.base ?? "https://papers.reearth.land";
const RUN = `smoke-${Date.now()}`;

// Fixed serving-path probe: central Tokyo, always has data.
const TOKYO = { z: 11, x: 1818, y: 806 };
// Render-path probe: a random z14 tile inside greater Tokyo, dense
// enough that an empty render would itself be suspicious.
const RENDER_Z = 14;
const RENDER_BOX = { west: 139.4, south: 35.5, east: 140.0, north: 35.85 };

const failures = [];
const warnings = [];
const ok = (label) => console.log(`ok      ${label}`);
const fail = (label, why) => {
  console.error(`FAIL    ${label} — ${why}`);
  failures.push(label);
};
const warn = (label, why) => {
  console.warn(`warn    ${label} — ${why}`);
  warnings.push(label);
};

function lonLatToTile(lon, lat, z) {
  const n = 2 ** z;
  const x = Math.floor(((lon + 180) / 360) * n);
  const latRad = (lat * Math.PI) / 180;
  const y = Math.floor(
    ((1 - Math.log(Math.tan(latRad) + 1 / Math.cos(latRad)) / Math.PI) / 2) * n,
  );
  return { x: Math.min(n - 1, Math.max(0, x)), y: Math.min(n - 1, Math.max(0, y)) };
}

function randomRenderTile(z = RENDER_Z) {
  const lon = RENDER_BOX.west + Math.random() * (RENDER_BOX.east - RENDER_BOX.west);
  const lat = RENDER_BOX.south + Math.random() * (RENDER_BOX.north - RENDER_BOX.south);
  return { z, ...lonLatToTile(lon, lat, z) };
}

/** Fetch with a timeout and one retry — cold containers legitimately
 *  take several seconds on the first render. */
async function get(url, { timeoutMs = 90_000, tries = 2 } = {}) {
  let lastErr;
  for (let i = 0; i < tries; i++) {
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) });
      if (res.status >= 500 && i + 1 < tries) {
        lastErr = new Error(`HTTP ${res.status}`);
        continue;
      }
      return res;
    } catch (e) {
      lastErr = e;
    }
  }
  throw lastErr;
}

// The themed rasters are advertised as WebP and served as either, so the
// dimension check reads both container formats rather than assuming PNG.
function rasterSize(buf) {
  const b = new Uint8Array(buf);
  const dv = new DataView(buf);
  if (b.length >= 24 && b[0] === 0x89 && b[1] === 0x50) {
    return { format: "png", width: dv.getUint32(16), height: dv.getUint32(20) };
  }
  // RIFF....WEBP; VP8L and lossless VP8 carry the size differently, so
  // read whichever chunk this is.
  const tag = (at, s) => String.fromCharCode(...b.subarray(at, at + s.length)) === s;
  if (b.length >= 30 && tag(0, "RIFF") && tag(8, "WEBP")) {
    if (tag(12, "VP8X")) {
      const w = 1 + (b[24] | (b[25] << 8) | (b[26] << 16));
      const h = 1 + (b[27] | (b[28] << 8) | (b[29] << 16));
      return { format: "webp", width: w, height: h };
    }
    if (tag(12, "VP8L")) {
      const bits = dv.getUint32(21, true);
      return {
        format: "webp",
        width: 1 + (bits & 0x3fff),
        height: 1 + ((bits >> 14) & 0x3fff),
      };
    }
    if (tag(12, "VP8 ")) {
      return {
        format: "webp",
        width: dv.getUint16(26, true) & 0x3fff,
        height: dv.getUint16(28, true) & 0x3fff,
      };
    }
    return { format: "webp", width: null, height: null };
  }
  return null;
}

async function checkTile(label, url, { expectPng = false, allowEmpty = false } = {}) {
  // `expectPng` predates the WebP default; it means "an image tile whose
  // dimensions we can check", either encoding.
  try {
    const res = await get(url);
    if (res.status === 204 && allowEmpty) return ok(`${label} (204 empty)`);
    if (res.status !== 200) return fail(label, `HTTP ${res.status}`);
    const body = await res.arrayBuffer();
    if (body.byteLength === 0 && !allowEmpty) return fail(label, "empty body");
    if (expectPng) {
      const size = rasterSize(body);
      if (!size) return fail(label, "not a PNG or WebP");
      if (size.width !== null && size.width !== 512) {
        return fail(label, `width ${size.width}, expected 512`);
      }
    }
    ok(label);
  } catch (e) {
    fail(label, e.message);
  }
}

async function checkJson(label, url) {
  try {
    const res = await get(url);
    if (res.status !== 200) return fail(label, `HTTP ${res.status}`);
    const body = await res.json();
    ok(label);
    return body;
  } catch (e) {
    fail(label, e.message);
    return null;
  }
}

const fill = (tpl, t) => tpl.replace("{z}", t.z).replace("{x}", t.x).replace("{y}", t.y);

// ---- catalog --------------------------------------------------------

// The whole suite lives in a function so it can run twice: right
// after a deploy, requests race the global rollout — the catalog can
// come from a new-code isolate while some tile fetches still hit
// old-code ones (this exact race painted a healthy deploy red once).
// On failures, wait for the rollout to settle and re-run everything;
// only a second consecutive failure is real.
async function runSuite() {
  failures.length = 0;
  warnings.length = 0;

  const catalog = await checkJson("catalog.json", `${BASE}/catalog.json`);
  const tilesets = catalog?.tilesets ?? [];
  if (!tilesets.length) fail("catalog.json", "no tilesets");

  // ---- per-tileset checks (all concurrent) --------------------------

  const jobs = [];
for (const t of tilesets) {
  const themed = Boolean(t.theme);
  jobs.push(
    (async () => {
      const tj = await checkJson(`${t.id} tilejson`, t.tilejson);
      const tpl = tj?.tiles?.[0];
      if (!tpl) return;

      if (themed) {
        // Styles must build for every theme — including the papers
        // ones, which take a different code path than the stock
        // Protomaps themes.
        await checkJson(`${t.id} style.json`, t.style);
        await checkJson(`${t.id} style.json?renderer=1`, `${t.style}?renderer=1`);
        // Serving path (may be cached — that's the point).
        await checkTile(`${t.id} tile (cached path)`, fill(tpl, TOKYO), {
          expectPng: true,
        });
        // Render path: never-cached random tile, full pipeline.
        const r = randomRenderTile();
        await checkTile(
          `${t.id} tile (fresh render ${r.z}/${r.x}/${r.y})`,
          `${fill(tpl, r)}?${RUN}`,
          { expectPng: true },
        );
        return;
      }

      // Paint styles (src/paint_styles.ts): rendered like the themes, but
      // from a document on the R2 shelf rather than a bundled recipe — so
      // the thing to prove is that the shelf is readable and the document
      // still builds. Same cached/fresh pair as the themes, plus the
      // params schema a client generates its UI from.
      //
      // And one negative: a paint style has no `style.json`, and that is
      // part of its contract rather than a gap to fill in later. A route
      // that starts answering there is a regression, so assert it does
      // not.
      if (t.params) {
        await checkJson(`${t.id} params.json`, t.params);
        const none = await get(`${BASE}/styles/${t.id}/style.json`, { tries: 1 });
        if (none.status === 200) {
          fail(`${t.id} style.json`, "answered; a paint style has no MapLibre style");
        } else {
          ok(`${t.id} style.json absent (HTTP ${none.status})`);
        }
        // These are rendered at the document's own canvas size, so only
        // assert dimensions where the TileJSON says 512 — the check
        // itself is hardcoded to that.
        const sized = { expectPng: (tj.tileSize ?? 512) === 512 };
        await checkTile(`${t.id} tile (cached path)`, fill(tpl, TOKYO), sized);
        // Fresh render at a zoom this style can actually serve — one
        // reading terrain stops at that source's maxzoom.
        const r = randomRenderTile(Math.min(RENDER_Z, tj.maxzoom ?? RENDER_Z));
        await checkTile(
          `${t.id} tile (fresh render ${r.z}/${r.x}/${r.y})`,
          `${fill(tpl, r)}?${RUN}`,
          sized,
        );
        return;
      }

      // Data tilesets: one tile at the TileJSON's own center. 204 is a
      // legitimate "no data here". Passthrough tilesets depend on a
      // third-party origin, so their failures only warn.
      const [lon, lat, cz] = tj.center ?? [139.767, 35.681, tj.minzoom ?? 2];
      const z = Math.min(tj.maxzoom ?? cz, Math.max(tj.minzoom ?? 0, Math.round(cz)));
      const tile = { z, ...lonLatToTile(lon, lat, z) };
      const label = `${t.id} tile (${z}/${tile.x}/${tile.y})`;
      if (t.passthrough) {
        try {
          const res = await get(fill(tpl, tile), { tries: 1, timeoutMs: 30_000 });
          if (res.status === 200 || res.status === 204) ok(`${label} (passthrough)`);
          else warn(label, `passthrough origin HTTP ${res.status}`);
        } catch (e) {
          warn(label, `passthrough origin: ${e.message}`);
        }
        return;
      }
      await checkTile(label, fill(tpl, tile), { allowEmpty: true });
    })(),
  );
}

// ---- ezu shadow renders (warning-only) ------------------------------
// The ezu route is a comparison shadow, not the serving path — a
// broken shadow shouldn't block a deploy, but we want to see it go
// yellow. Fresh random tile per theme, same reasoning as above.

for (const theme of [
  "papers-light",
  "papers-dark",
  "protomaps-light",
  "protomaps-dark",
  "protomaps-white",
  "protomaps-black",
  "protomaps-grayscale",
]) {
  jobs.push(
    (async () => {
      const r = randomRenderTile();
      const label = `ezu ${theme} (fresh render ${r.z}/${r.x}/${r.y})`;
      try {
        const res = await get(
          `${BASE}/styles/${theme}/ezu/${r.z}/${r.x}/${r.y}.png?${RUN}`,
          { timeoutMs: 120_000 },
        );
        if (res.status !== 200) return warn(label, `HTTP ${res.status}`);
        const size = rasterSize(await res.arrayBuffer());
        if (!size || (size.width !== null && size.width !== 512)) {
          return warn(label, "bad image");
        }
        ok(label);
      } catch (e) {
        warn(label, e.message);
      }
    })(),
  );
}

// ---- fonts ----------------------------------------------------------

jobs.push(
  (async () => {
    for (const [label, path, minBytes] of [
      ["fonts CJK range", "/fonts/Noto%20Sans%20Regular/26624-26879.pbf", 10_000],
      ["fonts PGF range", "/fonts/Noto%20Sans%20Devanagari%20Regular%20v1/62976-63231.pbf", 1_000],
    ]) {
      try {
        const res = await get(`${BASE}${path}`);
        if (res.status !== 200) {
          fail(label, `HTTP ${res.status}`);
          continue;
        }
        const body = await res.arrayBuffer();
        if (body.byteLength < minBytes) {
          fail(label, `only ${body.byteLength} bytes`);
          continue;
        }
        ok(label);
      } catch (e) {
        fail(label, e.message);
      }
    }
  })(),
);

  await Promise.all(jobs);
}

await runSuite();
if (failures.length) {
  console.log(
    `\n${failures.length} check(s) failed — waiting 60s for the ` +
      `rollout to settle, then retrying the whole suite once`,
  );
  await new Promise((resolve) => setTimeout(resolve, 60_000));
  await runSuite();
}

console.log(
  `\nsmoke: ${failures.length} failed, ${warnings.length} warnings ` +
    `(base ${BASE})`,
);
if (failures.length) process.exit(1);
