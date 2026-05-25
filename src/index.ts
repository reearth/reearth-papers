/**
 * papers-tile worker
 *
 * Public routes:
 *   /styles/{theme}/tile/{z}/{x}/{y}.png — rendered raster tile
 *   /styles/{theme}/tilejson.json        — TileJSON for the above
 *   /styles/{theme}/style.json           — MapLibre style with that theme
 *   /protomaps/{z}/{x}/{y}.mvt           — mirrored Protomaps vector tiles
 *   /protomaps/tilejson.json             — TileJSON for the vector tiles
 *   /watercolor/{z}/{x}/{y}.jpg          — watercolor raster tiles (R2)
 *   /watercolor/tilejson.json            — TileJSON for the watercolor tiles
 *   /esa_worldcover_2021/{z}/{x}/{y}.{png,webp} — ESA WorldCover 2021 tiles
 *   /esa_worldcover_2021/tilejson.json   — TileJSON (?format=png|webp, default webp)
 *   /catalog.json                        — index of all tilesets
 *   /viewer                              — preview page (public/viewer/index.html)
 *   /                                    — temporary 302 → /viewer (LP TBD)
 *
 * `{theme}` is one of light / dark / white / black / grayscale.
 */
import { Container, getContainer } from "@cloudflare/containers";

// Number of container shards used to parallelise renders. Each tile is
// routed to a stable shard derived from its coordinates so the same
// tile keeps hitting the same container (preserving its in-memory
// style cache and warm GL pool), while *different* tiles can land on
// different shards and render concurrently. Keep this ≤ max_instances
// in wrangler.toml so CF can actually spin up that many.
const SHARD_COUNT = 4;
import { lookupCachedTile, storeRenderedTile, tileCacheKey } from "./cache.js";
import { handleCatalog } from "./catalog.js";
import { handleEsaWorldcoverTile } from "./esa_worldcover.js";
import { handleVectorTile } from "./pmtiles.js";
import { handleStyle, isTheme, type Theme } from "./style.js";
import {
  handleEsaWorldcoverTilejson,
  handleRasterTilejson,
  handleVectorTilejson,
  handleWatercolorTilejson,
} from "./tilejson.js";
import { handleWatercolorTile } from "./watercolor.js";

export class TileRenderer extends Container<Env> {
  defaultPort = 8080;
  // Cold starts are the expensive event for this container (image pull +
  // maplibre Vulkan init). Keep it warm longer between requests — at
  // 30 min idle, a single tile during business hours pays for the
  // wake-up amortized over the next half hour of traffic.
  sleepAfter = "30m";
}

const STYLE_TILE_RE = /^\/styles\/([a-z]+)\/tile\/(\d+)\/(\d+)\/(\d+)\.png$/;
const STYLE_TILEJSON_RE = /^\/styles\/([a-z]+)\/tilejson\.json$/;
const STYLE_STYLE_RE = /^\/styles\/([a-z]+)\/style\.json$/;
const VECTOR_RE = /^\/protomaps\/(\d+)\/(\d+)\/(\d+)\.mvt$/;
const WATERCOLOR_RE = /^\/watercolor\/(\d+)\/(\d+)\/(\d+)\.jpg$/;
const ESA_TILE_RE = /^\/esa_worldcover_2021\/(\d+)\/(\d+)\/(\d+)\.(png|webp)$/;

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname === "/health") {
      return new Response("ok");
    }

    // Temporary: root redirects to the preview viewer until a real
    // landing page lands. Use 302 (not 301) so we can swap it for the
    // LP without browsers caching the redirect forever.
    if (url.pathname === "/" || url.pathname === "/index.html") {
      return Response.redirect(`${url.origin}/viewer`, 302);
    }

    if (url.pathname === "/catalog.json") {
      return handleCatalog(request);
    }

    // Vector tile endpoints — theme-independent.
    if (url.pathname === "/protomaps/tilejson.json") {
      return handleVectorTilejson(request);
    }
    const v = url.pathname.match(VECTOR_RE);
    if (v) {
      return handleVectorTile(
        { z: Number(v[1]), x: Number(v[2]), y: Number(v[3]) },
        env,
      );
    }

    // Watercolor raster passthrough + its TileJSON.
    if (url.pathname === "/watercolor/tilejson.json") {
      return handleWatercolorTilejson(request);
    }
    const w = url.pathname.match(WATERCOLOR_RE);
    if (w) {
      return handleWatercolorTile(
        { z: Number(w[1]), x: Number(w[2]), y: Number(w[3]) },
        env,
      );
    }

    // ESA WorldCover 2021 — on-the-fly tile composition from per-3° COGs.
    if (url.pathname === "/esa_worldcover_2021/tilejson.json") {
      return handleEsaWorldcoverTilejson(request);
    }
    const et = url.pathname.match(ESA_TILE_RE);
    if (et) {
      return handleEsaWorldcoverTile(
        request,
        env,
        ctx,
        { z: Number(et[1]), x: Number(et[2]), y: Number(et[3]) },
        et[4] as "png" | "webp",
      );
    }

    // Themed routes. We validate the theme once at parse time and pass
    // the narrowed type into the handlers.
    const styleJson = url.pathname.match(STYLE_STYLE_RE);
    if (styleJson) {
      const theme = requireTheme(styleJson[1]);
      return theme instanceof Response ? theme : handleStyle(theme, request);
    }
    const tilejson = url.pathname.match(STYLE_TILEJSON_RE);
    if (tilejson) {
      const theme = requireTheme(tilejson[1]);
      return theme instanceof Response ? theme : handleRasterTilejson(request, theme);
    }
    const tile = url.pathname.match(STYLE_TILE_RE);
    if (tile) {
      const theme = requireTheme(tile[1]);
      if (theme instanceof Response) return theme;
      return renderRasterTile(request, env, ctx, theme, {
        z: Number(tile[2]),
        x: Number(tile[3]),
        y: Number(tile[4]),
      });
    }

    return new Response("not found", { status: 404 });
  },
} satisfies ExportedHandler<Env>;

function tileShard(coords: { z: number; x: number; y: number }): number {
  // Cheap, deterministic 32-bit mix of the three coords. The exact
  // distribution doesn't matter much — we just need different tiles to
  // land on different shards reliably.
  const mixed =
    (coords.z * 73856093) ^ (coords.x * 19349663) ^ (coords.y * 83492791);
  return (mixed >>> 0) % SHARD_COUNT;
}

function requireTheme(raw: string | undefined): Theme | Response {
  if (raw && isTheme(raw)) return raw;
  return new Response(`unknown theme: ${raw ?? ""}`, { status: 404 });
}

async function renderRasterTile(
  request: Request,
  env: Env,
  ctx: ExecutionContext,
  theme: Theme,
  coords: { z: number; x: number; y: number },
): Promise<Response> {
  // The renderer container fetches its style from the mirror worker
  // (see CONTRIBUTING.md §1 — Workers Containers + maplibre-native).
  // The theme is selected via a query string on that URL.
  //
  // Cache key uses the un-tokenised URL so rotating the shared secret
  // doesn't invalidate every cached tile. The token is appended only
  // for the actual fetch the container performs.
  const styleUrlForCache = `${env.DEFAULT_STYLE_URL}?theme=${theme}`;

  // Two-layer cache (Cache API → R2). Key embeds a style hash + the
  // current PMTiles mirror date, so monthly mirror updates and style
  // edits invalidate exactly the tiles they should.
  const key = await tileCacheKey(env, coords, styleUrlForCache);
  const cached = await lookupCachedTile(request, env, key);
  if (cached) return cached;

  // Cache miss → render via container. We pin each tile to a shard
  // derived from its (z,x,y) so the same tile always hits the same
  // container instance (warm style + GL pool) and different tiles can
  // render in parallel across shards.
  const shard = tileShard(coords);
  const container = getContainer(env.TILE_CONTAINER, `shard-${shard}`);
  const inner = new URL(`http://container/tile/${coords.z}/${coords.x}/${coords.y}`);
  const styleUrl =
    `${styleUrlForCache}&token=${encodeURIComponent(env.INTERNAL_TOKEN)}`;
  inner.searchParams.set("style", styleUrl);
  const upstream = await container.fetch(inner.toString(), {
    method: "GET",
    headers: { accept: "image/png" },
  });
  if (!upstream.ok) {
    // Don't pollute the cache with errors; pass the failure through.
    return upstream;
  }
  const body = await upstream.arrayBuffer();
  return storeRenderedTile(request, env, key, body, ctx);
}
