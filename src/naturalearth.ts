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
// Earth raster is one `NATURAL_EARTH_RASTERS` entry here (picked up by
// the central tileset registry in src/tilesets.ts) plus one `DATASETS`
// entry in `mirror/naturalearth/scripts/_lib.sh`.

import { attributionOf } from "./credits.js";
import { fromCustomClient } from "geotiff";
import { pixelToLonLat, R2GeoTiffClient, TILE_SIZE } from "./cog.js";
import { encodePngRGBA, encodeWebpRGBA } from "./raster_encode.js";
import { serveRenderedTile } from "./render_cache.js";

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
  /** Base IFD geometry — fixed by the mirror builder. Hard-coding lets
   *  us pick the IFD synchronously without an extra metadata read. */
  width: number;
  pixelsPerDeg: number;
  /** Max render zoom: the largest z whose target pixel density
   *  (256 · 2^z / 360 px/deg) the base IFD still meets. Clients
   *  overzoom from this cap. */
  maxZoom: number;
  /** Internal overview halvings below the base IFD (COG AUTO pyramid
   *  down to ≤ one 512px block). */
  overviewCount: number;
  /** Raster bands: 3 = RGB (JPEG-in-TIFF stores YCbCr), 1 = grayscale. */
  bands: 1 | 3;
}

// All sources share the plate-carrée full-globe frame.
const ORIGIN_LON = -180;
const ORIGIN_LAT = 90;

// The 1:10m high-resolution grid: 21600×10800 at 1/60° per pixel
// (~1.85 km at the equator) → max render z6 (45.5 px/deg target),
// overviews 10800 … 337.
const HR_10M = { width: 21600, pixelsPerDeg: 60, maxZoom: 6, overviewCount: 6 } as const;
// The 1:50m grid: 10800×5400 at 1/30° per pixel → max render z5,
// overviews 5400 … 337.
const GRID_50M = { width: 10800, pixelsPerDeg: 30, maxZoom: 5, overviewCount: 5 } as const;

export const NATURAL_EARTH_RASTERS: readonly NaturalEarthRaster[] = [
  {
    id: "ne1",
    r2Key: "mirror/naturalearth/ne1_hr_lc_sr_w_dr.tif",
    name: "Natural Earth I",
    description:
      "Natural Earth I (shaded relief, water, drainages) — " +
      "satellite-derived land cover in a light, natural palette, " +
      "rendered on-the-fly from a global ~1.85 km / pixel COG mirrored to R2.",
    ...HR_10M,
    bands: 3,
  },
  {
    id: "ne2",
    r2Key: "mirror/naturalearth/ne2_hr_lc_sr_w_dr.tif",
    name: "Natural Earth II",
    description:
      "Natural Earth II (shaded relief, water, drainages) — the world " +
      "environment in an idealized, softly blended palette, rendered " +
      "on-the-fly from a global ~1.85 km / pixel COG mirrored to R2.",
    ...HR_10M,
    bands: 3,
  },
  {
    id: "hypso",
    r2Key: "mirror/naturalearth/hyp_hr_sr_ob_dr.tif",
    name: "Cross-blended Hypsometric Tints",
    description:
      "Cross-blended hypsometric tints (shaded relief, ocean bottom, " +
      "drainages) — elevation colors regionally blended by climate: " +
      "humid lowlands green, arid lowlands brown. Rendered on-the-fly " +
      "from a global ~1.85 km / pixel COG mirrored to R2.",
    ...HR_10M,
    bands: 3,
  },
  {
    id: "grayearth",
    r2Key: "mirror/naturalearth/gray_hr_sr_ob_dr.tif",
    name: "Gray Earth",
    description:
      "Gray Earth (shaded relief, hypsography, ocean bottom, drainages) " +
      "— monochromatic terrain emphasizing mountains and lowland " +
      "micro-terrain. Rendered on-the-fly from a global ~1.85 km / pixel " +
      "COG mirrored to R2.",
    ...HR_10M,
    bands: 1,
  },
  {
    id: "oceanbottom",
    r2Key: "mirror/naturalearth/ob_50m.tif",
    name: "Ocean Bottom",
    description:
      "Ocean Bottom — blended depth colors and relief shading of the " +
      "ocean floor derived from CleanTOPO2 (1:50m). Rendered on-the-fly " +
      "from a global ~3.7 km / pixel COG mirrored to R2.",
    ...GRID_50M,
    bands: 3,
  },
];

// Match output Web Mercator pixel density to the closest COG IFD.
// Target px/deg at zoom z = 256 · 2^z / 360; the base IFD is
// `pixelsPerDeg` and each overview halves it. maxZoom - z lines the
// two halving ladders up exactly: for the 10m grid, z=6 → base
// (45.5 → 60), z=5 → 30, … z=0 → 0.94.
function pickOverviewLevel(def: NaturalEarthRaster, z: number): number {
  return Math.min(Math.max(def.maxZoom - z, 0), def.overviewCount);
}

export const NATURAL_EARTH_ATTRIBUTION = attributionOf("naturalEarth");

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
      const cx = (lon - ORIGIN_LON) * def.pixelsPerDeg;
      const cy = (ORIGIN_LAT - lat) * def.pixelsPerDeg;
      if (cx < minCx) minCx = cx;
      if (cy < minCy) minCy = cy;
      if (cx > maxCx) maxCx = cx;
      if (cy > maxCy) maxCy = cy;
    }
  }

  const tiff = await fromCustomClient(new R2GeoTiffClient(env.R2, def.r2Key));
  const level = pickOverviewLevel(def, coords.z);
  // geotiff's getImage indexes IFDs in file order. COG writes base
  // first, then overviews largest→smallest, so `level` == IFD index.
  let image = await tiff.getImage(level);
  // Some COG configurations don't materialise the deepest overview;
  // fall back gracefully if the requested IFD doesn't exist.
  if (!image) image = await tiff.getImage(0);

  const ovW = image.getWidth();
  const ovH = image.getHeight();
  const scale = ovW / def.width; // matches LANCZOS pyramid halvings

  const wMinX = Math.max(0, Math.floor(minCx * scale));
  const wMinY = Math.max(0, Math.floor(minCy * scale));
  const wMaxX = Math.min(ovW, Math.ceil(maxCx * scale) + 1);
  const wMaxY = Math.min(ovH, Math.ceil(maxCy * scale) + 1);
  if (wMaxX <= wMinX || wMaxY <= wMinY) return out;
  const wWidth = wMaxX - wMinX;

  // Bands interleaved over the window. 3-band COGs store
  // JPEG-compressed YCbCr (Photometric=6) but tag ColorInterp as
  // R/G/B; geotiff.js returns the raw decoded YCbCr bytes either way,
  // so we convert via the standard JFIF formula (same as
  // blackmarble.ts). 1-band (grayscale) JPEG stays MINISBLACK — the
  // decoded byte is the luminance directly.
  const data = (await image.readRasters({
    window: [wMinX, wMinY, wMaxX, wMaxY],
    samples: def.bands === 3 ? [0, 1, 2] : [0],
    interleave: true,
  })) as Uint8Array;

  for (let i = 0; i < TILE_SIZE * TILE_SIZE; i++) {
    const lon = lonLat[i * 2];
    const lat = lonLat[i * 2 + 1];
    const cx = (lon - ORIGIN_LON) * def.pixelsPerDeg * scale;
    const cy = (ORIGIN_LAT - lat) * def.pixelsPerDeg * scale;
    const srcX = Math.floor(cx) - wMinX;
    const srcY = Math.floor(cy) - wMinY;
    if (srcX < 0 || srcY < 0 || srcX >= wWidth || srcY >= wMaxY - wMinY) continue;
    const o = i * 4;
    if (def.bands === 1) {
      const v = data[srcY * wWidth + srcX];
      out[o] = v;
      out[o + 1] = v;
      out[o + 2] = v;
      out[o + 3] = 255;
      continue;
    }
    const s = (srcY * wWidth + srcX) * 3;
    const y = data[s];
    const cb = data[s + 1] - 128;
    const cr = data[s + 2] - 128;
    const r = y + 1.402 * cr;
    const g = y - 0.344136 * cb - 0.714136 * cr;
    const b = y + 1.772 * cb;
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

export async function handleNaturalEarthTile(
  request: Request,
  env: Env,
  ctx: ExecutionContext,
  def: NaturalEarthRaster,
  coords: TileCoords,
  fmt: NaturalEarthFormat,
  persist: boolean,
): Promise<Response> {
  if (coords.z > def.maxZoom) {
    return new Response("zoom above available range", { status: 404 });
  }

  return serveRenderedTile(request, env, ctx, {
    cacheKey: cacheKey(def, coords, fmt),
    cacheVersion: TILE_CACHE_VERSION,
    contentType: fmt === "png" ? "image/png" : "image/webp",
    attribution: NATURAL_EARTH_ATTRIBUTION,
    persist,
    demand: {
      tileset: def.id,
      coords,
      fmt,
      // A mirrored raster is namespaced by one number, and that number is
      // the whole of its epoch: the archive behind it does not move, so
      // nothing else in the key can change without this changing too.
      epoch: { algo: String(TILE_CACHE_VERSION) },
    },
    render: async () => {
      const rgba = await renderTileRGBA(env, def, coords);
      return fmt === "png"
        ? encodePngRGBA(rgba, TILE_SIZE, TILE_SIZE)
        : encodeWebpRGBA(rgba, TILE_SIZE, TILE_SIZE, { quality: 85 });
    },
  });
}
