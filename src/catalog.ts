// Tileset catalog. A single JSON document that lists every tileset the
// service exposes, with links to each one's TileJSON / style.json so
// downstream tools can crawl the surface without hard-coding URLs.

import { THEMES } from "./style.js";

interface RasterTileset {
  id: string;
  name: string;
  type: "raster";
  theme: string;
  tilejson: string;
  style: string;
}

interface VectorTileset {
  id: string;
  name: string;
  type: "vector";
  tilejson: string;
}

interface PassthroughRaster {
  id: string;
  name: string;
  type: "raster";
  tilejson: string;
}

type Tileset = RasterTileset | VectorTileset | PassthroughRaster;

export function handleCatalog(request: Request): Response {
  const origin = new URL(request.url).origin;

  const rasters: RasterTileset[] = THEMES.map((theme) => ({
    id: `protomaps-${theme}`,
    name: `Protomaps Basemap (${theme})`,
    type: "raster" as const,
    theme,
    tilejson: `${origin}/styles/${theme}/tilejson.json`,
    style: `${origin}/styles/${theme}/style.json`,
  }));

  const tilesets: Tileset[] = [
    ...rasters,
    {
      id: "protomaps-vector",
      name: "Protomaps Vector",
      type: "vector",
      tilejson: `${origin}/protomaps/tilejson.json`,
    },
    {
      id: "watercolor",
      name: "Stamen Watercolor",
      type: "raster",
      tilejson: `${origin}/watercolor/tilejson.json`,
    },
    {
      id: "esa-worldcover-2021",
      name: "ESA WorldCover 2021",
      type: "raster",
      tilejson: `${origin}/esa_worldcover_2021/tilejson.json`,
    },
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
