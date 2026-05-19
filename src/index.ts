/**
 * papers-tile worker
 *
 * Routes:
 *   /tile/{z}/{x}/{y}.png       — render a tile via the renderer container
 *   /style.json                 — generated MapLibre style
 *   /v/{z}/{x}/{y}.mvt          — mirrored Protomaps vector tiles
 *   /watercolor/{z}/{x}/{y}.jpg — watercolor raster tiles (R2)
 */
import { Container, getContainer } from "@cloudflare/containers";
import { handleVectorTile } from "./pmtiles.js";
import { handleStyle } from "./style.js";
import { handleWatercolorTile } from "./watercolor.js";

export class TileRenderer extends Container<Env> {
  defaultPort = 8080;
  // Cold starts are the expensive event for this container (image pull +
  // maplibre OpenGL/Vulkan init). Keep it warm longer between requests
  // — at 30 min idle, a single tile during business hours pays for the
  // wake-up amortized over the next half hour of traffic.
  sleepAfter = "30m";
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

    if (url.pathname === "/style.json") {
      return handleStyle(url, request);
    }

    const v = url.pathname.match(VECTOR_RE);
    if (v) {
      return handleVectorTile(
        { z: Number(v[1]), x: Number(v[2]), y: Number(v[3]) },
        env,
      );
    }

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
    const container = getContainer(env.TILE_CONTAINER);

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
