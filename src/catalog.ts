// Tileset catalog. A single JSON document that lists every tileset the
// service exposes, with links to each one's TileJSON / style.json so
// downstream tools can crawl the surface without hard-coding URLs.

import { NATURAL_EARTH_RASTERS } from "./naturalearth.js";
import { PASSTHROUGH_TILESETS } from "./passthrough.js";
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

// A self-hosted raster without a per-theme MapLibre style (watercolor,
// ESA WorldCover, Black Marble): we serve/render the tiles, but there's
// no style.json to toggle into vector mode.
interface HostedRaster {
  id: string;
  name: string;
  type: "raster";
  tilejson: string;
}

// A raster whose tiles are served straight from an upstream provider
// (not by us). Same shape as HostedRaster plus a `passthrough` flag so
// clients (e.g. the viewer) can distinguish it from what we host.
interface PassthroughRaster extends HostedRaster {
  passthrough: true;
}

type Tileset = RasterTileset | VectorTileset | HostedRaster | PassthroughRaster;

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
    {
      id: "blackmarble-2016",
      name: "NASA Black Marble 2016",
      type: "raster",
      tilejson: `${origin}/blackmarble/tilejson.json`,
    },
    // Natural Earth rasters — derived from the registry in
    // src/naturalearth.ts.
    ...NATURAL_EARTH_RASTERS.map(
      (d): HostedRaster => ({
        id: d.id,
        name: d.name,
        type: "raster",
        tilejson: `${origin}/${d.id}/tilejson.json`,
      }),
    ),
    // Passthrough tilesets (TileJSON points at the upstream provider).
    // Derived from the registry in src/passthrough.ts.
    ...PASSTHROUGH_TILESETS.map(
      (t): PassthroughRaster => ({
        id: t.id,
        name: t.name,
        type: "raster",
        tilejson: `${origin}/${t.id}/tilejson.json`,
        passthrough: true,
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
