// Shared plumbing for the COG-backed raster tilesets (ESA WorldCover,
// Black Marble, Natural Earth). Formerly duplicated per handler —
// lifted here once the third caller arrived, per the original
// "keep duplicated, refactor on the third caller" note.

import { BaseClient, BaseResponse } from "geotiff";

// All raster tilesets in this worker emit XYZ-standard 256² tiles.
export const TILE_SIZE = 256;

// -- R2 source for geotiff.js ----------------------------------------------

// geotiff v3 calls into a custom transport via a BaseClient subclass.
// Each `request` carries an HTTP-style `Range: bytes=A-B` header that
// we translate into an R2 byte-range fetch. Multiple concurrent ranges
// are issued as separate `request` calls — geotiff handles batching /
// caching above us via its BlockedSource layer.
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

export class R2GeoTiffClient extends BaseClient {
  readonly #bucket: R2Bucket;
  readonly #key: string;

  constructor(bucket: R2Bucket, key: string) {
    // BaseClient stores a `url` field but never uses it for custom
    // transports — feed it a sentinel so debug logs are still readable.
    super(`r2://${key}`);
    this.#bucket = bucket;
    this.#key = key;
  }

  override async request(options: RequestInit = {}): Promise<BaseResponse> {
    const rangeHeader = readRangeHeader(options.headers);
    if (!rangeHeader) {
      // No-range request → behave like a HEAD that advertises the
      // file's size + Accept-Ranges, which is enough for geotiff's
      // initial probe. We pay a 1-byte read to validate existence.
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
  // Single range form. Multi-range (bytes=A-B,C-D) only takes the first
  // range; geotiff handles servers that don't support multi-range by
  // re-issuing the remainder one-by-one.
  const m = /bytes=(\d+)-(\d+)/.exec(value);
  if (!m) return null;
  const offset = Number(m[1]);
  const end = Number(m[2]);
  return { offset, length: end - offset + 1 };
}

// -- coordinate helpers ----------------------------------------------------

// Inverse Web Mercator. Returns the geographic lon/lat for a given
// fractional tile pixel (px,py in [0, TILE_SIZE]).
export function pixelToLonLat(
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
