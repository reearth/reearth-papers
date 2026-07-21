// Vector tile endpoints backed by Overture Maps' official PMTiles
// archives — read straight from S3 over HTTP Range, no R2 mirror.
//
// Overture publishes no XYZ tile server: the only ready-to-serve tiles
// it ships are per-theme PMTiles archives in the public
// `overturemaps-extras-us-west-2` bucket (the GeoParquet release is the
// real product; these tiles are a convenience). So we can't register
// Overture as a plain passthrough (`upstreamTiles` needs a {z}/{x}/{y}
// upstream). Instead the worker acts as the origin: it range-reads the
// remote PMTiles directory + tile bytes with the pmtiles library's
// `FetchSource` and re-serves them at /<id>/{z}/{x}/{y}.mvt. The browser
// only ever talks to us (same origin), so S3 needs no CORS — only HTTP
// Range, which it has.
//
// Cost note: we store nothing. Each cold tile is one or more Range GETs
// to S3 us-west-2; the pmtiles library caches the archive's header +
// directory per isolate, and the edge cache (cache-control below)
// absorbs repeat hits. There's no R2 storage or egress on our side.
//
// Registry-driven, mirroring naturalearth_vector.ts: the central
// registry (src/tilesets.ts) maps over OVERTURE_TILESETS. The MVT layer
// ids + zoom ranges below were read from the live archives' metadata —
// keep them in sync when bumping OVERTURE_RELEASE.

import { FetchSource, PMTiles } from "pmtiles";

// Overture ships monthly releases; the version is part of the S3 path.
// Bump this (and re-check layer ids / zoom ranges) when adopting a newer
// release. The route path (/overture_*/{z}/{x}/{y}.mvt) is stable across
// bumps, so the edge cache rolls over within the tile TTL below.
export const OVERTURE_RELEASE = "2026-06-17.0";

const S3_BASE =
  "https://overturemaps-extras-us-west-2.s3.us-west-2.amazonaws.com/tiles";

const archiveUrl = (theme: string) => `${S3_BASE}/${OVERTURE_RELEASE}/${theme}.pmtiles`;

// Overture data licensing differs per theme (e.g. transportation and
// divisions are ODbL/OSM-derived, places is CDLA Permissive 2.0). We
// surface a single shared credit covering the foundation and the OSM
// contributors behind the OSM-derived themes.
export const OVERTURE_ATTRIBUTION = [
  '<a href="https://papers.reearth.land">Re:Earth Papers</a>',
  '<a href="https://overturemaps.org">Overture Maps Foundation</a>',
  '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors',
].join(" · ");

/** One MVT layer of an Overture theme archive. `geometry` is the
 *  viewer-inspector hint (fill / line / circle). A few Overture layers
 *  carry mixed geometries; the hint picks the dominant one. */
export interface OvertureLayer {
  id: string;
  description: string;
  geometry: "polygon" | "line" | "point";
  /** Coarsest zoom this layer carries data at (from archive metadata). */
  minzoom: number;
}

export interface OvertureTileset {
  /** Route id: `/<id>/{z}/{x}/{y}.mvt`. */
  id: string;
  /** Public catalog id. */
  catalogId: string;
  name: string;
  catalogName: string;
  description: string;
  /** S3 archive basename (`<theme>.pmtiles`). */
  theme: string;
  minzoom: number;
  /** Native max zoom (the archive's header maxZoom); clients overzoom. */
  maxzoom: number;
  layers: readonly OvertureLayer[];
}

// Layer ids, zoom ranges and theme zoom caps were read from the live
// 2026-06-17.0 archives' PMTiles metadata. The `addresses` theme (z14
// only, hundreds of millions of points) is intentionally omitted.
export const OVERTURE_TILESETS: readonly OvertureTileset[] = [
  {
    id: "overture_base",
    catalogId: "overture-base",
    name: "Overture — base",
    catalogName: "Overture Base",
    description:
      "Overture Maps base theme — land, land cover, land use, water, " +
      "bathymetry and infrastructure polygons/lines, served from " +
      "Overture's official PMTiles. z0–13.",
    theme: "base",
    minzoom: 0,
    maxzoom: 13,
    layers: [
      { id: "land", description: "Land polygons", geometry: "polygon", minzoom: 0 },
      { id: "land_cover", description: "Land cover polygons", geometry: "polygon", minzoom: 0 },
      { id: "land_use", description: "Land use polygons", geometry: "polygon", minzoom: 6 },
      { id: "water", description: "Water polygons and waterways", geometry: "polygon", minzoom: 0 },
      { id: "bathymetry", description: "Bathymetry depth polygons", geometry: "polygon", minzoom: 0 },
      {
        id: "infrastructure",
        description: "Infrastructure (mixed point/line/polygon)",
        geometry: "point",
        minzoom: 13,
      },
    ],
  },
  {
    id: "overture_buildings",
    catalogId: "overture-buildings",
    name: "Overture — buildings",
    catalogName: "Overture Buildings",
    description:
      "Overture Maps buildings theme — building footprints and 3D " +
      "building parts, served from Overture's official PMTiles. z6–14.",
    theme: "buildings",
    minzoom: 0,
    maxzoom: 14,
    layers: [
      { id: "building", description: "Building footprint polygons", geometry: "polygon", minzoom: 6 },
      {
        id: "building_part",
        description: "Building part polygons (3D detail)",
        geometry: "polygon",
        minzoom: 8,
      },
    ],
  },
  {
    id: "overture_places",
    catalogId: "overture-places",
    name: "Overture — places",
    catalogName: "Overture Places",
    description:
      "Overture Maps places theme — points of interest (businesses, " +
      "landmarks, amenities), served from Overture's official PMTiles. " +
      "z14 only.",
    theme: "places",
    minzoom: 0,
    maxzoom: 14,
    layers: [{ id: "place", description: "Place points (POIs)", geometry: "point", minzoom: 14 }],
  },
  {
    id: "overture_transportation",
    catalogId: "overture-transportation",
    name: "Overture — transportation",
    catalogName: "Overture Transportation",
    description:
      "Overture Maps transportation theme — road/rail/path segments and " +
      "their connectors, served from Overture's official PMTiles. z4–14.",
    theme: "transportation",
    minzoom: 0,
    maxzoom: 14,
    layers: [
      { id: "segment", description: "Transportation segments (roads, rail, paths)", geometry: "line", minzoom: 4 },
      { id: "connector", description: "Segment connectors", geometry: "point", minzoom: 13 },
    ],
  },
  {
    id: "overture_divisions",
    catalogId: "overture-divisions",
    name: "Overture — divisions",
    catalogName: "Overture Divisions",
    description:
      "Overture Maps divisions theme — administrative division points, " +
      "area polygons and boundary lines, served from Overture's official " +
      "PMTiles. z0–12.",
    theme: "divisions",
    minzoom: 0,
    maxzoom: 12,
    layers: [
      { id: "division", description: "Division label points", geometry: "point", minzoom: 0 },
      { id: "division_area", description: "Division area polygons", geometry: "polygon", minzoom: 0 },
      {
        id: "division_boundary",
        description: "Division boundary lines",
        geometry: "line",
        minzoom: 0,
      },
    ],
  },
];

export const OVERTURE_TILESETS_BY_ID: ReadonlyMap<string, OvertureTileset> = new Map(
  OVERTURE_TILESETS.map((t) => [t.id, t]),
);

// -- serving ---------------------------------------------------------------

// One PMTiles wrapper per theme, kept at module scope so the pmtiles
// library's header/directory cache survives between requests on the same
// isolate (cuts the cold-tile S3 round-trips to just the tile read).
const archiveCache = new Map<string, PMTiles>();

function getArchive(theme: string): PMTiles {
  let pm = archiveCache.get(theme);
  if (!pm) {
    pm = new PMTiles(new FetchSource(archiveUrl(theme)));
    archiveCache.set(theme, pm);
  }
  return pm;
}

export async function handleOvertureTile(
  theme: string,
  match: { z: number; x: number; y: number },
): Promise<Response> {
  const archive = getArchive(theme);
  const header = await archive.getHeader();

  if (match.z < header.minZoom || match.z > header.maxZoom) {
    return new Response("zoom out of range", { status: 404 });
  }

  const tile = await archive.getZxy(match.z, match.x, match.y);
  // 204 (not 404) for an absent tile: MapLibre's vector source treats it
  // as a successful empty tile, correct for sparse coverage. Same
  // rationale as pmtiles.ts / naturalearth_vector.ts.
  if (!tile) return new Response(null, { status: 204 });

  // The archives are gzip-compressed, but `getZxy` returns
  // already-decompressed bytes (it consults the header's tileCompression
  // internally). Send raw with no Content-Encoding — see pmtiles.ts.
  return new Response(tile.data, {
    headers: {
      "content-type": "application/vnd.mapbox-vector-tile",
      // Pinned to a dated release, but the route path is stable across
      // release bumps, so use a moderate TTL with SWR (not immutable) so
      // a bumped OVERTURE_RELEASE reaches clients within a day.
      "cache-control": "public, max-age=3600, stale-while-revalidate=86400",
      "x-attribution": OVERTURE_ATTRIBUTION,
    },
  });
}
