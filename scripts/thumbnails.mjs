#!/usr/bin/env node
// Fetch tiles for every raster tileset in the catalog around central
// Tokyo and stitch them into a single thumbnail PNG per tileset.
//
// Usage:
//   node scripts/thumbnails.mjs [--out=thumbnails] [--base=https://papers.reearth.land]

import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import sharp from "sharp";

const args = Object.fromEntries(
  process.argv.slice(2).map((a) => {
    const m = a.match(/^--([^=]+)=(.*)$/);
    return m ? [m[1], m[2]] : [a.replace(/^--/, ""), true];
  }),
);

const BASE = args.base ?? "https://papers.reearth.land";
const OUT = args.out ?? "thumbnails";
const TILE = 256;
const Z = Number(args.z ?? 13);
const WIDTH = Number(args.width ?? 1200);
const HEIGHT = Number(args.height ?? 630);

// Center on Tokyo Station.
const CENTER_LNG = Number(args.lng ?? 139.7671);
const CENTER_LAT = Number(args.lat ?? 35.6812);

function lngLatToTile(lng, lat, z) {
  const n = 2 ** z;
  const x = ((lng + 180) / 360) * n;
  const latRad = (lat * Math.PI) / 180;
  const y = ((1 - Math.log(Math.tan(latRad) + 1 / Math.cos(latRad)) / Math.PI) / 2) * n;
  return { x, y };
}

// World-pixel coords (no resizing — we tile, then crop).
const center = lngLatToTile(CENTER_LNG, CENTER_LAT, Z);
const px0 = center.x * TILE - WIDTH / 2;
const py0 = center.y * TILE - HEIGHT / 2;
const tx0 = Math.floor(px0 / TILE);
const ty0 = Math.floor(py0 / TILE);
const tx1 = Math.floor((px0 + WIDTH - 1) / TILE);
const ty1 = Math.floor((py0 + HEIGHT - 1) / TILE);
const COLS = tx1 - tx0 + 1;
const ROWS = ty1 - ty0 + 1;
const CROP_X = Math.round(px0 - tx0 * TILE);
const CROP_Y = Math.round(py0 - ty0 * TILE);

async function getJson(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${res.status} ${url}`);
  return res.json();
}

async function fetchTile(url) {
  const res = await fetch(url);
  if (res.status === 204) return null; // empty tile
  if (!res.ok) throw new Error(`${res.status} ${url}`);
  const buf = Buffer.from(await res.arrayBuffer());
  return buf.length ? buf : null;
}

function fillTemplate(tmpl, z, x, y) {
  return tmpl.replace("{z}", z).replace("{x}", x).replace("{y}", y);
}

async function buildThumbnail(id, tileTemplate) {
  const composites = [];
  for (let dy = 0; dy < ROWS; dy++) {
    for (let dx = 0; dx < COLS; dx++) {
      const x = tx0 + dx;
      const y = ty0 + dy;
      const url = fillTemplate(tileTemplate, Z, x, y);
      const buf = await fetchTile(url);
      if (!buf) {
        console.log(`  ${id} ${Z}/${x}/${y} (empty)`);
        continue;
      }
      console.log(`  ${id} ${Z}/${x}/${y}`);
      composites.push({ input: buf, top: dy * TILE, left: dx * TILE });
    }
  }
  const mosaic = await sharp({
    create: {
      width: COLS * TILE,
      height: ROWS * TILE,
      channels: 4,
      background: { r: 255, g: 255, b: 255, alpha: 0 },
    },
  })
    .composite(composites)
    .png()
    .toBuffer();
  return sharp(mosaic)
    .extract({ left: CROP_X, top: CROP_Y, width: WIDTH, height: HEIGHT })
    .png()
    .toBuffer();
}

await mkdir(OUT, { recursive: true });

console.log(
  `base=${BASE}  z=${Z}  out=${WIDTH}x${HEIGHT}  ` +
    `tiles=${COLS}x${ROWS} from (${tx0},${ty0})  crop offset=(${CROP_X},${CROP_Y})`,
);

const catalog = await getJson(`${BASE}/catalog.json`);
const rasters = (catalog.tilesets ?? []).filter((t) => t.type === "raster");

for (const ts of rasters) {
  console.log(`\n[${ts.id}]`);
  try {
    const tj = await getJson(ts.tilejson);
    const tmpl = tj.tiles?.[0];
    if (!tmpl) throw new Error("no tile template in tilejson");
    const png = await buildThumbnail(ts.id, tmpl);
    const path = join(OUT, `${ts.id}.png`);
    await writeFile(path, png);
    console.log(`  -> ${path} (${png.length} bytes)`);
  } catch (err) {
    console.error(`  ! failed: ${err.message}`);
  }
}
