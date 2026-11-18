// The one place a PMTiles archive handle is built.
//
// Each handle lives at module scope for the life of its isolate, so
// anything it remembers outlives the request that put it there. The
// library's default cache stores a header or directory read as a
// promise before it settles and keeps it if it rejects, so one failed
// read fails every later request for that archive until the isolate
// goes away. `ResolvedValueCache` is the cache pmtiles ships for
// Workers, and it stores only values that arrived.

import {
  Compression,
  FetchSource,
  PMTiles,
  ResolvedValueCache,
  type RangeResponse,
  type Source,
} from "pmtiles";

/** `FetchSource` for a Worker. After one ETag mismatch the library sets
 *  `mustReload` for good and sends `cache: "reload"` on every later
 *  read, to get past a browser cache. A Worker has no such cache and
 *  rejects that mode with a `TypeError`, so an archive replaced in place
 *  would fail every read from then on. The flag is read before the
 *  first `await` in `getBytes`, so no other request can see it set. */
export class WorkerFetchSource extends FetchSource {
  override async getBytes(...args: Parameters<FetchSource["getBytes"]>) {
    this.mustReload = false;
    return super.getBytes(...args);
  }
}

export function openArchive(source: Source): PMTiles {
  return new PMTiles(source, new ResolvedValueCache());
}

/** Largest stored (still compressed) tile `archiveTileStream` reads. The
 *  heaviest Overture `base` tile measured, 4/4/5, is 17.3 MB stored. */
export const STORED_TILE_MAX_BYTES = 32 * 1024 * 1024;

const STREAM_PIECE_BYTES = 64 * 1024;

/** Refuses a range read over the ceiling before it is made. The key is
 *  the wrapped source's, so header and directory reads share its cache
 *  entries. */
class CappedSource implements Source {
  readonly #inner: Source;

  constructor(inner: Source) {
    this.#inner = inner;
  }

  getKey(): string {
    return this.#inner.getKey();
  }

  async getBytes(
    offset: number,
    length: number,
    signal?: AbortSignal,
    etag?: string,
  ): Promise<RangeResponse> {
    if (length > STORED_TILE_MAX_BYTES) {
      throw new Error(`stored read of ${length} bytes passes ${STORED_TILE_MAX_BYTES}`);
    }
    return this.#inner.getBytes(offset, length, signal, etag);
  }
}

const storedHandles = new WeakMap<PMTiles, PMTiles>();

/** A second handle on `archive` whose tiles come back as stored. It shares
 *  the archive's cache, which decodes directories with its own function,
 *  so only tile bytes skip decompression. */
function storedHandle(archive: PMTiles): PMTiles {
  let stored = storedHandles.get(archive);
  if (!stored) {
    stored = new PMTiles(new CappedSource(archive.source), archive.cache, async (b) => b);
    storedHandles.set(archive, stored);
  }
  return stored;
}

/** One tile of `archive`, decompressed as a stream, or null when the
 *  archive has no tile there. The tile's coordinates must be on the grid. */
export async function archiveTileStream(
  archive: PMTiles,
  tile: { z: number; x: number; y: number },
): Promise<ReadableStream<Uint8Array> | null> {
  const stored = storedHandle(archive);
  const found = await stored.getZxy(tile.z, tile.x, tile.y);
  if (!found) return null;
  const { tileCompression } = await stored.getHeader();
  const bytes = new Uint8Array(found.data);
  let at = 0;
  const pieces = new ReadableStream<Uint8Array>(
    {
      pull(controller) {
        if (at >= bytes.length) {
          controller.close();
          return;
        }
        controller.enqueue(bytes.subarray(at, (at += STREAM_PIECE_BYTES)));
      },
    },
    { highWaterMark: 0 },
  );
  if (tileCompression === Compression.None) return pieces;
  if (tileCompression === Compression.Gzip) {
    return pieces.pipeThrough(new DecompressionStream("gzip"));
  }
  throw new Error(`tile compression ${tileCompression} is not supported`);
}

/** The archive's ETag, kept to the characters a cache key can carry.
 *  Throws when the archive has none, since then nothing says which
 *  build a render read. */
export async function archiveVersion(archive: PMTiles): Promise<string> {
  const { etag } = await archive.getHeader();
  const version = (etag ?? "").replace(/[^A-Za-z0-9._-]/g, "");
  if (!version) throw new Error(`archive ${archive.source.getKey()} has no etag`);
  return version;
}
