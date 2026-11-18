// The paint tile route between its request parsing and its renderer: which
// version of the data the cache key names, what the cache is asked for, and
// how a source that cannot be read becomes a response.
//
// Kept apart from src/index.ts, and importing no module that only workerd can
// load, so that the tests drive this wiring as the route runs it.

import type { Epoch } from "@reearth/okibi/writer";

import type { RenderedTileOptions } from "./render_cache.js";
import type { TileCoords } from "./tilesets.js";
import { type PaintSources, PaintSourceError, planVectorSources } from "./paint_sources.js";
import {
  PAINT_RUNTIME_VERSION,
  type PaintFormat,
  type PaintStyle,
  type ParamSelection,
  paintDocument,
  paintEpochSource,
  paintSourceVersion,
  paintStyles,
} from "./paint_styles.js";

export interface PaintTile {
  style: PaintStyle;
  coords: TileCoords;
  format: PaintFormat;
  params: ParamSelection;
  /** The Protomaps snapshot the tile is drawn from. */
  date: string;
}

export interface PaintTileIo {
  env: Env;
  sources: PaintSources;
  /** `serveRenderedTile`, bound to the request. */
  serve: (o: RenderedTileOptions) => Promise<Response>;
  /** `renderEzuStyleTile`, bound to the request and the tile. */
  render: (doc: Record<string, unknown>) => Promise<Uint8Array | null>;
}

// Same two-layer cache as the themed rasters, with two things of its own:
// the document comes from R2 (keyed by its `rev`, which is what makes the
// cache safe), and the request may carry params.
export async function servePaintTile(t: PaintTile, io: PaintTileIo): Promise<Response> {
  const { style, coords, format, params, date } = t;
  const { env, sources } = io;
  // A style that binds nothing extra keys on the manifest alone, so its
  // cache hits do not wait on the document. Without the document there is
  // no telling which kind a style is, so the render below checks before it
  // draws anything.
  let doc: Record<string, unknown> | null = null;
  try {
    doc = await paintDocument(env, style);
  } catch (e) {
    console.warn(`paint: ${style.name} keyed on the manifest's source version: ${String(e)}`);
  }
  let sourceVersion = style.sourceVersion;
  if (doc) {
    try {
      sourceVersion = await paintSourceVersion(style, doc, sources);
    } catch (e) {
      return paintSourceUnavailable(
        style,
        coords,
        new PaintSourceError("read", `source version: ${String(e)}`, { cause: e }),
      );
    }
  }
  const readsExtraSources = sourceVersion !== style.sourceVersion;
  const version =
    `${style.rev}-r${PAINT_RUNTIME_VERSION}-${date}-${sourceVersion}` +
    (params.canonical ? `-${params.canonical}` : "");
  try {
    return await io.serve({
      cacheKey:
        `cache/paint/${style.name}/${style.rev}/r${PAINT_RUNTIME_VERSION}` +
        `/${date}/${sourceVersion || "-"}` +
        `/${params.canonical || "default"}/${coords.z}/${coords.x}/${coords.y}.${format}`,
      cacheVersion: version,
      contentType: format === "webp" ? "image/webp" : "image/png",
      attribution: style.attribution,
      demand: {
        tileset: style.name,
        coords,
        fmt: format,
        // The same string the cache key is namespaced by, so a warm request
        // asks for the picture that was cached rather than for the default one.
        search: params.canonical || undefined,
        // The parts of `version`, which is what the key is namespaced by, kept
        // apart because they move apart: the paint runtime, the style's own
        // revision, and the snapshot it was drawn from.
        epoch: {
          source: paintEpochSource(date, sourceVersion),
          algo: `paint-r${PAINT_RUNTIME_VERSION}`,
          param: `${style.rev}${params.canonical ? `-${params.canonical}` : ""}`,
        },
      },
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
      render: async () => {
        const read = doc ?? (await paintDocument(env, style));
        // A style with extra sources has no tile under the manifest's
        // version, and must not get one: R2 would keep it for good.
        if (!doc && planVectorSources(read, sources.readable).extras.length) {
          throw new PaintSourceError("version", "document unread when the key was built, and it binds extra sources");
        }
        const encoded = await io.render(read);
        // An archive can move between the key above and the reads: a new
        // Overture release, a rebuilt Natural Earth file. A picture from
        // the new data must not be cached under the old key.
        if (readsExtraSources) {
          let after: string;
          try {
            after = await paintSourceVersion(style, read, sources);
          } catch (e) {
            throw new PaintSourceError("version", `source version after render: ${String(e)}`, { cause: e });
          }
          if (after !== sourceVersion) {
            throw new PaintSourceError("version", `sources moved from ${sourceVersion} to ${after}`);
          }
        }
        return encoded;
      },
    });
  } catch (e) {
    if (e instanceof PaintSourceError) return paintSourceUnavailable(style, coords, e);
    throw e;
  }
}

/** A paint tile whose extra sources could not be read, cut or kept still
 *  long enough to render. One log line and an uncached 503, where an
 *  uncaught throw would be a 1101 with no CORS header. A busy slot or a
 *  failed read may pass by the next request; a tile over the slice limit
 *  does not, and this isolate answers it from memory (`readExtraSources`). */
function paintSourceUnavailable(
  style: PaintStyle,
  coords: TileCoords,
  e: PaintSourceError,
): Response {
  console.error(
    JSON.stringify({
      evt: "paint.source_unavailable",
      stage: e.stage,
      style: style.name,
      rev: style.rev,
      z: coords.z,
      x: coords.x,
      y: coords.y,
      error: e.message,
    }),
  );
  return new Response("paint source unavailable", {
    status: 503,
    headers: { "retry-after": "1", "cache-control": "no-store" },
  });
}

/**
 * The okibi epoch of each paint style's parameterless picture, spelled the
 * way `servePaintTile` spells a tile's.
 *
 * A style whose source version cannot be read now keeps the epoch `recorded`
 * for it, or is left out when there is none. The manifest's version in its
 * place would look like a change of data to okibi, and the next good read
 * like a change back, each one warmed. A tileset left out is one okibi sees
 * no change for.
 */
export async function paintEpochs(
  env: Env,
  date: string,
  sources: PaintSources,
  recorded: Readonly<Record<string, Epoch>> = {},
): Promise<Record<string, Epoch>> {
  const epochs: Record<string, Epoch> = {};
  for (const style of await paintStyles(env)) {
    let sourceVersion: string;
    try {
      sourceVersion = await paintSourceVersion(style, await paintDocument(env, style), sources);
    } catch (e) {
      console.warn(`okibi: ${style.name} source version: ${String(e)}`);
      if (recorded[style.name]) epochs[style.name] = recorded[style.name];
      continue;
    }
    // The parameterless picture. A style's parameters are part of its key and
    // there are unboundedly many of them; what an invalidation moves is the
    // style, and every parameterisation of it moves with it.
    epochs[style.name] = {
      source: paintEpochSource(date, sourceVersion),
      algo: `paint-r${PAINT_RUNTIME_VERSION}`,
      param: style.rev,
    };
  }
  return epochs;
}
