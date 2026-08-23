/**
 * papers-tile worker
 *
 * Public routes:
 *   /styles/{theme}/tile/{z}/{x}/{y}.{webp,png}
 *                                        — rendered raster tile (ezu);
 *                                          webp is the advertised default
 *   /styles/{theme}/ezu/{z}/{x}/{y}.{webp,png}
 *                                        — same render, pre-cutover path
 *   /styles/{theme}/native/{z}/{x}/{y}.png
 *                                        — maplibre-native, comparison only
 *   /styles/{theme}/tilejson.json        — TileJSON for the above
 *   /styles/{theme}/style.json           — MapLibre style with that theme
 *   /styles/{paint}/tile/{z}/{x}/{y}.{webp,png}
 *                                        — paint style, rendered from a
 *                                          document on the R2 shelf
 *                                          (?<param>= per its schema)
 *   /styles/{paint}/tilejson.json        — TileJSON for the above
 *   /styles/{paint}/params.json          — JSON Schema of that style's params
 *   /{id}/{z}/{x}/{y}.{ext}              — tiles for every registered tileset
 *   /{id}/tilejson.json                  — TileJSON (?format= where multi-format)
 *   /{id}/style.json                     — MapLibre style (vector tilesets that ship cartography)
 *   /{id}.{tif,pmtiles}                  — underlying single-file archive
 *                                          (HTTP Range supported; GDAL /vsicurl/
 *                                          and the pmtiles protocol read these)
 *   /fonts/{fontstack}/{range}.pbf       — mirrored glyph PBFs
 *   /sprites/{version}/{name}.{png,json} — mirrored Protomaps sprites
 *   /catalog.json                        — index of all tilesets
 *   /viewer                              — preview page (public/viewer/index.html)
 *   /                                    — temporary 302 → /viewer (LP TBD)
 *
 * `{theme}` is one of papers-light / papers-dark (the house styles) or
 * protomaps-{light,dark,white,black,grayscale} (stock Protomaps themes).
 * The old unprefixed stock ids (light, dark, ...) 301 to the prefixed
 * ones — see `LEGACY_THEMES` in style.ts.
 * `{paint}` is whatever the R2 shelf currently holds (src/paint_styles.ts)
 * — `paint-sumi`, `paint-wash`, … — so that set grows by publishing
 * rather than by deploying. Paint styles have no `style.json`: an ezu
 * document is a node graph, and there is no MapLibre style that means the
 * same thing. `params.json` is what a client reads instead.
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
// render parallelism. Sized back when this path served the public
// tiles: ~a full viewport's tile count, so an interactive pan/zoom
// fanned across distinct instances instead of queueing several per
// instance. Since the ezu cutover only the viewer's comparison map
// reaches here, so the number is oversized rather than tuned — left as
// is because shards cost nothing idle.
const SHARD_COUNT = 32;
import { STYLE_VERSION } from "./cache.js";
import { tileCjkFlavor } from "./cjk_flavor.js";
import { handleCatalog } from "./catalog.js";
import {
  ezuRecipeVersion,
  ezuRenderStats,
  type EzuFormat,
  EZU_THEMES,
  renderEzuStyleTile,
  renderEzuTile,
} from "./ezu.js";
import { handleFont } from "./fonts.js";
import {
  PAINT_RUNTIME_VERSION,
  type PaintFormat,
  type PaintStyle,
  paintAsset,
  paintDocument,
  paintStyle,
  readParams,
} from "./paint_styles.js";
import { readMirrorPointer } from "./pmtiles.js";
import { headerSafeHtml, serveRenderedTile } from "./render_cache.js";
import { handleSprite } from "./sprites.js";
import { handleSourceFile } from "./source_file.js";
import {
  handleStyle,
  isTheme,
  LEGACY_THEMES,
  mirrorTheme,
  type Theme,
} from "./style.js";
import {
  handlePaintTilejson,
  handleRasterTilejson,
  handleTilesetTilejson,
  RENDERED_RASTER_MAXZOOM,
} from "./tilejson.js";
import {
  PROTOMAPS_ATTRIBUTION,
  TILESETS_BY_ID,
  type TileFormat,
} from "./tilesets.js";

export class TileRenderer extends Container<Env> {
  defaultPort = 8080;
  // Cold starts are the expensive event for this container (image pull +
  // maplibre Vulkan init) and, since the ezu cutover, nearly every
  // request here is one: only the viewer's comparison map reaches this
  // path. 30 min idle keeps a reviewer's second and third tile warm
  // without paying for a renderer nobody is looking at.
  sleepAfter = "30m";
}

// The theme capture allows hyphens (`papers-light`); `requireTheme`
// narrows it to an actual member of THEMES right after the match.
//
// `/tile/` is the public raster route and renders with ezu (src/ezu.ts).
// `/ezu/` is the same render under the name the comparison used before
// the cutover, kept so existing links keep working; both share one cache
// namespace, so neither re-renders what the other already has.
//
// `.webp` costs the same to encode as an uncompressed render where PNG's
// deflate adds 30-48ms, is ~17% smaller on the wire, and decodes quicker
// client-side, so the TileJSON advertises it by default. `.png` stays
// served on the same route for clients that ask for it (`?format=png`).
const STYLE_TILE_RE =
  /^\/styles\/([a-z-]+)\/(?:tile|ezu)\/(\d+)\/(\d+)\/(\d+)\.(png|webp)$/;
// maplibre-native, via the renderer container. Comparison only since the
// cutover: nothing links here but the viewer's right-hand map, so its
// renders are not worth a global R2 layer (see `renderNativeTile`).
const STYLE_NATIVE_RE = /^\/styles\/([a-z-]+)\/native\/(\d+)\/(\d+)\/(\d+)\.png$/;
const STYLE_TILEJSON_RE = /^\/styles\/([a-z-]+)\/tilejson\.json$/;
const STYLE_STYLE_RE = /^\/styles\/([a-z-]+)\/style\.json$/;
// Paint styles only: the params schema behind /styles/{name}/params.json.
// This is the whole of what one publishes about itself — there is no
// `style.json` for a paint style, an ezu document being a node graph with
// no MapLibre style that means the same thing.
const STYLE_PARAMS_RE = /^\/styles\/([a-z-]+)\/params\.json$/;
// Tile + TileJSON + source-archive shapes for every registered
// tileset, resolved against the central registry (src/tilesets.ts).
const TILESET_TILE_RE = /^\/([a-z0-9_]+)\/(\d+)\/(\d+)\/(\d+)\.([a-z]+)$/;
const TILESET_TILEJSON_RE = /^\/([a-z0-9_]+)\/tilejson\.json$/;
const TILESET_STYLE_RE = /^\/([a-z0-9_]+)\/style\.json$/;
const TILESET_SOURCE_RE = /^\/([a-z0-9_]+)\.(tif|pmtiles)$/;
// Self-hosted glyph PBFs (see mirror/fonts/): Protomaps' stacks with
// the CJK gap filled. Referenced by the styles' `glyphs` template and
// fetched by both browsers and the renderer container.
const FONT_RE = /^\/fonts\/([^/]+)\/(\d+-\d+\.pbf)$/;
// Mirrored Protomaps sprite sheets (src/sprites.ts). Same arrangement as
// the fonts: public here, and the ezu renderer calls the handler directly
// so a cold isolate never waits on GitHub Pages.
const SPRITE_RE = /^\/sprites\/(.+)$/;

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
    return handleCatalog(request, env);
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

  const font = url.pathname.match(FONT_RE);
  if (font) {
    return handleFont(request, env, ctx, font[1], font[2]);
  }

  const sprite = url.pathname.match(SPRITE_RE);
  if (sprite) {
    return handleSprite(request, env, ctx, sprite[1]);
  }

  // The stock themes used to live unprefixed (`/styles/light/…`);
  // permanent-redirect those to the `protomaps-*` ids so existing
  // TileJSON consumers and bookmarks keep working.
  const legacy = url.pathname.match(/^\/styles\/([a-z]+)(\/.*)$/);
  if (legacy && LEGACY_THEMES[legacy[1]]) {
    const to = new URL(url);
    to.pathname = `/styles/${LEGACY_THEMES[legacy[1]]}${legacy[2]}`;
    return Response.redirect(to.toString(), 301);
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
    // Themes first, then the paint shelf: a bundled theme id can never
    // be shadowed by something published to R2.
    if (isTheme(tilejson[1])) return handleRasterTilejson(request, tilejson[1]);
    const paint = await paintStyle(env, tilejson[1]);
    if (paint) return handlePaintTilejson(request, paint);
    return new Response(`unknown style: ${tilejson[1]}`, { status: 404 });
  }
  // The params a paint style declares, as JSON Schema — what a UI builds
  // its sliders and colour pickers from. Derived metadata, not the
  // document: it names the knobs and their ranges, and carries none of
  // the cartography that produces the picture.
  const paintParams = url.pathname.match(STYLE_PARAMS_RE);
  if (paintParams) {
    const style = await paintStyle(env, paintParams[1]);
    if (style) {
      return new Response(
        JSON.stringify(style.params ?? { type: "object", properties: {} }),
        {
          headers: {
            "content-type": "application/json",
            "cache-control": "public, max-age=300",
            "access-control-allow-origin": "*",
          },
        },
      );
    }
  }
  const ezu = url.pathname.match(STYLE_TILE_RE);
  if (ezu) {
    const coords = { z: Number(ezu[2]), x: Number(ezu[3]), y: Number(ezu[4]) };
    if (EZU_THEMES.has(ezu[1])) {
      return handleEzu(request, env, ctx, ezu[1], coords, ezu[5] as EzuFormat);
    }
    const paint = await paintStyle(env, ezu[1]);
    if (paint) {
      return handlePaint(request, env, ctx, paint, coords, ezu[5] as PaintFormat);
    }
    return new Response(`unknown style: ${ezu[1]}`, { status: 404 });
  }
  const native = url.pathname.match(STYLE_NATIVE_RE);
  if (native) {
    const theme = requireTheme(native[1]);
    if (theme instanceof Response) return theme;
    const z = Number(native[2]);
    if (z > RENDERED_RASTER_MAXZOOM) {
      return new Response("zoom above available range", { status: 404 });
    }
    return renderNativeTile(request, env, ctx, theme, {
      z,
      x: Number(native[3]),
      y: Number(native[4]),
    });
  }

  return new Response("not found", { status: 404 });
}

// The public raster route: in-worker WASM rendering (src/ezu.ts), served
// for both `/tile/` and the older `/ezu/` path. Cached in its own
// namespace, which the comparison renders never share.
async function handleEzu(
  request: Request,
  env: Env,
  ctx: ExecutionContext,
  theme: string,
  coords: { z: number; x: number; y: number },
  format: EzuFormat,
): Promise<Response> {
  if (!EZU_THEMES.has(theme)) {
    return new Response(`no ezu recipe for theme: ${theme}`, { status: 404 });
  }
  // Past the vector source's maxzoom ezu reprojects the z15 ancestor, so
  // the ceiling is the advertised raster range, not the source's depth.
  if (coords.z > RENDERED_RASTER_MAXZOOM) {
    return new Response("zoom above available range", { status: 404 });
  }
  const version = STYLE_VERSION * 1000 + ezuRecipeVersion(theme);
  // Han variant selection, picked the same way the container path picks it
  // (src/cjk_flavor.ts) so the two renderers agree over the same ground.
  const cjk = tileCjkFlavor(coords) ?? null;
  // The snapshot the tile was rendered from. A render is only valid for
  // the data behind it, and these go out `immutable, max-age=1y`, so
  // without the date in the key a fresh mirror would never reach anyone —
  // the tiles it should have replaced keep being served until a version
  // constant moves. Reading the pointer costs one R2 get per isolate per
  // hour (memoised in pmtiles.ts), and the render path already needs it.
  const { date } = await readMirrorPointer(env);
  const served = await serveRenderedTile(request, env, ctx, {
    // The extension is part of the key, so the two encodings cache side by
    // side instead of one serving the other's bytes. The flavor is derived
    // from the coordinates, so it is already implied by the key — spell it
    // out anyway, so redrawing the flavor boxes is a visible cache change.
    cacheKey:
      `cache/ezu/${version}/${date}/${theme}${cjk ? `-${cjk}` : ""}` +
      `/${coords.z}/${coords.x}/${coords.y}.${format}`,
    cacheVersion: `${version}-${date}`,
    contentType: format === "webp" ? "image/webp" : "image/png",
    attribution: PROTOMAPS_ATTRIBUTION,
    persist: true,
    render: () => renderEzuTile(request, env, ctx, theme, coords, format, cjk),
  });
  // What this isolate's renderer is holding. Stamped on cache hits too —
  // the value describes the isolate right now, not the cached tile.
  const stats = ezuRenderStats();
  const out = new Response(served.body, served);
  out.headers.set("x-ezu-heap", String(stats.heapBytes));
  out.headers.set("x-ezu-glyph", String(stats.glyphBytes));
  out.headers.set("x-ezu-store", `${stats.storeGlyphs}/${stats.storeBytes}`);
  return out;
}

// One paint tile. Same two-layer cache as the themed rasters and the
// same permit budget in the renderer, with two things of its own: the
// document comes from R2 (keyed by its `rev`, which is what makes the
// cache safe), and the request may carry params.
async function handlePaint(
  request: Request,
  env: Env,
  ctx: ExecutionContext,
  style: PaintStyle,
  coords: { z: number; x: number; y: number },
  format: PaintFormat,
): Promise<Response> {
  // A style reading terrain stops where that source stops (see
  // `PaintStyle.maxzoom`) — 404 rather than a tile with a flat DEM
  // silently baked into it.
  if (coords.z > style.maxzoom) {
    return new Response("zoom above available range", { status: 404 });
  }
  const url = new URL(request.url);
  const params = readParams(style, url.searchParams);
  if (typeof params === "string") {
    return new Response(params, {
      status: 400,
      headers: { "content-type": "text/plain; charset=utf-8" },
    });
  }
  // Same reasoning as the themed route: a render is only valid for the
  // vector snapshot behind it, and these go out `immutable, max-age=1y`.
  const { date } = await readMirrorPointer(env);
  const version =
    `${style.rev}-r${PAINT_RUNTIME_VERSION}-${date}-${style.sourceVersion}` +
    (params.canonical ? `-${params.canonical}` : "");
  const served = await serveRenderedTile(request, env, ctx, {
    cacheKey:
      `cache/paint/${style.name}/${style.rev}/r${PAINT_RUNTIME_VERSION}` +
      `/${date}/${style.sourceVersion || "-"}` +
      `/${params.canonical || "default"}/${coords.z}/${coords.x}/${coords.y}.${format}`,
    cacheVersion: version,
    contentType: format === "webp" ? "image/webp" : "image/png",
    attribution: style.attribution,
    // The default picture earns the global R2 layer outright: a paint
    // render is brushes, noise fields and a padded canvas — seconds of
    // WASM CPU where a themed tile costs a fraction of one — and every
    // client asking for a style asks for the same tiles.
    //
    // A tuned one does not. Each distinct set of knobs is its own
    // namespace, so persisting them buys storage for pictures nobody
    // asks for twice. Tuned tiles stay in the per-PoP edge cache, which
    // is what someone dragging a slider and then panning actually
    // re-reads.
    persist: params.canonical === "",
    render: async () =>
      renderEzuStyleTile(
        request,
        env,
        ctx,
        {
          // `rev` in the key, so a republished style builds a new
          // renderer instead of a warm isolate serving the old document.
          key: `paint:${style.name}:${style.rev}`,
          doc: await paintDocument(env, style),
          fetchAsset: (path) => paintAsset(env, style, path),
        },
        coords,
        { format, ...(params.canonical ? { params: params.values } : {}) },
      ),
  });
  const stats = ezuRenderStats();
  const out = new Response(served.body, served);
  out.headers.set("x-ezu-heap", String(stats.heapBytes));
  // What the render actually applied, so a client can tell "the knob did
  // nothing" from "the knob was never read".
  out.headers.set("x-ezu-params", params.canonical || "default");
  return out;
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

async function renderNativeTile(
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
  //
  // `&v=` carries STYLE_VERSION into the URL, which the container keys
  // its own style cache on. Without it a warm instance (30 min idle
  // timeout) keeps rendering from the style it fetched the first time,
  // so a cartography edit would land in a fresh R2 namespace and then
  // be filled with pre-edit renders.
  //
  // `&cjk=` selects the region-priority Han glyph flavor for tiles
  // over Chinese-script regions (see cjk_flavor.ts). Being part of the
  // style URL, it namespaces both the container's style cache and the
  // rendered-tile cache key for exactly the affected tiles.
  // `mirrorTheme` speaks the mirror's pre-rename ids for the stock
  // themes — keeping this URL unchanged preserves every existing tile
  // cache key across the public `protomaps-*` rename.
  const cjk = tileCjkFlavor(coords);
  const styleUrlForCache =
    `${env.DEFAULT_STYLE_URL}?theme=${mirrorTheme(theme)}&v=${STYLE_VERSION}` +
    (cjk ? `&cjk=${cjk}` : "");

  // Edge cache only. Since the cutover this path exists to be compared
  // against, not to be served: the R2 layer bought a global, permanent
  // copy of renders nothing routinely asks for, and every write kept the
  // container's output alive long after the comparison that produced it.
  // A per-PoP cache still spares the container a repeat of whatever a
  // reviewer is looking at right now.
  const cache = caches.default;
  const edge = await cache.match(request);
  if (edge) return edge;

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
  const response = new Response(body, {
    headers: {
      "content-type": "image/png",
      "cache-control": "public, max-age=31536000, immutable",
      "x-cache": "miss",
      "x-renderer": "maplibre-native",
      "x-attribution": headerSafeHtml(PROTOMAPS_ATTRIBUTION),
    },
  });
  ctx.waitUntil(cache.put(request, response.clone()));
  return response;
}
