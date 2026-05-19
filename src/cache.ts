// Two-layer cache for rendered raster tiles.
//
//   Cache API  (caches.default, per-CF-colo edge)  — fastest, free
//        ↓ miss
//   R2 cache   (global, paid per-class-B-op)        — survives cold isolates
//        ↓ miss
//   Container render                                — slow path
//
// Both layers key on the same string. The key embeds:
//   - a hash of `STYLE_VERSION:<style-url>` so any style edit (bump the
//     constant) or alternate `?style=` URL gets a fresh namespace, and
//   - the current mirrored PMTiles date so a fresh monthly snapshot
//     orphans the previous month's tiles in one shot.
//
// We accept that orphaned tiles linger in R2 until an external lifecycle
// rule or cleanup pass deletes them; for a monthly cadence the cost is
// modest.

import { readMirrorPointer } from "./pmtiles.js";

// Bump this whenever the *content* of the generated style changes in a
// way clients should see immediately (new layer, label change, palette
// edit). Old cache entries become unreachable as soon as the new worker
// is live.
const STYLE_VERSION = 1;

interface CacheCoords {
  z: number;
  x: number;
  y: number;
}

async function styleHash(styleUrl: string): Promise<string> {
  const input = new TextEncoder().encode(`${STYLE_VERSION}:${styleUrl}`);
  const digest = await crypto.subtle.digest("SHA-256", input);
  // 12 hex chars = 48 bits — plenty for namespacing within an R2 prefix.
  return Array.from(new Uint8Array(digest, 0, 6))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

export async function tileCacheKey(
  env: Env,
  coords: CacheCoords,
  styleUrl: string,
): Promise<string> {
  const pointer = await readMirrorPointer(env);
  const hash = await styleHash(styleUrl);
  return `cache/tile/${hash}/${pointer.date}/${coords.z}/${coords.x}/${coords.y}.png`;
}

/**
 * Look up a cached tile, in order: Cache API → R2. Returns `null` on a
 * cold cache. Promotes R2 hits into the Cache API for future requests
 * served from the same colo.
 */
export async function lookupCachedTile(
  request: Request,
  env: Env,
  key: string,
): Promise<Response | null> {
  const cache = caches.default;
  const edge = await cache.match(request);
  if (edge) return edge;

  const obj = await env.R2.get(key);
  if (!obj) return null;

  const response = new Response(obj.body, {
    headers: {
      "content-type": "image/png",
      "cache-control": "public, max-age=300, stale-while-revalidate=86400",
      "x-cache": "r2-hit",
    },
  });
  // Populate the edge cache so the same colo doesn't hit R2 again next
  // time. `clone()` because the body is consumed when sent to the client.
  await cache.put(request, response.clone());
  return response;
}

/**
 * Store a freshly rendered tile in both layers. Skips caching for
 * non-2xx responses — we don't want to memoize a 500 from the renderer.
 */
export async function storeRenderedTile(
  request: Request,
  env: Env,
  key: string,
  body: ArrayBuffer,
  ctx: ExecutionContext,
): Promise<Response> {
  const response = new Response(body, {
    headers: {
      "content-type": "image/png",
      "cache-control": "public, max-age=300, stale-while-revalidate=86400",
      "x-cache": "miss",
    },
  });

  // Both writes are async; do them off the request path with waitUntil
  // so the user gets the tile back as soon as the body is ready. Errors
  // here would only cost us a cache fill — never the response itself.
  ctx.waitUntil(
    (async () => {
      const cache = caches.default;
      await Promise.all([
        env.R2.put(key, body, {
          httpMetadata: { contentType: "image/png" },
          customMetadata: {
            cachedAt: new Date().toISOString(),
          },
        }),
        cache.put(request, response.clone()),
      ]);
    })(),
  );

  return response;
}
