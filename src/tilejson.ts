// TileJSON 3.0.0 — https://github.com/mapbox/tilejson-spec/tree/master/3.0.0

import { ESA_WORLDCOVER_ATTRIBUTION } from "./esa_worldcover.js";
import type { Theme } from "./style.js";
import { WATERCOLOR_ATTRIBUTION } from "./watercolor.js";

const ATTRIBUTION = [
  '<a href="https://papers.reearth.land">Re:Earth Papers</a>',
  '<a href="https://protomaps.com">Protomaps</a>',
  '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors',
].join(" · ");

const BOUNDS = [-180, -85.0511, 180, 85.0511];
const CENTER = [0, 20, 2];

export function handleRasterTilejson(request: Request, theme: Theme): Response {
  const origin = new URL(request.url).origin;
  return json({
    tilejson: "3.0.0",
    name: `Re:Earth Papers — ${theme}`,
    description:
      "Beautiful raster tiles rendered from OpenStreetMap (Protomaps) " +
      "across a curated set of styles.",
    attribution: ATTRIBUTION,
    scheme: "xyz",
    tiles: [`${origin}/styles/${theme}/tile/{z}/{x}/{y}.png`],
    minzoom: 0,
    maxzoom: 15,
    bounds: BOUNDS,
    center: CENTER,
  });
}

export function handleWatercolorTilejson(request: Request): Response {
  const origin = new URL(request.url).origin;
  return json({
    tilejson: "3.0.0",
    name: "Re:Earth Papers — watercolor",
    description:
      "Stamen's Watercolor map tiles, snapshotted from the upstream " +
      "long-term cache. Frozen historical raster set.",
    attribution: WATERCOLOR_ATTRIBUTION,
    scheme: "xyz",
    tiles: [`${origin}/watercolor/{z}/{x}/{y}.jpg`],
    minzoom: 0,
    maxzoom: 18,
    bounds: BOUNDS,
    center: CENTER,
  });
}

export function handleEsaWorldcoverTilejson(request: Request): Response {
  const url = new URL(request.url);
  const fmt = url.searchParams.get("format") === "png" ? "png" : "webp";
  return json({
    tilejson: "3.0.0",
    name: "ESA WorldCover 2021",
    description:
      "ESA WorldCover 2021 v200 — 10 m global land-cover classification, " +
      "rendered on-the-fly from per-3° COGs mirrored to R2.",
    attribution: ESA_WORLDCOVER_ATTRIBUTION,
    scheme: "xyz",
    tiles: [`${url.origin}/esa_worldcover_2021/{z}/{x}/{y}.${fmt}`],
    // z<8 reads from a pre-baked global overview.tif (~1.78 km/px);
    // z≥8 reads from the per-3° native COGs. Clients overzoom from
    // z=13 to the configured display maxzoom.
    minzoom: 0,
    maxzoom: 13,
    bounds: [-180, -60, 180, 84],
    center: [0, 20, 2],
  });
}

export function handleVectorTilejson(request: Request): Response {
  const origin = new URL(request.url).origin;
  return json({
    tilejson: "3.0.0",
    name: "Re:Earth Papers — vector",
    description: "Protomaps daily basemap, mirrored to R2.",
    attribution: ATTRIBUTION,
    scheme: "xyz",
    tiles: [`${origin}/v/{z}/{x}/{y}.mvt`],
    minzoom: 0,
    maxzoom: 15,
    bounds: BOUNDS,
    center: CENTER,
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
