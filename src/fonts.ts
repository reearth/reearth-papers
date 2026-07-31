// Self-hosted glyph PBFs (see mirror/fonts/): Protomaps' stacks with
// the CJK gap filled. Served publicly at /fonts/{fontstack}/{range}.pbf
// and consumed internally by the ezu shadow renderer (src/ezu.ts),
// which calls `handleFont` directly instead of fetching its own origin
// (a worker fetching its own route trips Cloudflare's recursion
// guard).

export async function handleFont(
  request: Request,
  env: Env,
  ctx: ExecutionContext,
  stackEnc: string,
  file: string,
): Promise<Response> {
  // Fontstack names carry spaces ("Noto Sans Regular") so the path
  // segment arrives percent-encoded; decode before the R2 lookup and
  // reject anything that would escape the prefix.
  const stack = decodeURIComponent(stackEnc);
  if (stack.includes("/") || stack.includes("..")) {
    return new Response("not found", { status: 404 });
  }

  // Glyph ranges are hot during a container cold start (a CJK-dense
  // style load touches dozens of them) — front R2 with the edge cache.
  const cache = caches.default;
  const cached = await cache.match(request);
  if (cached) return cached;

  const key = `mirror/fonts/${stack}/${file}`;
  const obj = await env.R2.get(key);
  let body: ArrayBuffer | ReadableStream;
  if (obj) {
    body = obj.body;
  } else {
    // Stack or range we haven't mirrored — the styles switch to
    // per-script PGF stacks via data-driven text-font, so new upstream
    // stacks can appear under our feet. Falling back matters more
    // than usual here: maplibre-native aborts the whole render process
    // on a glyph 404 (a Devanagari tile crash-looped the containers
    // when this route 404'd the PGF stack). Backfill R2 so the
    // fallback is one-time per object.
    const upstream = await fetch(
      `https://protomaps.github.io/basemaps-assets/fonts/${encodeURIComponent(stack)}/${file}`,
    );
    if (!upstream.ok) return new Response("not found", { status: 404 });
    const bytes = await upstream.arrayBuffer();
    ctx.waitUntil(
      env.R2.put(key, bytes, {
        httpMetadata: { contentType: "application/x-protobuf" },
      }),
    );
    body = bytes;
  }

  const response = new Response(body, {
    headers: {
      "content-type": "application/x-protobuf",
      "cache-control": "public, max-age=86400",
      "access-control-allow-origin": "*",
    },
  });
  ctx.waitUntil(cache.put(request, response.clone()));
  return response;
}
