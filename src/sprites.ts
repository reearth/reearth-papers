// Mirrored Protomaps sprite sheets, the same arrangement src/fonts.ts
// gives the glyph PBFs: served publicly at /sprites/v4/{name}.{png,json}
// and consumed internally by the ezu shadow renderer (src/ezu.ts), which
// calls `handleSprite` directly rather than fetching its own origin (a
// worker fetching its own route trips Cloudflare's recursion guard).
//
// The recipes still carry protomaps.github.io URLs, so before this the
// sprite was the one asset a cold ezu isolate pulled from outside our
// infrastructure — ~200ms on the first tile, and a hard dependency on
// GitHub Pages being up for any isolate that had not rendered yet. It is
// 20KB per theme, so mirroring is close to free.
//
// Unlike the fonts there is no pre-seeded mirror: the first request for
// each object backfills R2 from upstream.

const UPSTREAM_BASE = "https://protomaps.github.io/basemaps-assets/sprites";

/** `{name}.{ext}` under a version directory, e.g. `v4/light.png`. Kept
 *  narrow so nothing can walk out of the prefix. */
export const SPRITE_PATH_RE = /^(v\d+)\/([a-z0-9_-]+(?:@2x)?)\.(png|json)$/;

export async function handleSprite(
  request: Request,
  env: Env,
  ctx: ExecutionContext,
  path: string,
): Promise<Response> {
  const m = path.match(SPRITE_PATH_RE);
  if (!m) return new Response("not found", { status: 404 });
  const [, version, name, ext] = m;

  const cache = caches.default;
  const cached = await cache.match(request);
  if (cached) return cached;

  const key = `mirror/sprites/${version}/${name}.${ext}`;
  const obj = await env.R2.get(key);
  let body: ArrayBuffer | ReadableStream;
  if (obj) {
    body = obj.body;
  } else {
    const upstream = await fetch(`${UPSTREAM_BASE}/${version}/${name}.${ext}`);
    if (!upstream.ok) return new Response("not found", { status: 404 });
    const bytes = await upstream.arrayBuffer();
    ctx.waitUntil(env.R2.put(key, bytes, { httpMetadata: { contentType: contentType(ext) } }));
    body = bytes;
  }

  const response = new Response(body, {
    headers: {
      "content-type": contentType(ext),
      "cache-control": "public, max-age=86400",
      "access-control-allow-origin": "*",
    },
  });
  ctx.waitUntil(cache.put(request, response.clone()));
  return response;
}

function contentType(ext: string): string {
  return ext === "png" ? "image/png" : "application/json";
}

/** The `v4/light.png` part of an upstream sprite URL, or null if the URL
 *  points somewhere we do not mirror. */
export function upstreamSpritePath(url: string): string | null {
  if (!url.startsWith(`${UPSTREAM_BASE}/`)) return null;
  const path = url.slice(UPSTREAM_BASE.length + 1);
  return SPRITE_PATH_RE.test(path) ? path : null;
}
