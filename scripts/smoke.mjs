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

function randomRenderTile() {
  const lon = RENDER_BOX.west + Math.random() * (RENDER_BOX.east - RENDER_BOX.west);
  const lat = RENDER_BOX.south + Math.random() * (RENDER_BOX.north - RENDER_BOX.south);
  return { z: RENDER_Z, ...lonLatToTile(lon, lat, RENDER_Z) };
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

function pngSize(buf) {
  const b = new Uint8Array(buf);
  if (b.length < 24 || b[0] !== 0x89 || b[1] !== 0x50) return null;
  const dv = new DataView(buf);
  return { width: dv.getUint32(16), height: dv.getUint32(20) };
}

async function checkTile(label, url, { expectPng = false, allowEmpty = false } = {}) {
  try {
    const res = await get(url);
    if (res.status === 204 && allowEmpty) return ok(`${label} (204 empty)`);
    if (res.status !== 200) return fail(label, `HTTP ${res.status}`);
    const body = await res.arrayBuffer();
    if (body.byteLength === 0 && !allowEmpty) return fail(label, "empty body");
    if (expectPng) {
      const size = pngSize(body);
      if (!size) return fail(label, "not a PNG");
      if (size.width !== 512) return fail(label, `width ${size.width}, expected 512`);
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

const catalog = await checkJson("catalog.json", `${BASE}/catalog.json`);
const tilesets = catalog?.tilesets ?? [];
if (!tilesets.length) fail("catalog.json", "no tilesets");

// ---- per-tileset checks (all concurrent) ----------------------------

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

for (const theme of ["light", "dark"]) {
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
        const size = pngSize(await res.arrayBuffer());
        if (!size || size.width !== 512) return warn(label, "bad PNG");
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

console.log(
  `\nsmoke: ${failures.length} failed, ${warnings.length} warnings ` +
    `(base ${BASE})`,
);
if (failures.length) process.exit(1);
