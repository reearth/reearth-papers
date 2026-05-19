/**
 * papers-tile worker
 *
 * Routes XYZ tile requests to a Workers Container running maplibre-native.
 * Path: /tile/{z}/{x}/{y}.png?style=<url>
 */
import { Container } from "@cloudflare/containers";
import { handleVectorTile } from "./pmtiles.js";
import { handleStyle } from "./style.js";
import { handleWatercolorTile } from "./watercolor.js";

export class TileRenderer extends Container<Env> {
  defaultPort = 8080;
  // Cold starts are the expensive event for this container (image pull +
  // Xvfb + maplibre OpenGL init). Keep it warm longer between requests
  // — at 30 min idle, a single tile during business hours pays for the
  // wake-up amortized over the next half hour of traffic.
  sleepAfter = "30m";

  override async fetch(request: Request): Promise<Response> {
    // Default fetch already proxies to defaultPort. We override only to
    // forward DEFAULT_STYLE_URL via header when the client didn't supply
    // ?style=, so the container can fall back without an env-var redeploy.
    return this.containerFetch(request);
  }
}

const TILE_RE = /^\/tile\/(\d+)\/(\d+)\/(\d+)\.png$/;
const VECTOR_RE = /^\/v\/(\d+)\/(\d+)\/(\d+)\.mvt$/;
const WATERCOLOR_RE = /^\/watercolor\/(\d+)\/(\d+)\/(\d+)\.jpg$/;

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname === "/health") {
      return new Response("ok");
    }

    // Generated MapLibre style — see src/style.ts. `?theme=` selects
    // among Protomaps' published themes (light/dark/white/black/
    // grayscale); default is light.
    if (url.pathname === "/style.json") {
      return handleStyle(url, request);
    }

    // Vector tile passthrough from the mirrored Protomaps PMTiles
    // archive. Lives on the same worker so the rendering container can
    // fetch tiles via the same `papers.reearth.land` origin (one TLS
    // session, no cross-domain CORS).
    const v = url.pathname.match(VECTOR_RE);
    if (v) {
      return handleVectorTile(
        { z: Number(v[1]), x: Number(v[2]), y: Number(v[3]) },
        env,
      );
    }

    // Raster passthrough from the watercolor PMTiles archive (also in
    // R2). See src/watercolor.ts and watercolor/README.md.
    const w = url.pathname.match(WATERCOLOR_RE);
    if (w) {
      return handleWatercolorTile(
        { z: Number(w[1]), x: Number(w[2]), y: Number(w[3]) },
        env,
      );
    }

    const m = url.pathname.match(TILE_RE);
    if (!m) {
      return new Response("not found", { status: 404 });
    }
    const [, z, x, y] = m;

    // Pass through the client's ?style= as-is; fall back to env default.
    const style = url.searchParams.get("style") ?? env.DEFAULT_STYLE_URL;
    if (!style) {
      return new Response("missing style URL", { status: 400 });
    }

    // Route every request to the same singleton container instance for
    // now — a shared style cache and warm GL context across requests
    // matters more than per-tenant isolation in this PoC.
    const id = env.TILE_CONTAINER.idFromName("singleton");
    const container = env.TILE_CONTAINER.get(id);

    const inner = new URL(`http://container/tile/${z}/${x}/${y}`);
    inner.searchParams.set("style", style);

    const upstream = await container.fetch(inner.toString(), {
      method: "GET",
      headers: { accept: "image/png" },
    });

    // Re-wrap so we can tweak headers without re-streaming.
    const headers = new Headers(upstream.headers);
    headers.set("Cache-Control", "public, max-age=300");
    return new Response(upstream.body, {
      status: upstream.status,
      statusText: upstream.statusText,
      headers,
    });
  },
} satisfies ExportedHandler<Env>;
