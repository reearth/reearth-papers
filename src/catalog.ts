// Tileset catalog. A single JSON document that lists every tileset the
// service exposes, with links to each one's TileJSON / style.json so
// downstream tools can crawl the surface without hard-coding URLs.

import { THEMES } from "./style.js";
import { TILESETS } from "./tilesets.js";

interface ThemedRasterTileset {
  id: string;
  name: string;
  type: "raster";
  theme: string;
  tilejson: string;
  style: string;
}

interface RegisteredTileset {
  id: string;
  name: string;
  type: "raster" | "vector";
  tilejson: string;
  // Tiles served straight from an upstream provider (not by us) — set
  // so clients (e.g. the viewer) can distinguish it from what we host.
  passthrough?: true;
  // Direct range-readable URL of the underlying single-file archive
  // (COG / PMTiles), where one exists.
  source?: string;
  // Self-contained MapLibre style for vector tilesets that ship their
  // own cartography; the viewer renders these client-side.
  style?: string;
}

type Tileset = ThemedRasterTileset | RegisteredTileset;

export function handleCatalog(request: Request): Response {
  const origin = new URL(request.url).origin;

  const tilesets: Tileset[] = [
    // Themed OSM rasters: one tileset + MapLibre style per theme.
    ...THEMES.map(
      (theme): ThemedRasterTileset => ({
        id: `protomaps-${theme}`,
        name: `Protomaps Basemap (${theme})`,
        type: "raster",
        theme,
        tilejson: `${origin}/styles/${theme}/tilejson.json`,
        style: `${origin}/styles/${theme}/style.json`,
      }),
    ),
    // Everything else is derived from the registry in tilesets.ts.
    ...TILESETS.map(
      (def): RegisteredTileset => ({
        id: def.catalogId ?? def.id,
        name: def.catalogName ?? def.name,
        type: def.type,
        tilejson: `${origin}/${def.id}/tilejson.json`,
        ...(def.upstreamTiles ? { passthrough: true as const } : {}),
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
