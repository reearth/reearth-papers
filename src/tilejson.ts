// TileJSON 3.0.0 — https://github.com/mapbox/tilejson-spec/tree/master/3.0.0

import { type Theme, themeName } from "./style.js";
import {
  PROTOMAPS_ATTRIBUTION,
  type TileFormat,
  type TilesetDef,
} from "./tilesets.js";

const BOUNDS = [-180, -85.0511, 180, 85.0511];
const CENTER = [0, 20, 2];

// Max zoom advertised for (and served by) the rendered raster route.
// The Protomaps vector source only carries data through z15, but the
// container's maplibre-native overzooms that vector internally, so it
// renders crisp raster past z15 — no bitmap upscaling. We advertise a
// bounded max (rather than the source's z15) so clients keep requesting
// freshly-rendered deep tiles instead of stretching the z15 PNG, while
// still capping the 4×-per-level render cost somewhere sane.
export const RENDERED_RASTER_MAXZOOM = 22;

// Themed OSM rasters — outside the tileset registry (see tilesets.ts).
export function handleRasterTilejson(request: Request, theme: Theme): Response {
  const origin = new URL(request.url).origin;
  return json({
    tilejson: "3.0.0",
    name: `Re:Earth Papers — ${themeName(theme)}`,
    description:
      "Beautiful raster tiles rendered from OpenStreetMap (Protomaps) " +
      "across a curated set of styles.",
    attribution: PROTOMAPS_ATTRIBUTION,
    scheme: "xyz",
    tiles: [`${origin}/styles/${theme}/tile/{z}/{x}/{y}.png`],
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
