// TileJSON 3.0.0 — https://github.com/mapbox/tilejson-spec/tree/master/3.0.0

import {
  PAINT_FORMATS,
  type PaintStyle,
  readParams,
} from "./paint_styles.js";
import { type Theme, themeName } from "./style.js";
import {
  PROTOMAPS_ATTRIBUTION,
  type TileFormat,
  type TilesetDef,
} from "./tilesets.js";

const BOUNDS = [-180, -85.0511, 180, 85.0511];
const CENTER = [0, 20, 2];

// Max zoom advertised for (and served by) the rendered raster route.
// The Protomaps vector source only carries data through z15, but ezu
// reprojects that z15 ancestor into deeper frames (`sourceZoom`), so the
// route renders crisp raster past z15 — no bitmap upscaling. We advertise
// a bounded max (rather than the source's z15) so clients keep requesting
// freshly-rendered deep tiles instead of stretching the z15 image, while
// still capping the 4x-per-level render cost somewhere sane.
export const RENDERED_RASTER_MAXZOOM = 22;

/** Encodings the themed raster route serves, best first. WebP costs the
 *  same to encode as an uncompressed render where PNG's deflate adds
 *  30-48ms per tile, is 13-20% smaller on the wire, and decodes quicker,
 *  so it is what clients get unless they ask otherwise. */
const RASTER_FORMATS = ["webp", "png"] as const;

// Themed OSM rasters — outside the tileset registry (see tilesets.ts).
// `?format=` picks the encoding, matching the registered tilesets.
export function handleRasterTilejson(request: Request, theme: Theme): Response {
  const url = new URL(request.url);
  const origin = url.origin;
  const q = url.searchParams.get("format");
  const fmt = (RASTER_FORMATS as readonly string[]).includes(q ?? "")
    ? q
    : RASTER_FORMATS[0];
  return json({
    tilejson: "3.0.0",
    name: `Re:Earth Papers — ${themeName(theme)}`,
    description:
      "Beautiful raster tiles rendered from OpenStreetMap (Protomaps) " +
      "across a curated set of styles.",
    attribution: PROTOMAPS_ATTRIBUTION,
    scheme: "xyz",
    tiles: [`${origin}/styles/${theme}/tile/{z}/{x}/{y}.${fmt}`],
    minzoom: 0,
    maxzoom: RENDERED_RASTER_MAXZOOM,
    bounds: BOUNDS,
    center: CENTER,
    // Not part of TileJSON 3.0, but MapLibre GL picks `tileSize` off a
    // raster source's TileJSON when the source doesn't set one
    // explicitly (an explicit source option wins — load_tilejson.ts).
    // Each z tile is rendered over a 512-logical-px viewport at camera
    // zoom z, so these are true 512px tiles — consumed as 256 they'd
    // show every label at half size.
    tileSize: 512,
  });
}

// Paint styles (see paint_styles.ts). Same route shape as the themed
// rasters, with two differences that come from what these are: the max
// zoom is the style's own (a style reading terrain stops where that
// source does), and any params the request carried ride into the
// `tiles` template — so a client that copies this URL keeps the picture
// it was looking at, knobs and all, rather than reverting to defaults.
export function handlePaintTilejson(request: Request, style: PaintStyle): Response {
  const url = new URL(request.url);
  const q = url.searchParams.get("format");
  const fmt = (PAINT_FORMATS as readonly string[]).includes(q ?? "")
    ? q
    : PAINT_FORMATS[0];
  const params = readParams(style, url.searchParams);
  const query = typeof params === "string" || !params.canonical
    ? ""
    : `?${params.canonical}`;
  return json({
    tilejson: "3.0.0",
    name: `Re:Earth Papers — ${style.title}`,
    description: style.description,
    attribution: style.attribution,
    scheme: "xyz",
    tiles: [`${url.origin}/styles/${style.name}/tile/{z}/{x}/{y}.${fmt}${query}`],
    minzoom: 0,
    maxzoom: style.maxzoom,
    bounds: BOUNDS,
    center: CENTER,
    // Same non-standard field the themed rasters carry, and for the same
    // reason: MapLibre reads `tileSize` off a raster source's TileJSON,
    // and these are rendered at the document's own canvas size.
    tileSize: style.tileSize,
  });
}

// Every registered tileset (see tilesets.ts). Self-hosted entries
// advertise our own tile route in the requested format (?format=,
// default = the entry's first format); passthrough entries advertise
// the upstream's URLs directly.
export function handleTilesetTilejson(request: Request, def: TilesetDef): Response {
  const url = new URL(request.url);
  let tiles: readonly string[];
  if (def.upstreamTiles) {
    tiles = def.upstreamTiles;
  } else {
    const formats = def.formats ?? [];
    let fmt: TileFormat | undefined = formats[0];
    const q = url.searchParams.get("format");
    if (q && (formats as readonly string[]).includes(q)) fmt = q as TileFormat;
    tiles = [`${url.origin}/${def.id}/{z}/{x}/{y}.${fmt}`];
  }
  return json({
    tilejson: "3.0.0",
    name: def.name,
    description: def.description,
    attribution: def.attribution,
    scheme: "xyz",
    tiles,
    // maxzoom is the source's native cap; clients overzoom past it to
    // their configured display maxzoom.
    minzoom: def.minzoom,
    maxzoom: def.maxzoom,
    bounds: def.bounds ?? BOUNDS,
    center: def.center ?? CENTER,
    // Data rasters are all 256px (TILE_SIZE in cog.ts; the passthrough
    // sources too). MapLibre's raster-source default is 512, so leave
    // clients no room to guess wrong. Same non-standard field the
    // themed TileJSON carries.
    ...(def.type === "raster" ? { tileSize: 256 } : {}),
    // Required by TileJSON 3.0 for vector tilesets; lets clients
    // enumerate the MVT layers without parsing a tile first.
    ...(def.vectorLayers
      ? {
          vector_layers: def.vectorLayers.map((l) => ({
            id: l.id,
            description: l.description,
            minzoom: l.minzoom,
            maxzoom: def.maxzoom,
            // Non-standard hint consumed by the viewer's inspector.
            geometry: l.geometry,
            fields: {},
          })),
        }
      : {}),
  });
}

function json(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    headers: {
      "content-type": "application/json",
      "cache-control": "public, max-age=300",
      "access-control-allow-origin": "*",
    },
  });
}
