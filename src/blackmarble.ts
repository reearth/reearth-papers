// On-the-fly XYZ raster tiles for NASA Black Marble 2016.
//
// Source data lives in R2 as a single Cloud Optimized GeoTIFF:
//   mirror/blackmarble/black_marble_2016.tif
//     86400 × 43200 px, EPSG:4326, 3-band RGB uint8, JPEG-in-TIFF,
//     internal overviews (LANCZOS, half-resolution pyramid down to
//     ~tile size).
//
// Unlike `esa_worldcover.ts` we have no per-tile fanout — every Web
// Mercator tile maps to a single window in one COG — and no palette,
// since the source is already photographic RGB. The pipeline is:
//
//   1. Per output pixel: invert Web Mercator → lat/lon.
//   2. Choose the COG IFD (base or overview) whose pixel density just
//      exceeds the target.
//   3. Read the bounding window across all 3 bands.
//   4. Nearest-neighbour resample into a 256×256 RGBA buffer.
//   5. Encode as WebP (lossy) or PNG.
//
// Build pipeline: see `mirror/blackmarble/scripts/`.

import { fromCustomClient } from "geotiff";
import { pixelToLonLat, R2GeoTiffClient, TILE_SIZE } from "./cog.js";
import { encodePngRGBA, encodeWebpRGBA } from "./raster_encode.js";
import { serveRenderedTile } from "./render_cache.js";

export type BlackmarbleFormat = "png" | "webp";

interface TileCoords {
  z: number;
  x: number;
  y: number;
}

const R2_KEY = "mirror/blackmarble/black_marble_2016.tif";

// Base COG geometry — fixed by the mirror builder. 86400×43200 at
// 1/240° per pixel, origin top-left at (-180°E, 90°N). Hard-coding
// lets us pick the IFD synchronously without an extra metadata read.
const BASE_WIDTH = 86400;
const BASE_HEIGHT = 43200;
const BASE_PIXELS_PER_DEG = 240; // = 1 / 0.0041666…
const ORIGIN_LON = -180;
const ORIGIN_LAT = 90;

// Source is ~500 m/px → Web Mercator z=8 matches at the equator.
// Anything above oversamples; clients overzoom from this cap.
const MAX_RENDER_Z = 8;

// Match output Web Mercator pixel density to the closest COG IFD.
// Target px/deg at zoom z = 256 · 2^z / 360. The base IFD is 240
// px/deg; each subsequent IFD halves it (120, 60, 30, 15, 7.5,
// 3.75, 1.875). We pick the smallest (=coarsest) IFD whose density
// still meets the target, so we don't decode pixels we'd throw away.
function pickOverviewLevel(z: number): number {
  if (z >= 8) return 0; // ≥182 → base (240)
  if (z === 7) return 1; // 91   → 120
  if (z === 6) return 2; // 45   → 60
  if (z === 5) return 3; // 23   → 30
  if (z === 4) return 4; // 11.4 → 15
  if (z === 3) return 5; // 5.7  → 7.5
  if (z === 2) return 6; // 2.84 → 3.75
  return 7;              // z=0,1 → 1.875 (or coarsest available)
}

export const BLACKMARBLE_ATTRIBUTION =
  '<a href="https://papers.reearth.land">Re:Earth Papers</a> · ' +
  '<a href="https://science.nasa.gov/earth/earth-observatory/earth-at-night/maps">NASA Earth Observatory</a> · ' +
  "Suomi NPP VIIRS · Black Marble 2016";

// R2 transport + coordinate helpers shared with esa_worldcover.ts and
// naturalearth.ts — see src/cog.ts.

// -- rendering -------------------------------------------------------------

async function renderTileRGBA(
  env: Env,
  coords: TileCoords,
): Promise<Uint8Array> {
  const out = new Uint8Array(TILE_SIZE * TILE_SIZE * 4);

  // First pass: lat/lon per output pixel, and the COG-pixel bbox we need.
  const lonLat = new Float64Array(TILE_SIZE * TILE_SIZE * 2);
  let minCx = Infinity;
  let minCy = Infinity;
  let maxCx = -Infinity;
  let maxCy = -Infinity;
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
      // Source covers the full sphere; Web Mercator's polar cutoff
      // (±85.0511°) is already inside that, so every pixel reads.
      const cx = (lon - ORIGIN_LON) * BASE_PIXELS_PER_DEG;
      const cy = (ORIGIN_LAT - lat) * BASE_PIXELS_PER_DEG;
      if (cx < minCx) minCx = cx;
      if (cy < minCy) minCy = cy;
      if (cx > maxCx) maxCx = cx;
      if (cy > maxCy) maxCy = cy;
    }
  }

  const tiff = await fromCustomClient(new R2GeoTiffClient(env.R2, R2_KEY));
  const level = pickOverviewLevel(coords.z);
  // geotiff's getImage indexes IFDs in file order. COG writes base
  // first, then overviews largest→smallest, so `level` == IFD index.
  // Clamp in case the COG has fewer levels than we ask for.
  let image = await tiff.getImage(level);
  // Some COG configurations don't materialise the deepest overview;
  // fall back gracefully if the requested IFD doesn't exist.
  if (!image) image = await tiff.getImage(0);

  const ovW = image.getWidth();
  const ovH = image.getHeight();
  const scale = ovW / BASE_WIDTH; // matches LANCZOS pyramid halvings

  const wMinX = Math.max(0, Math.floor(minCx * scale));
  const wMinY = Math.max(0, Math.floor(minCy * scale));
  const wMaxX = Math.min(ovW, Math.ceil(maxCx * scale) + 1);
  const wMaxY = Math.min(ovH, Math.ceil(maxCy * scale) + 1);
  if (wMaxX <= wMinX || wMaxY <= wMinY) return out;
  const wWidth = wMaxX - wMinX;

  // 3 bands interleaved over the window. The COG stores JPEG-compressed
  // YCbCr (Photometric=6) but tags ColorInterp as R/G/B; geotiff.js
  // returns the raw decoded YCbCr bytes either way, so we convert
  // here via the standard JFIF formula. Without this, "black" pixels
  // (Y=0, Cb=Cr=128) render as a greenish-teal cast.
  const data = (await image.readRasters({
    window: [wMinX, wMinY, wMaxX, wMaxY],
    samples: [0, 1, 2],
    interleave: true,
  })) as Uint8Array;

  for (let i = 0; i < TILE_SIZE * TILE_SIZE; i++) {
    const lon = lonLat[i * 2];
    const lat = lonLat[i * 2 + 1];
    const cx = (lon - ORIGIN_LON) * BASE_PIXELS_PER_DEG * scale;
    const cy = (ORIGIN_LAT - lat) * BASE_PIXELS_PER_DEG * scale;
    const srcX = Math.floor(cx) - wMinX;
    const srcY = Math.floor(cy) - wMinY;
    if (srcX < 0 || srcY < 0 || srcX >= wWidth || srcY >= wMaxY - wMinY) continue;
    const s = (srcY * wWidth + srcX) * 3;
    const y = data[s];
    const cb = data[s + 1] - 128;
    const cr = data[s + 2] - 128;
    const r = y + 1.402 * cr;
    const g = y - 0.344136 * cb - 0.714136 * cr;
    const b = y + 1.772 * cb;
    const o = i * 4;
    out[o] = r < 0 ? 0 : r > 255 ? 255 : r;
    out[o + 1] = g < 0 ? 0 : g > 255 ? 255 : g;
    out[o + 2] = b < 0 ? 0 : b > 255 ? 255 : b;
    out[o + 3] = 255;
  }

  return out;
}

// -- cache + handler -------------------------------------------------------

// Bump to invalidate cached renders after a sampling / encoder change.
// The 2016 mosaic itself is immutable, so no date component is needed.
const TILE_CACHE_VERSION = 1;

function cacheKey(coords: TileCoords, fmt: BlackmarbleFormat): string {
  return `cache/blackmarble/v${TILE_CACHE_VERSION}/${fmt}/${coords.z}/${coords.x}/${coords.y}.${fmt}`;
}

export async function handleBlackmarbleTile(
  request: Request,
  env: Env,
  ctx: ExecutionContext,
  coords: TileCoords,
  fmt: BlackmarbleFormat,
  persist: boolean,
): Promise<Response> {
  if (coords.z > MAX_RENDER_Z) {
    return new Response("zoom above available range", { status: 404 });
  }

  return serveRenderedTile(request, env, ctx, {
    cacheKey: cacheKey(coords, fmt),
    cacheVersion: TILE_CACHE_VERSION,
    contentType: fmt === "png" ? "image/png" : "image/webp",
    attribution: BLACKMARBLE_ATTRIBUTION,
    persist,
    render: async () => {
      const rgba = await renderTileRGBA(env, coords);
      // Lossy WebP q=85 — Black Marble is a photographic RGB nightscape,
      // mostly black with bright point-like sources, where artefacts are
      // imperceptible at q≥80. Drops bytes ~10× vs. PNG / lossless.
      return fmt === "png"
        ? encodePngRGBA(rgba, TILE_SIZE, TILE_SIZE)
        : encodeWebpRGBA(rgba, TILE_SIZE, TILE_SIZE, { quality: 85 });
    },
  });
}
