// Tileset catalog. A single JSON document that lists every tileset the
// service exposes, with links to each one's TileJSON / style.json so
// downstream tools can crawl the surface without hard-coding URLs.

import { paintStyles } from "./paint_styles.js";
import { THEMES, themeCatalogId, themeName } from "./style.js";
import { TILESETS } from "./tilesets.js";

/** Which shelf a tileset sits on. `type` says what a client has to do
 *  with the bytes; `category` says what the thing *is*, which is what a
 *  gallery wants to group by — three of these are `type: "raster"` and
 *  they have nothing else in common:
 *
 *  - `basemap` — rendered here from vector tiles and a cartography
 *    (MapLibre-derived): the papers house styles and the stock
 *    Protomaps themes.
 *  - `paint` — rendered here from an ezu paint style; a picture rather
 *    than a legible basemap, and no MapLibre style exists for it.
 *  - `imagery` — data or satellite rasters we mirror, proxy or pass
 *    through (WorldCover, Black Marble, Natural Earth, Watercolor, …).
 *  - `vector` — MVT for the client to style itself.
 *
 *  Consumers should treat an unknown value as "some other shelf" rather
 *  than an error: this list grows. */
export type Category = "basemap" | "paint" | "imagery" | "vector";

interface ThemedRasterTileset {
  id: string;
  name: string;
  type: "raster";
  category: Category;
  theme: string;
  tilejson: string;
  style: string;
}

interface RegisteredTileset {
  id: string;
  name: string;
  type: "raster" | "vector";
  category: Category;
  tilejson: string;
  // Tiles served straight from an upstream provider (not by us) — set
  // so clients (e.g. the viewer) can distinguish it from what we host.
  passthrough?: true;
  // Tiles served by us, but range-read from a remote archive on demand
  // rather than mirrored to R2 (e.g. Overture). Between hosted and
  // passthrough: the browser talks only to us, but we store nothing.
  proxy?: true;
  // Direct range-readable URL of the underlying single-file archive
  // (COG / PMTiles), where one exists.
  source?: string;
  // Self-contained MapLibre style for vector tilesets that ship their
  // own cartography; the viewer renders these client-side.
  style?: string;
}

/** A paint style (see paint_styles.ts). No `style` link: an ezu document
 *  has no MapLibre equivalent to link to. `params` points at its JSON
 *  Schema instead, which is what a client needs to offer the knobs the
 *  tile URL accepts. */
interface PaintTileset {
  id: string;
  name: string;
  type: "raster";
  category: Category;
  tilejson: string;
  params: string;
}

type Tileset = ThemedRasterTileset | RegisteredTileset | PaintTileset;

export async function handleCatalog(request: Request, env: Env): Promise<Response> {
  const origin = new URL(request.url).origin;

  // Read from R2, so publishing a style to the shelf adds it here
  // without deploying this worker. A read that fails leaves the shelf
  // empty rather than the catalog broken (see `paintStyles`).
  const paint = await paintStyles(env);

  const tilesets: Tileset[] = [
    // Themed OSM rasters: one tileset + MapLibre style per theme. The
    // house styles (Papers Light / Papers Dark) lead the list — see
    // THEMES in style.ts.
    ...THEMES.map(
      (theme): ThemedRasterTileset => ({
        id: themeCatalogId(theme),
        name: themeName(theme),
        type: "raster",
        category: "basemap",
        theme,
        tilejson: `${origin}/styles/${theme}/tilejson.json`,
        style: `${origin}/styles/${theme}/style.json`,
      }),
    ),
    // The paint shelf, in manifest order.
    ...paint.map(
      (p): PaintTileset => ({
        id: p.name,
        name: p.title,
        type: "raster",
        category: "paint",
        tilejson: `${origin}/styles/${p.name}/tilejson.json`,
        params: `${origin}/styles/${p.name}/params.json`,
      }),
    ),
    // Everything else is derived from the registry in tilesets.ts.
    ...TILESETS.map(
      (def): RegisteredTileset => ({
        id: def.catalogId ?? def.id,
        name: def.catalogName ?? def.name,
        type: def.type,
        category: def.category ?? (def.type === "vector" ? "vector" : "imagery"),
        tilejson: `${origin}/${def.id}/tilejson.json`,
        ...(def.upstreamTiles ? { passthrough: true as const } : {}),
        ...(def.proxy ? { proxy: true as const } : {}),
        ...(def.source ? { source: `${origin}/${def.id}.${def.source.ext}` } : {}),
        ...(def.styleJson ? { style: `${origin}/${def.id}/style.json` } : {}),
      }),
    ),
  ];

  return new Response(
    JSON.stringify({
      name: "Re:Earth Papers",
      description:
        "Catalog of available tilesets. Each entry links to a TileJSON " +
        "3.0.0 document (and a MapLibre style for the rendered raster " +
        "themes).",
      tilesets,
    }),
    {
      headers: {
        "content-type": "application/json",
        "cache-control": "public, max-age=300",
        "access-control-allow-origin": "*",
      },
    },
  );
}
