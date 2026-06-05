// On-the-fly XYZ raster tiles for Natural Earth 1:10m rasters.
//
// Source data lives in R2 as one Cloud Optimized GeoTIFF per dataset
// under `mirror/naturalearth/` (see that directory's README):
//   21600 × 10800 px, EPSG:4326, 3-band RGB uint8, JPEG-in-TIFF,
//   internal overviews (LANCZOS, half-resolution pyramid down to
//   337×168).
//
// The render path is identical to `blackmarble.ts` — every Web
// Mercator tile maps to a single window in one COG; per output pixel
// we invert Mercator to lat/lon, pick the IFD whose pixel density just
// exceeds the target, nearest-neighbour resample into a 256² RGBA
// buffer, and encode as WebP (lossy) or PNG.
//
// The dataset set is registry-driven: adding another mirrored Natural
// Earth raster is one `NATURAL_EARTH_RASTERS` entry (all 1:10m HR
// variants share the same grid geometry) plus one `DATASETS` entry in
// `mirror/naturalearth/scripts/_lib.sh`.

import { fromCustomClient } from "geotiff";
import { pixelToLonLat, R2GeoTiffClient, TILE_SIZE } from "./cog.js";
import { encodePngRGBA, encodeWebpRGBA } from "./raster_encode.js";

export type NaturalEarthFormat = "png" | "webp";

interface TileCoords {
  z: number;
  x: number;
  y: number;
}

export interface NaturalEarthRaster {
  /** Route segment: `/<id>/{z}/{x}/{y}.{png,webp}` (+ cache key segment). */
  id: string;
  /** COG object key in R2. */
  r2Key: string;
  name: string;
  description: string;
}

export const NATURAL_EARTH_RASTERS: readonly NaturalEarthRaster[] = [
  {
    id: "ne2",
    r2Key: "mirror/naturalearth/ne2_hr_lc_sr_w_dr.tif",
    name: "Natural Earth II",
    description:
      "Natural Earth II (shaded relief, water, drainages) — the world " +
      "environment in an idealized, softly blended palette, rendered " +
      "on-the-fly from a global ~1.85 km / pixel COG mirrored to R2.",
  },
];

export const NATURAL_EARTH_BY_ID: ReadonlyMap<string, NaturalEarthRaster> =
  new Map(NATURAL_EARTH_RASTERS.map((d) => [d.id, d]));

// Shared grid geometry — fixed by the mirror builder, identical for
// every 1:10m HR raster. 21600×10800 at 1/60° per pixel, origin
// top-left at (-180°E, 90°N). Hard-coding lets us pick the IFD
// synchronously without an extra metadata read.
const BASE_WIDTH = 21600;
const BASE_PIXELS_PER_DEG = 60; // = 1 / 0.016666…
const ORIGIN_LON = -180;
const ORIGIN_LAT = 90;

// Source is ~1.85 km/px → Web Mercator z=6 (45.5 px/deg target)
// matches at the equator. Anything above oversamples; clients overzoom
// from this cap.
export const NATURAL_EARTH_MAX_ZOOM = 6;

// COG overview pyramid: 10800, 5400, 2700, 1350, 675, 337 px wide —
// 6 halvings below the base IFD.
const OVERVIEW_COUNT = 6;

// Match output Web Mercator pixel density to the closest COG IFD.
// Target px/deg at zoom z = 256 · 2^z / 360; the base IFD is 60 px/deg
// and each overview halves it. MAX_ZOOM - z lines the two halving
// ladders up exactly: z=6 → base (45.5 → 60), z=5 → 30, … z=0 → 0.94.
function pickOverviewLevel(z: number): number {
  return Math.min(Math.max(NATURAL_EARTH_MAX_ZOOM - z, 0), OVERVIEW_COUNT);
}

export const NATURAL_EARTH_ATTRIBUTION =
  '<a href="https://papers.reearth.land">Re:Earth Papers</a> · ' +
  'Made with <a href="https://www.naturalearthdata.com">Natural Earth</a> · ' +
  "public domain";

// -- rendering -------------------------------------------------------------

async function renderTileRGBA(
  env: Env,
  def: NaturalEarthRaster,
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

  const tiff = await fromCustomClient(new R2GeoTiffClient(env.R2, def.r2Key));
  const level = pickOverviewLevel(coords.z);
  // geotiff's getImage indexes IFDs in file order. COG writes base
  // first, then overviews largest→smallest, so `level` == IFD index.
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
  // here via the standard JFIF formula (same as blackmarble.ts).
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
// The mirrored rasters themselves are immutable, so no date component
// is needed.
const TILE_CACHE_VERSION = 1;

function cacheKey(
  def: NaturalEarthRaster,
  coords: TileCoords,
  fmt: NaturalEarthFormat,
): string {
  return `cache/naturalearth/${def.id}/v${TILE_CACHE_VERSION}/${fmt}/${coords.z}/${coords.x}/${coords.y}.${fmt}`;
}

// Cache-API key for the CF edge cache. We can't use the raw client
// request, because that URL doesn't change when TILE_CACHE_VERSION
// bumps — the edge would keep serving an old tile forever even after
// we orphan its R2 sibling. Stamping the version onto the cache URL
// rotates the edge alongside R2.
function edgeCacheRequest(request: Request): Request {
  const url = new URL(request.url);
  url.searchParams.set("__v", String(TILE_CACHE_VERSION));
  return new Request(url.toString(), request);
}

function contentTypeFor(fmt: NaturalEarthFormat): string {
  return fmt === "png" ? "image/png" : "image/webp";
}

export async function handleNaturalEarthTile(
  request: Request,
  env: Env,
  ctx: ExecutionContext,
  def: NaturalEarthRaster,
  coords: TileCoords,
  fmt: NaturalEarthFormat,
): Promise<Response> {
  if (coords.z > NATURAL_EARTH_MAX_ZOOM) {
    return new Response("zoom above available range", { status: 404 });
  }

  const cache = caches.default;
  const cacheReq = edgeCacheRequest(request);
  const edge = await cache.match(cacheReq);
  if (edge) return edge;

  const key = cacheKey(def, coords, fmt);
  const cached = await env.R2.get(key);
  if (cached) {
    const response = new Response(cached.body, {
      headers: {
        "content-type": contentTypeFor(fmt),
        "cache-control": "public, max-age=31536000, immutable",
        "x-cache": "r2-hit",
        "x-attribution": NATURAL_EARTH_ATTRIBUTION,
      },
    });
    ctx.waitUntil(cache.put(cacheReq, response.clone()));
    return response;
  }

  const rgba = await renderTileRGBA(env, def, coords);

  const encoded =
    fmt === "png"
      ? await encodePngRGBA(rgba, TILE_SIZE, TILE_SIZE)
      : await encodeWebpRGBA(rgba, TILE_SIZE, TILE_SIZE, { quality: 85 });

  const response = new Response(encoded, {
    headers: {
      "content-type": contentTypeFor(fmt),
      "cache-control": "public, max-age=31536000, immutable",
      "x-cache": "miss",
      "x-attribution": NATURAL_EARTH_ATTRIBUTION,
    },
  });

  ctx.waitUntil(
    (async () => {
      await Promise.all([
        env.R2.put(key, encoded, {
          httpMetadata: { contentType: contentTypeFor(fmt) },
        }),
        cache.put(cacheReq, response.clone()),
      ]);
    })(),
  );

  return response;
}
