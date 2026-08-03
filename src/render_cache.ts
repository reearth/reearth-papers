// Two-layer (edge → optional R2) cache for on-the-fly rendered raster
// tiles. Extracted from the per-dataset copies in blackmarble.ts /
// esa_worldcover.ts / naturalearth.ts once the third caller arrived.
//
// The R2 layer is optional: cheap renders (one small COG window read +
// encode) can skip persistence entirely and lean on Cloudflare's edge
// cache alone — re-rendering on a cold PoP costs less than paying R2
// Class A writes + storage for every tile ever requested. Expensive
// renders (e.g. ESA WorldCover's per-3° COG fan-out) keep the global
// R2 layer. Configured per dataset in tilesets.ts via the `persist`
// argument each handler forwards here.

export interface RenderedTileOptions {
  /** Full R2 object key for the rendered tile (embeds the cache
   *  version, format, and z/x/y). Only touched when `persist` is on. */
  cacheKey: string;
  /** Stamped onto the edge-cache URL (`?__v=`) so version bumps rotate
   *  the edge cache alongside R2 — the raw client URL doesn't change
   *  when a version bumps, so without this the edge would keep serving
   *  an old tile forever after we orphan its R2 sibling. Must carry
   *  *everything* the R2 key does, or the two layers disagree: tiles go
   *  out `immutable, max-age=1y`, so an edge entry the version can't
   *  reach is an edge entry nothing can dislodge. */
  cacheVersion: string | number;
  contentType: string;
  attribution: string;
  /** Persist rendered tiles to R2 (global cache layer) in addition to
   *  the per-PoP edge cache. */
  persist: boolean;
  /** Render + encode the tile. `null` means "no data here" → 404
   *  (left uncached; MapLibre's raster source marks the tile errored
   *  and fills the hole with the nearest loaded ancestor). */
  render: () => Promise<Uint8Array | null>;
}

export async function serveRenderedTile(
  request: Request,
  env: Env,
  ctx: ExecutionContext,
  o: RenderedTileOptions,
): Promise<Response> {
  const cache = caches.default;
  const cacheReq = edgeCacheRequest(request, o.cacheVersion);
  const edge = await cache.match(cacheReq);
  if (edge) {
    // The stored response carries the x-cache value it was created
    // with (miss / r2-hit); overwrite so clients can tell the layers
    // apart.
    const response = new Response(edge.body, edge);
    response.headers.set("x-cache", "edge-hit");
    return response;
  }

  if (o.persist) {
    const cached = await env.R2.get(o.cacheKey);
    if (cached) {
      const response = new Response(cached.body, {
        headers: {
          "content-type": o.contentType,
          "cache-control": "public, max-age=31536000, immutable",
          "x-cache": "r2-hit",
          "x-attribution": o.attribution,
        },
      });
      ctx.waitUntil(cache.put(cacheReq, response.clone()));
      return response;
    }
  }

  const encoded = await o.render();
  if (!encoded) {
    return new Response("no data", { status: 404 });
  }

  const response = new Response(encoded, {
    headers: {
      "content-type": o.contentType,
      "cache-control": "public, max-age=31536000, immutable",
      "x-cache": "miss",
      "x-attribution": o.attribution,
    },
  });

  ctx.waitUntil(
    (async () => {
      const puts: Promise<unknown>[] = [cache.put(cacheReq, response.clone())];
      if (o.persist) {
        puts.push(
          env.R2.put(o.cacheKey, encoded, {
            httpMetadata: { contentType: o.contentType },
          }),
        );
      }
      await Promise.all(puts);
    })(),
  );

  return response;
}

function edgeCacheRequest(request: Request, version: string | number): Request {
  const url = new URL(request.url);
  url.searchParams.set("__v", String(version));
  return new Request(url.toString(), request);
}
