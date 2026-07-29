/**
 * papers-tile worker
 *
 * Public routes:
 *   /styles/{theme}/tile/{z}/{x}/{y}.png — rendered raster tile
 *   /styles/{theme}/tilejson.json        — TileJSON for the above
 *   /styles/{theme}/style.json           — MapLibre style with that theme
 *   /{id}/{z}/{x}/{y}.{ext}              — tiles for every registered tileset
 *   /{id}/tilejson.json                  — TileJSON (?format= where multi-format)
 *   /{id}/style.json                     — MapLibre style (vector tilesets that ship cartography)
 *   /{id}.{tif,pmtiles}                  — underlying single-file archive
 *                                          (HTTP Range supported; GDAL /vsicurl/
 *                                          and the pmtiles protocol read these)
 *   /catalog.json                        — index of all tilesets
 *   /viewer                              — preview page (public/viewer/index.html)
 *   /                                    — temporary 302 → /viewer (LP TBD)
 *
 * `{theme}` is one of papers-light / papers-dark (the house styles) or
 * light / dark / white / black / grayscale (stock Protomaps themes).
 * `{id}` and `{ext}` are data-driven from the central tileset registry
 * (src/tilesets.ts) — adding a dataset is one entry there; the tile
 * route, TileJSON route, and catalog entry all derive from it.
 */
import { Container, getContainer } from "@cloudflare/containers";

// Number of container shards used to parallelise renders. Each tile is
// routed to a stable shard derived from its coordinates so the same
// tile keeps hitting the same container (preserving its in-memory
// style cache and warm GL pool), while *different* tiles can land on
// different shards and render concurrently. Keep this ≤ max_instances
// in wrangler.toml so CF can actually spin up that many.
//
// The render pool is single-threaded per instance (maplibre-native
// serialises tiles through one Vulkan context), so shards ARE our only
// render parallelism. Sized to ~a full viewport's tile count so an
// interactive pan/zoom fans its tiles across distinct instances and
// renders them concurrently (~1 warm render each) instead of queueing
// several per instance. Past ~viewport size there's no single-viewport
// gain — only headroom for concurrent users — and it scatters traffic
// across more (cold) instances, so don't over-shard.
const SHARD_COUNT = 32;
import { lookupCachedTile, storeRenderedTile, tileCacheKey } from "./cache.js";
import { handleCatalog } from "./catalog.js";
import { handleSourceFile } from "./source_file.js";
import { handleStyle, isTheme, type Theme } from "./style.js";
import {
  handleRasterTilejson,
  handleTilesetTilejson,
  RENDERED_RASTER_MAXZOOM,
} from "./tilejson.js";
import { TILESETS_BY_ID, type TileFormat } from "./tilesets.js";

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
// Tile + TileJSON + source-archive shapes for every registered
// tileset, resolved against the central registry (src/tilesets.ts).
const TILESET_TILE_RE = /^\/([a-z0-9_]+)\/(\d+)\/(\d+)\/(\d+)\.([a-z]+)$/;
const TILESET_TILEJSON_RE = /^\/([a-z0-9_]+)\/tilejson\.json$/;
const TILESET_STYLE_RE = /^\/([a-z0-9_]+)\/style\.json$/;
const TILESET_SOURCE_RE = /^\/([a-z0-9_]+)\.(tif|pmtiles)$/;

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    // CORS preflight. Browser clients send one before any request with
    // a non-safelisted header — notably `Range`, which geotiff.js and
    // the pmtiles protocol use against the /<id>.{tif,pmtiles} source
    // routes. Answer globally; everything we serve is public.
    if (request.method === "OPTIONS") {
      return new Response(null, {
        status: 204,
        headers: {
          "access-control-allow-origin": "*",
          "access-control-allow-methods": "GET, HEAD",
          "access-control-allow-headers": "*",
          "access-control-max-age": "86400",
        },
      });
    }

    // Method gate: this is a read-only tile service. Anything other
    // than GET or HEAD is bounced with 405 (and an `Allow` header so
    // RFC-friendly clients don't have to guess).
    if (request.method !== "GET" && request.method !== "HEAD") {
      return new Response("method not allowed", {
        status: 405,
        headers: { allow: "GET, HEAD, OPTIONS" },
      });
    }

    // Normalise HEAD → GET so downstream handlers (the Cache API in
    // particular — `cache.put` rejects non-GET requests) don't have to
    // special-case it. The body is stripped before the response goes
    // back to the client.
    const isHead = request.method === "HEAD";
    const response = await dispatch(
      isHead ? new Request(request, { method: "GET" }) : request,
      env,
      ctx,
    );

    // Everything this worker serves is public — stamp CORS once here
    // instead of per handler. (Without this, cross-origin MapLibre
    // clients can fetch our TileJSON but not the tiles it points at.)
    // Cache API / R2-derived responses can be immutable, so re-wrap.
    const out = new Response(isHead ? null : response.body, response);
    out.headers.set("access-control-allow-origin", "*");
    return out;
  },
} satisfies ExportedHandler<Env>;

async function dispatch(
  request: Request,
  env: Env,
  ctx: ExecutionContext,
): Promise<Response> {
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

  // Registered tilesets (src/tilesets.ts) — TileJSON, then tiles.
  // Passthrough entries have no handleTile and fall through to 404 on
  // the tile route; their tiles live at the upstream provider.
  const tj = url.pathname.match(TILESET_TILEJSON_RE);
  if (tj) {
    const def = TILESETS_BY_ID.get(tj[1]);
    if (def) return handleTilesetTilejson(request, def);
  }
  // Vector tilesets that ship their own cartography expose a MapLibre
  // style at /<id>/style.json (linked from the catalog).
  const sj = url.pathname.match(TILESET_STYLE_RE);
  if (sj) {
    const def = TILESETS_BY_ID.get(sj[1]);
    if (def?.styleJson) {
      return new Response(JSON.stringify(def.styleJson(url.origin)), {
        headers: {
          "content-type": "application/json",
          "cache-control": "public, max-age=300",
          "access-control-allow-origin": "*",
        },
      });
    }
  }
  const t = url.pathname.match(TILESET_TILE_RE);
  if (t) {
    const def = TILESETS_BY_ID.get(t[1]);
    const fmt = t[5] as TileFormat;
    if (def?.handleTile && def.formats?.includes(fmt)) {
      return def.handleTile(
        request,
        env,
        ctx,
        { z: Number(t[2]), x: Number(t[3]), y: Number(t[4]) },
        fmt,
      );
    }
  }
  const sf = url.pathname.match(TILESET_SOURCE_RE);
  if (sf) {
    const def = TILESETS_BY_ID.get(sf[1]);
    if (def?.source && def.source.ext === sf[2]) {
      return handleSourceFile(request, env, def.source);
    }
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
    const z = Number(tile[2]);
    // Bound render cost: the tilejson only advertises tiles through
    // RENDERED_RASTER_MAXZOOM, so a request past it is a direct hit — no
    // point spinning the container up to overzoom the z15 vector further.
    if (z > RENDERED_RASTER_MAXZOOM) {
      return new Response("zoom above available range", { status: 404 });
    }
    return renderRasterTile(request, env, ctx, theme, {
      z,
      x: Number(tile[3]),
      y: Number(tile[4]),
    });
  }

  return new Response("not found", { status: 404 });
}

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
