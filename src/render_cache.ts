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

import { type Demand, writeDemand } from "./okibi.js";

/** Make an attribution safe to put in a response header.
 *
 *  `x-attribution` carries the same HTML the TileJSON does, and that HTML
 *  is not ASCII — the credits are joined with `·`, and a dataset is free
 *  to name a rights holder in any script. A header value is bytes, and
 *  workerd sends UTF-8 with a warning that a browser reading it through
 *  the Fetch API would raise a `TypeError` instead.
 *
 *  Since the payload is HTML, HTML says how to spell those characters in
 *  ASCII: a numeric character reference. `·` becomes `&#183;`, which
 *  renders identically wherever the credit is pasted and sits beside the
 *  `&copy;` the same strings already carry.
 *
 *  The `u` flag matters — without it an astral character is two matches
 *  (its surrogates) and each escapes to a reference for half a
 *  character. */
export function headerSafeHtml(html: string): string {
  return html.replace(/[^\x20-\x7E]/gu, (c) => `&#${c.codePointAt(0)};`);
}

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
  /** What okibi records about this request, if anything.
   *
   *  This is the one place that knows all three parts of an event at
   *  once: which layer answered, how long the render took, and how many
   *  bytes went out. Split across the callers it would be three
   *  measurements of a thing that happened here. */
  demand?: Demand;
}

export async function serveRenderedTile(
  request: Request,
  env: Env,
  ctx: ExecutionContext,
  o: RenderedTileOptions,
): Promise<Response> {
  // Timed from here rather than from around the render, because a Worker's
  // clock only advances after I/O — a Spectre mitigation — so a stopwatch
  // either side of a render reads whatever the last fetch left it at, and a
  // render that is pure CPU reads zero. What this spans is the cold request
  // end to end, which is also the number worth having: it is what somebody
  // waited.
  const startedAt = Date.now();
  // Both cache layers are hits as far as demand goes: what okibi is counting
  // is that somebody wanted this tile, and where the bytes came from is not
  // what makes it worth warming.
  const record = (
    status: "hit" | "miss",
    genMs: number,
    bytes: number,
  ): void => {
    if (o.demand) writeDemand(env, request, o.demand, status, genMs, bytes);
  };

  const cache = caches.default;
  const cacheReq = edgeCacheRequest(request, o.cacheVersion);
  const edge = await cache.match(cacheReq);
  if (edge) {
    // The stored response carries the x-cache value it was created
    // with (miss / r2-hit); overwrite so clients can tell the layers
    // apart.
    const response = new Response(edge.body, edge);
    response.headers.set("x-cache", "edge-hit");
    record("hit", 0, Number(response.headers.get("content-length") ?? 0));
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
          "x-attribution": headerSafeHtml(o.attribution),
        },
      });
      ctx.waitUntil(cache.put(cacheReq, response.clone()));
      record("hit", 0, cached.size);
      return response;
    }
  }

  const encoded = await o.render();
  if (!encoded) {
    // A tile with no data behind it is not demand for a tile: nothing here
    // could ever be warmed, and counting it would put a cell in the ledger
    // that no plan can act on.
    return new Response("no data", { status: 404 });
  }

  const response = new Response(encoded, {
    headers: {
      "content-type": o.contentType,
      "cache-control": "public, max-age=31536000, immutable",
      "x-cache": "miss",
      "x-attribution": headerSafeHtml(o.attribution),
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
      // Recorded after the writes, because they are the I/O that lets the
      // clock catch up with the render. Reading it before would be reading
      // the time as of whatever the render last fetched.
      try {
        await Promise.all(puts);
      } finally {
        record("miss", Date.now() - startedAt, encoded.byteLength);
      }
    })(),
  );

  return response;
}

function edgeCacheRequest(request: Request, version: string | number): Request {
  const url = new URL(request.url);
  url.searchParams.set("__v", String(version));
  return new Request(url.toString(), request);
}
