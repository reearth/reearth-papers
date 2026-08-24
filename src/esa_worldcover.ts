// On-the-fly XYZ raster tiles for ESA WorldCover 2021 v200.
//
// Source data lives in R2 under `mirror/esa_worldcover_2021/`:
//   - per-3° COGs (`ESA_WorldCover_10m_2021_v200_*_Map.tif`) at native 10 m
//   - a single global `overview.tif` mosaic at ~1.78 km/px for low zooms
//
// For each output Web Mercator tile we invert Mercator to lat/lon for
// every output pixel and paint via a class-byte → palette lookup
// (NoData → transparent). The source we read depends on zoom:
//
//   z < OVERVIEW_MAX_Z    → single `overview.tif`, one window read
//   z ∈ [OVERVIEW_MAX_Z, MAX_RENDER_Z] → group pixels by the per-3°
//                          COG they fall in and read each window
//   z > MAX_RENDER_Z      → 404 (clients overzoom from the cap)
//
// Output formats: PNG (always) and WebP (via @jsquash/webp).

import { attributionOf } from "./credits.js";
import { fromCustomClient } from "geotiff";
import { pixelToLonLat, R2GeoTiffClient, TILE_SIZE } from "./cog.js";
import { encodePngRGBA, encodeWebpRGBA } from "./raster_encode.js";
import { serveRenderedTile } from "./render_cache.js";

export type EsaFormat = "png" | "webp";

interface TileCoords {
  z: number;
  x: number;
  y: number;
}

const SOURCE_PIXELS_PER_DEG = 12000; // 36000 px / 3°
// Zooms strictly below this read from overview.tif; ≥ this read from
// the per-3° COGs.
const OVERVIEW_MAX_Z = 8;
const MAX_RENDER_Z = 13;
const R2_PREFIX = "mirror/esa_worldcover_2021";
const OVERVIEW_KEY = `${R2_PREFIX}/overview.tif`;
// overview.tif geometry — fixed by the mirror builder. 22500 × 9000 px,
// 0.016°/px, origin at (-180°E, 84°N). Hard-coding lets us pick the
// IFD level synchronously without an extra metadata read.
const OVERVIEW_PIXELS_PER_DEG = 1 / 0.016; // = 62.5
const OVERVIEW_ORIGIN_LON = -180;
const OVERVIEW_ORIGIN_LAT = 84;
const OVERVIEW_WIDTH = 22500;
const OVERVIEW_HEIGHT = 9000;

// Official ESA WorldCover 2021 v200 palette (from the embedded color
// table in the source GeoTIFFs). NoData (=0) is intentionally absent —
// pixels at value 0 are written transparent.
const PALETTE: ReadonlyArray<readonly [number, number, number] | undefined> = (() => {
  const p = new Array<[number, number, number] | undefined>(256);
  p[10] = [0, 100, 0];      // Tree cover
  p[20] = [255, 187, 34];   // Shrubland
  p[30] = [255, 255, 76];   // Grassland
  p[40] = [240, 150, 255];  // Cropland
  p[50] = [250, 0, 0];      // Built-up
  p[60] = [180, 180, 180];  // Bare / sparse vegetation
  p[70] = [240, 240, 240];  // Snow and ice
  p[80] = [0, 100, 200];    // Permanent water bodies
  p[90] = [0, 150, 160];    // Herbaceous wetland
  p[95] = [0, 207, 117];    // Mangroves
  p[100] = [250, 230, 160]; // Moss and lichen
  return p;
})();

// Required by the dataset license — must appear in TileJSON and any
// visible product derived from the layer. Match the punctuation style
// used by the other tilesets in this worker (`·` separators).
export const ESA_WORLDCOVER_ATTRIBUTION = attributionOf("esaWorldcover");

// -- coordinate / grid helpers --------------------------------------------
// R2 transport + inverse Web Mercator shared with blackmarble.ts and
// naturalearth.ts — see src/cog.ts.

function gridName(lonSw: number, latSw: number): string {
  const ns = latSw >= 0 ? "N" : "S";
  const ew = lonSw >= 0 ? "E" : "W";
  return (
    ns +
    String(Math.abs(latSw)).padStart(2, "0") +
    ew +
    String(Math.abs(lonSw)).padStart(3, "0")
  );
}

function sourceKey(grid: string): string {
  return `${R2_PREFIX}/ESA_WorldCover_10m_2021_v200_${grid}_Map.tif`;
}

// Match output Web Mercator pixel density to the closest source COG
// overview level (0=base, larger=coarser). The native per-3° COGs are
// 12000 px/deg with 6 overviews — picking the smallest overview that
// still has enough resolution avoids decoding pixels we'd throw away.
function pickPerTileOverviewLevel(z: number): number {
  if (z >= 14) return 0;
  if (z === 13) return 1;
  if (z === 12) return 2;
  if (z === 11) return 3;
  if (z === 10) return 4;
  if (z === 9) return 5;
  return 6; // z=8
}

// Same idea, but against `overview.tif`: base is 62.5 px/deg and the
// COG ships 6 internal halvings (≈31.25, 15.6, 7.8, 3.9, 2.0, 0.97).
// Target px/deg per output zoom: 256 · 2^z / 360.
function pickOverviewLevel(z: number): number {
  if (z >= 6) return 0; // ≥45 px/deg target → base
  if (z === 5) return 1; // 22.8 → 31.25
  if (z === 4) return 2; // 11.4 → 15.6
  if (z === 3) return 3; // 5.7  → 7.8
  if (z === 2) return 4; // 2.84 → 3.9
  if (z === 1) return 5; // 1.42 → 2.0
  return 6;              // z=0, 0.71 → 0.97
}

// -- rendering -------------------------------------------------------------

interface CogGroup {
  gridLon: number;
  gridLat: number;
  outPixels: number[]; // flat indices into the 256² output
}

async function renderTileRGBA(
  env: Env,
  coords: TileCoords,
): Promise<Uint8Array> {
  // Resolve lat/lon for every output pixel centre, and group them by
  // the COG they fall in.
  const lonLat = new Float64Array(TILE_SIZE * TILE_SIZE * 2);
  const groups = new Map<string, CogGroup>();

  for (let py = 0; py < TILE_SIZE; py++) {
    for (let px = 0; px < TILE_SIZE; px++) {
      const i = py * TILE_SIZE + px;
      const { lon, lat } = pixelToLonLat(
        coords.z,
        coords.x,
        coords.y,
        px + 0.5,
        py + 0.5,
      );
      lonLat[i * 2] = lon;
      lonLat[i * 2 + 1] = lat;
      // Dataset coverage stops at ~84°N / ~60°S — skip pixels outside.
      if (lat < -60 || lat > 84) continue;
      const gridLon = Math.floor(lon / 3) * 3;
      const gridLat = Math.floor(lat / 3) * 3;
      const key = `${gridLon},${gridLat}`;
      let group = groups.get(key);
      if (!group) {
        group = { gridLon, gridLat, outPixels: [] };
        groups.set(key, group);
      }
      group.outPixels.push(i);
    }
  }

  const out = new Uint8Array(TILE_SIZE * TILE_SIZE * 4); // RGBA, init=0 → transparent

  // Fan out one R2/geotiff read per group. Each group is independent.
  await Promise.all(
    Array.from(groups.values()).map((group) =>
      paintGroup(env, coords.z, lonLat, group, out).catch((err) => {
        // Treat per-COG failures (e.g. ocean grid with no COG) as
        // transparent rather than failing the whole tile. The
        // R2GeoTiffClient surfaces missing objects as 404 → geotiff
        // wraps that as "Error fetching data."; we let both pass.
        const msg = String(err?.message ?? err);
        if (!msg.includes("Error fetching data") && !msg.includes("not found")) {
          console.warn(
            `worldcover group failed grid=${gridName(group.gridLon, group.gridLat)}`,
            err,
          );
        }
      }),
    ),
  );

  return out;
}

async function paintGroup(
  env: Env,
  z: number,
  lonLat: Float64Array,
  group: CogGroup,
  out: Uint8Array,
): Promise<void> {
  // Compute the COG-pixel bbox covering this group's lat/lon span at
  // the base (level 0) resolution.
  let minCx = Infinity;
  let minCy = Infinity;
  let maxCx = -Infinity;
  let maxCy = -Infinity;
  for (const i of group.outPixels) {
    const lon = lonLat[i * 2];
    const lat = lonLat[i * 2 + 1];
    const cx = (lon - group.gridLon) * SOURCE_PIXELS_PER_DEG;
    const cy = (group.gridLat + 3 - lat) * SOURCE_PIXELS_PER_DEG;
    if (cx < minCx) minCx = cx;
    if (cy < minCy) minCy = cy;
    if (cx > maxCx) maxCx = cx;
    if (cy > maxCy) maxCy = cy;
  }

  const grid = gridName(group.gridLon, group.gridLat);
  const tiff = await fromCustomClient(
    new R2GeoTiffClient(env.R2, sourceKey(grid)),
  );
  const overviewLevel = pickPerTileOverviewLevel(z);
  // geotiff getImage indexes IFDs in file order. ESA WorldCover writes
  // base IFD first, then 6 overviews from largest to smallest, so the
  // IFD index matches our `overviewLevel` directly.
  const image = await tiff.getImage(overviewLevel);
  const ovW = image.getWidth();

  // Scale base-level bbox to the chosen overview, then clamp.
  const scale = ovW / 36000;
  const wMinX = Math.max(0, Math.floor(minCx * scale));
  const wMinY = Math.max(0, Math.floor(minCy * scale));
  const wMaxX = Math.min(ovW, Math.ceil(maxCx * scale) + 1);
  const wMaxY = Math.min(ovW, Math.ceil(maxCy * scale) + 1);
  if (wMaxX <= wMinX || wMaxY <= wMinY) return;
  const wWidth = wMaxX - wMinX;

  // `interleave: true` flattens the (single) band into a Uint8Array of
  // class values, row-major over the window.
  const data = (await image.readRasters({
    window: [wMinX, wMinY, wMaxX, wMaxY],
    samples: [0],
    interleave: true,
  })) as Uint8Array;

  for (const i of group.outPixels) {
    const lon = lonLat[i * 2];
    const lat = lonLat[i * 2 + 1];
    const cx = (lon - group.gridLon) * SOURCE_PIXELS_PER_DEG * scale;
    const cy = (group.gridLat + 3 - lat) * SOURCE_PIXELS_PER_DEG * scale;
    const srcX = Math.floor(cx) - wMinX;
    const srcY = Math.floor(cy) - wMinY;
    if (srcX < 0 || srcY < 0 || srcX >= wMaxX - wMinX || srcY >= wMaxY - wMinY) continue;
    const cls = data[srcY * wWidth + srcX];
    const rgb = PALETTE[cls];
    if (!rgb) continue; // NoData / unknown → leave transparent
    const o = i * 4;
    out[o] = rgb[0];
    out[o + 1] = rgb[1];
    out[o + 2] = rgb[2];
    out[o + 3] = 255;
  }
}

// Low-zoom render path: a single global COG (`overview.tif`) replaces
// the per-3° fan-out, since at z<8 a Web Mercator tile can span up to
// ~900 source 3° cells.
async function renderTileRGBAFromOverview(
  env: Env,
  coords: TileCoords,
): Promise<Uint8Array> {
  const out = new Uint8Array(TILE_SIZE * TILE_SIZE * 4);

  // First pass: lat/lon per output pixel and the (col,row) bbox of the
  // overview-tif window we need to read.
  const lonLat = new Float64Array(TILE_SIZE * TILE_SIZE * 2);
  let minCx = Infinity;
  let minCy = Infinity;
  let maxCx = -Infinity;
  let maxCy = -Infinity;
  let hasAny = false;
  for (let py = 0; py < TILE_SIZE; py++) {
    for (let px = 0; px < TILE_SIZE; px++) {
      const i = py * TILE_SIZE + px;
      const { lon, lat } = pixelToLonLat(
        coords.z,
        coords.x,
        coords.y,
        px + 0.5,
        py + 0.5,
      );
      lonLat[i * 2] = lon;
      lonLat[i * 2 + 1] = lat;
      if (lat < -60 || lat > OVERVIEW_ORIGIN_LAT) continue;
      const cx = (lon - OVERVIEW_ORIGIN_LON) * OVERVIEW_PIXELS_PER_DEG;
      const cy = (OVERVIEW_ORIGIN_LAT - lat) * OVERVIEW_PIXELS_PER_DEG;
      if (cx < minCx) minCx = cx;
      if (cy < minCy) minCy = cy;
      if (cx > maxCx) maxCx = cx;
      if (cy > maxCy) maxCy = cy;
      hasAny = true;
    }
  }
  if (!hasAny) return out;

  const tiff = await fromCustomClient(
    new R2GeoTiffClient(env.R2, OVERVIEW_KEY),
  );
  const overviewLevel = pickOverviewLevel(coords.z);
  const image = await tiff.getImage(overviewLevel);
  const ovW = image.getWidth();

  // The image's overview level is the base width divided by 2^level
  // give-or-take rounding; recover the actual pixel-scale from the
  // image's own dimensions so we stay aligned with COG's overview math.
  const scale = ovW / OVERVIEW_WIDTH;
  const wMinX = Math.max(0, Math.floor(minCx * scale));
  const wMinY = Math.max(0, Math.floor(minCy * scale));
  const wMaxX = Math.min(ovW, Math.ceil(maxCx * scale) + 1);
  const wMaxY = Math.min(image.getHeight(), Math.ceil(maxCy * scale) + 1);
  if (wMaxX <= wMinX || wMaxY <= wMinY) return out;
  const wWidth = wMaxX - wMinX;

  const data = (await image.readRasters({
    window: [wMinX, wMinY, wMaxX, wMaxY],
    samples: [0],
    interleave: true,
  })) as Uint8Array;

  for (let i = 0; i < TILE_SIZE * TILE_SIZE; i++) {
    const lon = lonLat[i * 2];
    const lat = lonLat[i * 2 + 1];
    if (lat < -60 || lat > OVERVIEW_ORIGIN_LAT) continue;
    const cx = (lon - OVERVIEW_ORIGIN_LON) * OVERVIEW_PIXELS_PER_DEG * scale;
    const cy = (OVERVIEW_ORIGIN_LAT - lat) * OVERVIEW_PIXELS_PER_DEG * scale;
    const srcX = Math.floor(cx) - wMinX;
    const srcY = Math.floor(cy) - wMinY;
    if (srcX < 0 || srcY < 0 || srcX >= wWidth || srcY >= wMaxY - wMinY) continue;
    const cls = data[srcY * wWidth + srcX];
    const rgb = PALETTE[cls];
    if (!rgb) continue;
    const o = i * 4;
    out[o] = rgb[0];
    out[o + 1] = rgb[1];
    out[o + 2] = rgb[2];
    out[o + 3] = 255;
  }

  return out;
}

function isFullyEmpty(rgba: Uint8Array): boolean {
  // Scan the alpha channel only (every 4th byte). Bail on the first
  // non-zero — typical land tiles short-circuit within the first row.
  for (let i = 3; i < rgba.length; i += 4) {
    if (rgba[i] !== 0) return false;
  }
  return true;
}

// -- cache + handler -------------------------------------------------------

// Bump the version segment to invalidate cached renders after a
// palette / sampling / encoder change. The 2021 dataset itself is
// immutable, so no date component is needed.
//
// v2: empty-tile renders now 404 instead of returning a transparent
//     image; bumping orphans the previously-cached transparents.
// v3: z<8 now renders from overview.tif instead of 404. (No cached
//     content existed for z<8, but bumping keeps versions aligned.)
const TILE_CACHE_VERSION = 3;

function cacheKey(coords: TileCoords, fmt: EsaFormat): string {
  return `cache/esa_worldcover/v${TILE_CACHE_VERSION}/${fmt}/${coords.z}/${coords.x}/${coords.y}.${fmt}`;
}

export async function handleEsaWorldcoverTile(
  request: Request,
  env: Env,
  ctx: ExecutionContext,
  coords: TileCoords,
  fmt: EsaFormat,
  persist: boolean,
): Promise<Response> {
  if (coords.z > MAX_RENDER_Z) {
    return new Response("zoom above available range", { status: 404 });
  }

  return serveRenderedTile(request, env, ctx, {
    cacheKey: cacheKey(coords, fmt),
    cacheVersion: TILE_CACHE_VERSION,
    contentType: fmt === "png" ? "image/png" : "image/webp",
    attribution: ESA_WORLDCOVER_ATTRIBUTION,
    persist,
    demand: {
      tileset: "esa-worldcover",
      coords,
      fmt,
      // A mirrored raster is namespaced by one number, and that number is
      // the whole of its epoch: the archive behind it does not move, so
      // nothing else in the key can change without this changing too.
      epoch: { algo: String(TILE_CACHE_VERSION) },
    },
    render: async () => {
      const rgba =
        coords.z < OVERVIEW_MAX_Z
          ? await renderTileRGBAFromOverview(env, coords)
          : await renderTileRGBA(env, coords);

      // null → 404 for fully-empty tiles — matches the watercolor
      // handler and lets MapLibre's raster source mark the tile as
      // errored so it fills the hole with the nearest loaded ancestor
      // instead of treating an empty tile as a real (transparent)
      // layer pixel. We accept partially empty tiles (coastlines,
      // dataset bounds) — only every-pixel-alpha-0 counts as "no data".
      if (isFullyEmpty(rgba)) return null;

      // Lossless WebP: classification rasters with sharp colour
      // boundaries compress better and look right without artefacts.
      return fmt === "png"
        ? encodePngRGBA(rgba, TILE_SIZE, TILE_SIZE)
        : encodeWebpRGBA(rgba, TILE_SIZE, TILE_SIZE, { lossless: true });
    },
  });
}
