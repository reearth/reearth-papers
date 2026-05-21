// Raster tile endpoint backed by the watercolor PMTiles archive in R2.
//
// Unlike `pmtiles.ts` (vector tiles, monthly-rotated via a pointer
// file), the watercolor archive is a single immutable object built
// once on EC2 by `mirror/watercolor/builder/`. The key is therefore
// hardcoded; no pointer indirection.

import { PMTiles, type RangeResponse, type Source } from "pmtiles";

const WATERCOLOR_KEY = "mirror/watercolor/v1.pmtiles";

// Attribution required by both upstreams:
//   - Stamen Design (map tiles, CC BY 4.0)
//   - OpenStreetMap contributors (underlying data, ODbL)
// Re:Earth Papers added per our own hosting attribution.
export const WATERCOLOR_ATTRIBUTION =
  '<a href="https://papers.reearth.land">Re:Earth Papers</a> · ' +
  '<a href="https://stamen.com">Stamen Design</a> (CC BY 4.0) · ' +
  '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors';

const ATTRIBUTION = WATERCOLOR_ATTRIBUTION;

let archiveCache: PMTiles | null = null;

class R2PmtilesSource implements Source {
  readonly #bucket: R2Bucket;
  readonly #key: string;

  constructor(bucket: R2Bucket, key: string) {
    this.#bucket = bucket;
    this.#key = key;
  }

  getKey(): string {
    return `r2://${this.#key}`;
  }

  async getBytes(offset: number, length: number): Promise<RangeResponse> {
    const obj = await this.#bucket.get(this.#key, {
      range: { offset, length },
    });
    if (!obj) {
      throw new Error(`watercolor archive not found in R2: ${this.#key}`);
    }
    return {
      data: await obj.arrayBuffer(),
      etag: obj.httpEtag,
    };
  }
}

function getArchive(env: Env): PMTiles {
  if (archiveCache) return archiveCache;
  archiveCache = new PMTiles(new R2PmtilesSource(env.R2, WATERCOLOR_KEY));
  return archiveCache;
}

export async function handleWatercolorTile(
  match: { z: number; x: number; y: number },
  env: Env,
): Promise<Response> {
  const archive = getArchive(env);
  const header = await archive.getHeader();

  if (match.z < header.minZoom || match.z > header.maxZoom) {
    return new Response("zoom out of range", { status: 404 });
  }

  const tile = await archive.getZxy(match.z, match.x, match.y);
  if (!tile) {
    // 404 (not 204): MapLibre's raster source marks 404 tiles as
    // "errored" and then findLoadedParent fills the hole with the
    // nearest loaded ancestor (upscaled), which is what we want for
    // Stamen's patchy high-zoom coverage. A 204 would be treated as
    // a successful empty tile and leave a transparent gap instead.
    return new Response("tile not in archive", { status: 404 });
  }

  return new Response(tile.data, {
    headers: {
      "content-type": "image/jpeg",
      // Immutable archive — aggressive caching at the edge and in
      // the browser. The path itself never changes, so we don't need
      // stale-while-revalidate.
      "cache-control": "public, max-age=31536000, immutable",
      "x-attribution": ATTRIBUTION,
    },
  });
}
