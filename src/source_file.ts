// Direct download / range-read access to a tileset's underlying
// single-file archive (COG or PMTiles) in R2.
//
// COGs and PMTiles are both designed to be consumed remotely via HTTP
// range requests — exposing the file itself lets GIS clients skip our
// tile pipeline entirely: GDAL/QGIS read `/vsicurl/…/<id>.tif`
// directly, and the pmtiles protocol handler reads `…/<id>.pmtiles`.
//
// Range semantics (single-range only, like R2 itself):
//   bytes=A-B   → 206 with that window (B clamped to EOF)
//   bytes=A-    → 206 from A to EOF
//   bytes=-N    → 206 with the last N bytes
//   multi-range → first range only (clients like geotiff.js detect
//                 this and re-issue the remainder one-by-one)
//   A ≥ size    → 416 with `content-range: bytes */<size>`
//   unparsable  → ignored (200, full body) per RFC 9110 §14.2
//
// Responses are served straight from R2 (no edge caching: range
// permutations cache poorly and R2 reads are what the tile handlers
// pay anyway). CORS is wide open — the preflight for the non-safelisted
// `Range` header is answered globally in index.ts.

export interface SourceFile {
  /** Static R2 object key, or a resolver for pointer-indirected
   *  archives (e.g. the monthly-rotated Protomaps mirror). */
  key: string | ((env: Env) => Promise<string>);
  /** Public route extension: /<id>.<ext> */
  ext: "tif" | "pmtiles";
  contentType: string;
}

type ParsedRange = { offset: number; length?: number } | { suffix: number };

function parseRange(header: string): ParsedRange | null {
  // First range only; trailing `,…` (multi-range) is deliberately
  // ignored — see the header comment.
  const m = /^bytes=(\d*)-(\d*)(?:,|$)/.exec(header.trim());
  if (!m) return null;
  const [, a, b] = m;
  if (a === "" && b === "") return null;
  if (a === "") return { suffix: Number(b) };
  if (b === "") return { offset: Number(a) };
  const offset = Number(a);
  const end = Number(b);
  if (end < offset) return null;
  return { offset, length: end - offset + 1 };
}

export async function handleSourceFile(
  request: Request,
  env: Env,
  src: SourceFile,
): Promise<Response> {
  const key = typeof src.key === "function" ? await src.key(env) : src.key;

  const baseHeaders: Record<string, string> = {
    "content-type": src.contentType,
    "accept-ranges": "bytes",
    // The mirrored archives are immutable (or pointer-rotated monthly
    // for Protomaps); a moderate TTL keeps clients honest without
    // pinning a stale protomaps archive for long.
    "cache-control": "public, max-age=3600",
    "access-control-allow-origin": "*",
    "access-control-expose-headers": "content-range, content-length, etag",
  };

  const rangeHeader = request.headers.get("range");
  const range = rangeHeader ? parseRange(rangeHeader) : null;

  if (!range) {
    const obj = await env.R2.get(key);
    if (!obj) return new Response("not found", { status: 404 });
    return new Response(obj.body, {
      headers: {
        ...baseHeaders,
        "content-length": String(obj.size),
        etag: obj.httpEtag,
      },
    });
  }

  // R2 throws on out-of-bounds ranges (offset ≥ size); turn that into
  // a proper 416 with the object's actual size.
  let obj: R2ObjectBody | null = null;
  try {
    obj = await env.R2.get(key, { range });
  } catch {
    obj = null;
  }
  if (!obj) {
    const head = await env.R2.head(key);
    if (!head) return new Response("not found", { status: 404 });
    return new Response("range not satisfiable", {
      status: 416,
      headers: { ...baseHeaders, "content-range": `bytes */${head.size}` },
    });
  }

  // Resolve the window R2 actually returned (it clamps lengths that
  // run past EOF) so content-range / content-length always match the
  // body.
  const size = obj.size;
  let offset: number;
  let length: number;
  if ("suffix" in range) {
    length = Math.min(range.suffix, size);
    offset = size - length;
  } else {
    offset = range.offset;
    length = Math.min(range.length ?? size - offset, size - offset);
  }
  if (length <= 0) {
    return new Response("range not satisfiable", {
      status: 416,
      headers: { ...baseHeaders, "content-range": `bytes */${size}` },
    });
  }

  return new Response(obj.body, {
    status: 206,
    headers: {
      ...baseHeaders,
      "content-range": `bytes ${offset}-${offset + length - 1}/${size}`,
      "content-length": String(length),
      etag: obj.httpEtag,
    },
  });
}
