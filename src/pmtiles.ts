// Vector tile endpoint backed by the mirrored Protomaps PMTiles archive
// in R2.
//
// Flow: pointer file (`{prefix}/latest.json`) → R2 object key → walk
// the PMTiles directory tree to find the requested z/x/y → range-read
// the tile bytes → return them with the archive's declared
// Content-Encoding. The pmtiles library handles directory caching
// across requests within a worker instance.

import { PMTiles, type RangeResponse, type Source } from "pmtiles";

const POINTER_TTL_MS = 60 * 60 * 1000;

interface MirrorPointer {
  date: string;
  key: string;
  size: number;
}

interface CachedPointer {
  value: MirrorPointer;
  expires: number;
}

interface CachedArchive {
  key: string;
  pmtiles: PMTiles;
}

// Module-scope so the pmtiles library's internal directory cache
// survives between requests on the same isolate.
let pointerCache: CachedPointer | null = null;
let archiveCache: CachedArchive | null = null;

class R2PmtilesSource implements Source {
  readonly #bucket: R2Bucket;
  readonly #key: string;

  constructor(bucket: R2Bucket, key: string) {
    this.#bucket = bucket;
    this.#key = key;
  }

  getKey(): string {
    // Stable identity so the pmtiles library keys its header / directory
    // cache against this specific R2 object.
    return `r2://${this.#key}`;
  }

  async getBytes(offset: number, length: number): Promise<RangeResponse> {
    const obj = await this.#bucket.get(this.#key, {
      range: { offset, length },
    });
    if (!obj) throw new Error(`pmtiles archive not found in R2: ${this.#key}`);
    return {
      data: await obj.arrayBuffer(),
      etag: obj.httpEtag,
    };
  }
}

async function readMirrorPointer(env: Env): Promise<MirrorPointer> {
  const now = Date.now();
  if (pointerCache && pointerCache.expires > now) return pointerCache.value;

  const obj = await env.R2.get(`${env.MIRROR_PREFIX}/latest.json`);
  if (!obj) {
    throw new Error(
      `mirror pointer ${env.MIRROR_PREFIX}/latest.json not found — run the mirror worker at least once`,
    );
  }
  const parsed = (await obj.json()) as MirrorPointer;
  if (!parsed?.key || !parsed?.date) {
    throw new Error(`mirror pointer ${env.MIRROR_PREFIX}/latest.json is malformed`);
  }
  pointerCache = { value: parsed, expires: now + POINTER_TTL_MS };
  return parsed;
}

async function getArchive(env: Env): Promise<PMTiles> {
  const pointer = await readMirrorPointer(env);
  if (archiveCache && archiveCache.key === pointer.key) return archiveCache.pmtiles;
  const pmtiles = new PMTiles(new R2PmtilesSource(env.R2, pointer.key));
  archiveCache = { key: pointer.key, pmtiles };
  return pmtiles;
}

// PMTiles spec § 3.4: tileCompression numeric enum.
function contentEncodingFor(compression: number): string | undefined {
  switch (compression) {
    case 2:
      return "gzip";
    case 3:
      return "br";
    case 4:
      return "zstd";
    default:
      return undefined;
  }
}

export async function handleVectorTile(
  match: { z: number; x: number; y: number },
  env: Env,
): Promise<Response> {
  const archive = await getArchive(env);
  const header = await archive.getHeader();

  if (match.z < header.minZoom || match.z > header.maxZoom) {
    return new Response("zoom out of range", { status: 404 });
  }

  const tile = await archive.getZxy(match.z, match.x, match.y);
  if (!tile) return new Response("tile not found", { status: 204 });

  const headers = new Headers({
    "content-type": "application/vnd.mapbox-vector-tile",
    // Archive is mirrored monthly and addressed by date in the pointer,
    // but the URL path is stable across runs. Use a moderate TTL with
    // SWR so a freshly mirrored archive reaches clients within a day.
    "cache-control": "public, max-age=3600, stale-while-revalidate=86400",
  });
  const compEnc = contentEncodingFor(header.tileCompression);
  if (compEnc) headers.set("content-encoding", compEnc);
  return new Response(tile.data, { headers });
}
