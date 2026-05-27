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

import { fromCustomClient, BaseClient, BaseResponse } from "geotiff";
import encodeWebp, { init as initWebp } from "@jsquash/webp/encode";
// @ts-expect-error — .wasm modules are bundled via wrangler's CompiledWasm rule.
import WEBP_ENC_WASM from "@jsquash/webp/codec/enc/webp_enc_simd.wasm";

export type BlackmarbleFormat = "png" | "webp";

interface TileCoords {
  z: number;
  x: number;
  y: number;
}

const TILE_SIZE = 256;
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

// -- R2 source for geotiff.js ----------------------------------------------
// Identical to the transport used by esa_worldcover.ts. We could lift
// this into a shared module, but two ~80-line copies is cheaper than
// the abstraction right now — keep duplicated, refactor on the third
// caller.

class R2GeoTiffResponse extends BaseResponse {
  readonly #status: number;
  readonly #headers: Record<string, string>;
  readonly #data: ArrayBuffer;

  constructor(status: number, headers: Record<string, string>, data: ArrayBuffer) {
    super();
    this.#status = status;
    this.#headers = headers;
    this.#data = data;
  }

  override get status(): number {
    return this.#status;
  }

  override getHeader(name: string): string | undefined {
    return this.#headers[name.toLowerCase()];
  }

  override async getData(): Promise<ArrayBuffer> {
    return this.#data;
  }
}

class R2GeoTiffClient extends BaseClient {
  readonly #bucket: R2Bucket;
  readonly #key: string;

  constructor(bucket: R2Bucket, key: string) {
    super(`r2://${key}`);
    this.#bucket = bucket;
    this.#key = key;
  }

  override async request(options: RequestInit = {}): Promise<BaseResponse> {
    const rangeHeader = readRangeHeader(options.headers);
    if (!rangeHeader) {
      const probe = await this.#bucket.get(this.#key, {
        range: { offset: 0, length: 1 },
      });
      if (!probe) return new R2GeoTiffResponse(404, {}, new ArrayBuffer(0));
      return new R2GeoTiffResponse(
        200,
        {
          "content-length": String(probe.size),
          "accept-ranges": "bytes",
        },
        new ArrayBuffer(0),
      );
    }
    const range = parseRangeHeader(rangeHeader);
    if (!range) return new R2GeoTiffResponse(400, {}, new ArrayBuffer(0));
    const obj = await this.#bucket.get(this.#key, {
      range: { offset: range.offset, length: range.length },
    });
    if (!obj) return new R2GeoTiffResponse(404, {}, new ArrayBuffer(0));
    const data = await obj.arrayBuffer();
    return new R2GeoTiffResponse(
      206,
      {
        "content-length": String(data.byteLength),
        "content-range": `bytes ${range.offset}-${range.offset + data.byteLength - 1}/${obj.size}`,
        "content-type": "application/octet-stream",
      },
      data,
    );
  }
}

function readRangeHeader(headers: HeadersInit | undefined): string | undefined {
  if (!headers) return undefined;
  if (headers instanceof Headers) return headers.get("range") ?? undefined;
  if (Array.isArray(headers))
    return headers.find(([k]) => k.toLowerCase() === "range")?.[1];
  const o = headers as Record<string, string>;
  return o["Range"] ?? o["range"];
}

function parseRangeHeader(value: string):
  | { offset: number; length: number }
  | null {
  const m = /bytes=(\d+)-(\d+)/.exec(value);
  if (!m) return null;
  const offset = Number(m[1]);
  const end = Number(m[2]);
  return { offset, length: end - offset + 1 };
}

// -- coordinate helpers ----------------------------------------------------

function pixelToLonLat(
  z: number,
  x: number,
  y: number,
  px: number,
  py: number,
): { lon: number; lat: number } {
  const n = 2 ** z;
  const lon = ((x + px / TILE_SIZE) / n) * 360 - 180;
  const k = Math.PI * (1 - (2 * (y + py / TILE_SIZE)) / n);
  const lat = (Math.atan(Math.sinh(k)) * 180) / Math.PI;
  return { lon, lat };
}

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

// -- encoders --------------------------------------------------------------
// PNG plumbing duplicated from esa_worldcover.ts. Same justification as
// the R2GeoTiffClient duplication above.

async function zlibDeflate(input: Uint8Array): Promise<Uint8Array> {
  const cs = new CompressionStream("deflate");
  const writer = cs.writable.getWriter();
  void writer.write(input);
  void writer.close();
  return new Uint8Array(await new Response(cs.readable).arrayBuffer());
}

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(buf: Uint8Array, start: number, end: number): number {
  let c = 0xffffffff;
  for (let i = start; i < end; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function pngChunk(type: string, data: Uint8Array): Uint8Array {
  const out = new Uint8Array(8 + data.length + 4);
  const dv = new DataView(out.buffer);
  dv.setUint32(0, data.length);
  for (let i = 0; i < 4; i++) out[4 + i] = type.charCodeAt(i);
  out.set(data, 8);
  dv.setUint32(8 + data.length, crc32(out, 4, 8 + data.length));
  return out;
}

async function encodePngRGBA(
  rgba: Uint8Array,
  width: number,
  height: number,
): Promise<Uint8Array> {
  const rowSize = width * 4;
  const filtered = new Uint8Array(height * (1 + rowSize));
  for (let y = 0; y < height; y++) {
    filtered[y * (1 + rowSize)] = 0;
    filtered.set(rgba.subarray(y * rowSize, (y + 1) * rowSize), y * (1 + rowSize) + 1);
  }
  const idat = await zlibDeflate(filtered);

  const ihdr = new Uint8Array(13);
  const dv = new DataView(ihdr.buffer);
  dv.setUint32(0, width);
  dv.setUint32(4, height);
  ihdr[8] = 8;
  ihdr[9] = 6;
  ihdr[10] = 0;
  ihdr[11] = 0;
  ihdr[12] = 0;

  const signature = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const ihdrChunk = pngChunk("IHDR", ihdr);
  const idatChunk = pngChunk("IDAT", idat);
  const iendChunk = pngChunk("IEND", new Uint8Array(0));

  const total =
    signature.length + ihdrChunk.length + idatChunk.length + iendChunk.length;
  const out = new Uint8Array(total);
  let off = 0;
  for (const part of [signature, ihdrChunk, idatChunk, iendChunk]) {
    out.set(part, off);
    off += part.length;
  }
  return out;
}

let webpReady: Promise<void> | null = null;
async function ensureWebpReady(): Promise<void> {
  if (!webpReady) {
    webpReady = (async () => {
      await initWebp(WEBP_ENC_WASM as unknown as WebAssembly.Module);
    })();
  }
  await webpReady;
}

async function encodeWebpRGBA(
  rgba: Uint8Array,
  width: number,
  height: number,
): Promise<Uint8Array> {
  await ensureWebpReady();
  // Lossy q=85 — Black Marble is a photographic RGB nightscape, mostly
  // black with bright point-like sources, where JPEG/WebP artefacts
  // are imperceptible at q≥80. Drops bytes ~10× vs. PNG / lossless.
  const ab = await encodeWebp(
    {
      data: new Uint8ClampedArray(rgba.buffer, rgba.byteOffset, rgba.byteLength),
      width,
      height,
      colorSpace: "srgb",
    },
    { quality: 85, method: 4 },
  );
  return new Uint8Array(ab);
}

// -- cache + handler -------------------------------------------------------

// Bump to invalidate cached renders after a sampling / encoder change.
// The 2016 mosaic itself is immutable, so no date component is needed.
const TILE_CACHE_VERSION = 1;

function cacheKey(coords: TileCoords, fmt: BlackmarbleFormat): string {
  return `cache/blackmarble/v${TILE_CACHE_VERSION}/${fmt}/${coords.z}/${coords.x}/${coords.y}.${fmt}`;
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

function contentTypeFor(fmt: BlackmarbleFormat): string {
  return fmt === "png" ? "image/png" : "image/webp";
}

export async function handleBlackmarbleTile(
  request: Request,
  env: Env,
  ctx: ExecutionContext,
  coords: TileCoords,
  fmt: BlackmarbleFormat,
): Promise<Response> {
  if (coords.z > MAX_RENDER_Z) {
    return new Response("zoom above available range", { status: 404 });
  }

  const cache = caches.default;
  const cacheReq = edgeCacheRequest(request);
  const edge = await cache.match(cacheReq);
  if (edge) return edge;

  const key = cacheKey(coords, fmt);
  const cached = await env.R2.get(key);
  if (cached) {
    const response = new Response(cached.body, {
      headers: {
        "content-type": contentTypeFor(fmt),
        "cache-control": "public, max-age=31536000, immutable",
        "x-cache": "r2-hit",
        "x-attribution": BLACKMARBLE_ATTRIBUTION,
      },
    });
    ctx.waitUntil(cache.put(cacheReq, response.clone()));
    return response;
  }

  const rgba = await renderTileRGBA(env, coords);

  const encoded =
    fmt === "png"
      ? await encodePngRGBA(rgba, TILE_SIZE, TILE_SIZE)
      : await encodeWebpRGBA(rgba, TILE_SIZE, TILE_SIZE);

  const response = new Response(encoded, {
    headers: {
      "content-type": contentTypeFor(fmt),
      "cache-control": "public, max-age=31536000, immutable",
      "x-cache": "miss",
      "x-attribution": BLACKMARBLE_ATTRIBUTION,
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
