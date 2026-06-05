// TileJSON 3.0.0 — https://github.com/mapbox/tilejson-spec/tree/master/3.0.0

import type { Theme } from "./style.js";
import {
  PROTOMAPS_ATTRIBUTION,
  type TileFormat,
  type TilesetDef,
} from "./tilesets.js";

const BOUNDS = [-180, -85.0511, 180, 85.0511];
const CENTER = [0, 20, 2];

// Themed OSM rasters — outside the tileset registry (see tilesets.ts).
export function handleRasterTilejson(request: Request, theme: Theme): Response {
  const origin = new URL(request.url).origin;
  return json({
    tilejson: "3.0.0",
    name: `Re:Earth Papers — ${theme}`,
    description:
      "Beautiful raster tiles rendered from OpenStreetMap (Protomaps) " +
      "across a curated set of styles.",
    attribution: PROTOMAPS_ATTRIBUTION,
    scheme: "xyz",
    tiles: [`${origin}/styles/${theme}/tile/{z}/{x}/{y}.png`],
    minzoom: 0,
    maxzoom: 15,
    bounds: BOUNDS,
    center: CENTER,
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
