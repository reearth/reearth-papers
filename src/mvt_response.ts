// The one place a vector tile response is built.
//
// The content type is what gets a tile compressed. Cloudflare's edge
// compresses `application/x-protobuf` and leaves the registered MVT type
// alone, and it picks zstd, br or gzip from what the client actually
// asked for. The Worker cannot do that negotiation itself: it sees
// `accept-encoding: br, gzip` on every request, whatever the client
// sent. So the body is always the decoded MVT and the Worker never sets
// `content-encoding`; a tile once went out as raw bytes labelled gzip and
// broke maplibre-native.
// https://developers.cloudflare.com/speed/optimization/content/compression/

/** Headers a handler may add. The list is closed on purpose: a literal
 *  that passes `content-type` or `content-encoding` fails to typecheck. */
export interface VectorTileHeaders {
  "cache-control": string;
  "x-attribution"?: string;
  "x-overture-release"?: string;
}

export function vectorTileResponse(
  mvt: ArrayBuffer | Uint8Array<ArrayBuffer>,
  headers: VectorTileHeaders,
): Response {
  return new Response(mvt, {
    headers: { ...headers, "content-type": "application/x-protobuf", vary: "accept-encoding" },
  });
}
