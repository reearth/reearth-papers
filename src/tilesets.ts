// Central registry of every built-in (non-themed) tileset.
//
// This file is the single place where built-in data is configured.
// Everything else is derived from it automatically:
//   - the tile route      /<id>/{z}/{x}/{y}.<ext>   (see index.ts)
//   - the TileJSON route  /<id>/tilejson.json       (see tilejson.ts)
//   - the catalog.json entry                        (see catalog.ts)
//
// Two kinds of entries:
//   - self-hosted: `handleTile` serves/renders bytes (R2-backed COGs,
//     PMTiles archives). `formats` lists the served extensions; the
//     first is the TileJSON default (override with ?format=). For the
//     COG-rendered tilesets, the `persist` literal passed to the
//     handler decides whether rendered tiles are stored in R2 as a
//     global cache layer (expensive renders) or served from the edge
//     cache alone (cheap renders) — see src/render_cache.ts.
//   - passthrough: `upstreamTiles` points the TileJSON straight at an
//     upstream provider — we serve no bytes and store nothing in R2;
//     attribution, baked into the TileJSON, is all we own. The
//     upstream MUST send `access-control-allow-origin: *` so browser
//     clients can fetch its tiles cross-origin. Verify before adding
//     (e.g. `curl -sI <tile-url> | grep -i access-control`).
//
// The themed OSM rasters (/styles/{theme}/…) stay outside this
// registry — they're style permutations of one source with their own
// route shape and a per-theme style.json (see style.ts).

import { BLACKMARBLE_ATTRIBUTION, handleBlackmarbleTile } from "./blackmarble.js";
import { ESA_WORLDCOVER_ATTRIBUTION, handleEsaWorldcoverTile } from "./esa_worldcover.js";
import {
  handleNaturalEarthTile,
  NATURAL_EARTH_ATTRIBUTION,
  NATURAL_EARTH_RASTERS,
} from "./naturalearth.js";
import { handleVectorTile } from "./pmtiles.js";
import { handleWatercolorTile, WATERCOLOR_ATTRIBUTION } from "./watercolor.js";

export type TileFormat = "png" | "webp" | "jpg" | "mvt";

export interface TileCoords {
  z: number;
  x: number;
  y: number;
}

export interface TilesetDef {
  /** Route segment: `/<id>/{z}/{x}/{y}.<ext>` + `/<id>/tilejson.json`. */
  id: string;
  /** Public catalog id (stable across route renames); defaults to `id`. */
  catalogId?: string;
  /** TileJSON display name. */
  name: string;
  /** Catalog display name; defaults to `name`. */
  catalogName?: string;
  description: string;
  attribution: string;
  type: "raster" | "vector";
  /** Served extensions; the first is the TileJSON default. Unused for
   *  passthrough entries. */
  formats?: readonly TileFormat[];
  minzoom: number;
  /** Native max zoom; clients overzoom past this. */
  maxzoom: number;
  /** Defaults to the full Web Mercator extent / world center. */
  bounds?: readonly [number, number, number, number];
  center?: readonly [number, number, number];
  /** Passthrough: upstream XYZ tile URL template(s) with {z}/{x}/{y}
   *  placeholders. Mutually exclusive with `handleTile`. */
  upstreamTiles?: readonly string[];
  /** Self-hosted: serve one tile. Mutually exclusive with `upstreamTiles`. */
  handleTile?: (
    request: Request,
    env: Env,
    ctx: ExecutionContext,
    coords: TileCoords,
    fmt: TileFormat,
  ) => Promise<Response>;
}

const PAPERS = '<a href="https://papers.reearth.land">Re:Earth Papers</a>';

// Shared by the themed rasters (tilejson.ts) and the protomaps vector
// entry below — both surface the same OSM-derived data.
export const PROTOMAPS_ATTRIBUTION = [
  PAPERS,
  '<a href="https://protomaps.com">Protomaps</a>',
  '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors',
].join(" · ");

export const TILESETS: readonly TilesetDef[] = [
  {
    id: "protomaps",
    catalogId: "protomaps-vector",
    name: "Re:Earth Papers — vector",
    catalogName: "Protomaps Vector",
    description: "Protomaps daily basemap, mirrored to R2.",
    attribution: PROTOMAPS_ATTRIBUTION,
    type: "vector",
    formats: ["mvt"],
    minzoom: 0,
    maxzoom: 15,
    handleTile: (_request, env, _ctx, coords) => handleVectorTile(coords, env),
  },
  {
    id: "watercolor",
    name: "Re:Earth Papers — watercolor",
    catalogName: "Stamen Watercolor",
    description:
      "Stamen's Watercolor map tiles, snapshotted from the upstream " +
      "long-term cache. Frozen historical raster set.",
    attribution: WATERCOLOR_ATTRIBUTION,
    type: "raster",
    formats: ["jpg"],
    minzoom: 0,
    maxzoom: 18,
    handleTile: (_request, env, _ctx, coords) => handleWatercolorTile(coords, env),
  },
  {
    id: "esa_worldcover_2021",
    catalogId: "esa-worldcover-2021",
    name: "ESA WorldCover 2021",
    description:
      "ESA WorldCover 2021 v200 — 10 m global land-cover classification, " +
      "rendered on-the-fly from per-3° COGs mirrored to R2.",
    attribution: ESA_WORLDCOVER_ATTRIBUTION,
    type: "raster",
    formats: ["webp", "png"],
    // z<8 reads from a pre-baked global overview.tif (~1.78 km/px);
    // z≥8 reads from the per-3° native COGs.
    minzoom: 0,
    maxzoom: 13,
    bounds: [-180, -60, 180, 84],
    // persist: true — z≥8 fans out over per-3° COGs (multiple R2 reads
    // + lossless encode per tile), expensive enough to keep the global
    // R2 cache layer.
    handleTile: (request, env, ctx, coords, fmt) =>
      handleEsaWorldcoverTile(request, env, ctx, coords, fmt as "png" | "webp", true),
  },
  {
    id: "blackmarble",
    catalogId: "blackmarble-2016",
    name: "Black Marble 2016",
    catalogName: "NASA Black Marble 2016",
    description:
      "NASA Earth Observatory's \"Earth at Night 2016\" (Suomi NPP VIIRS), " +
      "rendered on-the-fly from a global 500 m / pixel COG mirrored to R2.",
    attribution: BLACKMARBLE_ATTRIBUTION,
    type: "raster",
    formats: ["webp", "png"],
    minzoom: 0,
    maxzoom: 8,
    // persist: false — one window read from a single COG + encode is
    // fast enough that the edge cache alone suffices.
    handleTile: (request, env, ctx, coords, fmt) =>
      handleBlackmarbleTile(request, env, ctx, coords, fmt as "png" | "webp", false),
  },
  // Natural Earth rasters — geometry + display metadata live in the
  // registry in naturalearth.ts; one TilesetDef per entry.
  ...NATURAL_EARTH_RASTERS.map(
    (d): TilesetDef => ({
      id: d.id,
      name: d.name,
      description: d.description,
      attribution: NATURAL_EARTH_ATTRIBUTION,
      type: "raster",
      formats: ["webp", "png"],
      minzoom: 0,
      maxzoom: d.maxZoom,
      // persist: false — small single-COG window reads; edge cache only.
      handleTile: (request, env, ctx, coords, fmt) =>
        handleNaturalEarthTile(request, env, ctx, d, coords, fmt as "png" | "webp", false),
    }),
  ),
  // Passthrough tilesets.
  {
    // NASA GIBS — BlueMarble: Next Generation, a global cloud-free
    // true-colour mosaic served as a static layer. EPSG:3857 /
    // GoogleMapsCompatible_Level8, JPEG, native max zoom 8.
    id: "bluemarble",
    name: "NASA Blue Marble",
    description:
      "NASA GIBS \"BlueMarble: Next Generation\" — a global cloud-free " +
      "true-colour mosaic, served directly from NASA's GIBS WMTS.",
    attribution: [
      PAPERS,
      'Imagery courtesy of <a href="https://earthdata.nasa.gov/gibs">NASA EOSDIS GIBS</a>',
      "Blue Marble: Next Generation (public domain)",
    ].join(" · "),
    type: "raster",
    minzoom: 0,
    maxzoom: 8,
    upstreamTiles: [
      "https://gibs.earthdata.nasa.gov/wmts/epsg3857/best/BlueMarble_NextGeneration/default/GoogleMapsCompatible_Level8/{z}/{y}/{x}.jpeg",
    ],
  },
  {
    // EOX Sentinel-2 cloudless 2016 — the one EOX year released under
    // CC BY 4.0 (commercial use OK with attribution); 2017+ are NC-SA.
    // EPSG:3857 / GoogleMapsCompatible, JPEG, ~10 m native (tops out
    // around web-mercator z14).
    id: "s2cloudless_2016",
    name: "Sentinel-2 cloudless 2016",
    description:
      "EOX Sentinel-2 cloudless 2016 — a global cloud-free 10 m mosaic " +
      "of Copernicus Sentinel-2 data, served directly from EOX's WMTS. " +
      "The 2016 layer is CC BY 4.0 (later years are non-commercial).",
    attribution: [
      PAPERS,
      '<a href="https://s2maps.eu">Sentinel-2 cloudless 2016</a> by EOX IT Services GmbH',
      "Contains modified Copernicus Sentinel data 2016 &amp; 2017 · CC BY 4.0",
    ].join(" · "),
    type: "raster",
    minzoom: 0,
    maxzoom: 14,
    upstreamTiles: [
      "https://tiles.maps.eox.at/wmts/1.0.0/s2cloudless_3857/default/GoogleMapsCompatible/{z}/{y}/{x}.jpg",
    ],
  },
];

export const TILESETS_BY_ID: ReadonlyMap<string, TilesetDef> = new Map(
  TILESETS.map((t) => [t.id, t]),
);
