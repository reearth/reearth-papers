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

import { attributionOf } from "./credits.js";
import { FetchSource, PMTiles } from "pmtiles";

import { headerSafeHtml } from "./render_cache.js";

// Overture ships monthly releases and the version is part of the S3
// path, but nothing here pins one. Overture holds a rolling window of
// releases in that bucket — usually two — and deletes what falls out of
// it, so a pinned version is a dated bomb: `2026-06-17.0` was simply
// gone one day, and every tile on these five routes became a 500.
//
// So the release is *resolved* instead — `currentRelease` below lists
// the bucket and takes the newest, cached per isolate. The route path
// (/overture_*/{z}/{x}/{y}.mvt) doesn't change when the release does,
// and tiles go out with a one-hour TTL, so a new release reaches clients
// within the day on its own.
//
// This constant is what's left of the pin: the release the layer ids and
// zoom ranges below were read from, and the release we fall back to if
// the bucket can't be listed. Refresh it with
// `node scripts/overture-release.mjs --bump`, which also rewrites those
// zoom numbers from the new archives' metadata — they do move (Overture
// dropped `building`'s minzoom from 6 to 4 in `2026-08-19.0`).
export const OVERTURE_RELEASE = "2026-08-19.0";

const S3_BUCKET = "https://overturemaps-extras-us-west-2.s3.us-west-2.amazonaws.com";
const S3_BASE = `${S3_BUCKET}/tiles`;

const archiveUrl = (release: string, theme: string) =>
  `${S3_BASE}/${release}/${theme}.pmtiles`;

// Overture data licensing differs per theme (e.g. transportation and
// divisions are ODbL/OSM-derived, places is CDLA Permissive 2.0). We
// surface a single shared credit covering the foundation and the OSM
// contributors behind the OSM-derived themes.
export const OVERTURE_ATTRIBUTION = attributionOf("overture");

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
      { id: "building", description: "Building footprint polygons", geometry: "polygon", minzoom: 4 },
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

// One PMTiles wrapper per release+theme, kept at module scope so the
// pmtiles library's header/directory cache survives between requests on
// the same isolate (cuts the cold-tile S3 round-trips to just the tile
// read).
const archiveCache = new Map<string, PMTiles>();

function getArchive(release: string, theme: string): PMTiles {
  const key = `${release}/${theme}`;
  let pm = archiveCache.get(key);
  if (!pm) {
    pm = new PMTiles(new FetchSource(archiveUrl(release, theme)));
    archiveCache.set(key, pm);
  }
  return pm;
}

/** How long a resolved release is trusted before the bucket is listed
 *  again. Overture publishes monthly, so this only has to be short
 *  enough that a new release is picked up promptly — and long enough
 *  that the listing is nowhere near the per-tile path. */
const RELEASE_TTL_MS = 60 * 60 * 1000;

/** The newest release this isolate has seen, and when it saw it. A
 *  resolved value, not a promise: a promise another request settles is
 *  not something a workerd request can await. Two requests racing here
 *  both list and both write the same answer, which is fine. */
let resolved: { release: string; at: number } | null = null;

/** Newest release still in the bucket, or null if it can't be listed.
 *
 *  Names are `YYYY-MM-DD.N`; compare the date and the number separately
 *  rather than betting that N never reaches double digits. */
async function newestRelease(): Promise<string | null> {
  const res = await fetch(`${S3_BUCKET}/?list-type=2&delimiter=/&prefix=tiles%2F`);
  if (!res.ok) return null;
  const xml = await res.text();
  const names = [...xml.matchAll(/<Prefix>tiles\/([^<\/]+)\/<\/Prefix>/g)].map((m) => m[1]);
  let best: string | null = null;
  for (const name of names) {
    if (best === null || compareReleases(name, best) > 0) best = name;
  }
  return best;
}

function compareReleases(a: string, b: string): number {
  const [da, na] = a.split(".");
  const [db, nb] = b.split(".");
  if (da !== db) return da < db ? -1 : 1;
  return Number(na ?? 0) - Number(nb ?? 0);
}

/** The release to serve from. A failed listing keeps the last answer if
 *  we have one, and `OVERTURE_RELEASE` if we don't — both beat failing
 *  the tile over a listing that will probably work next time. */
async function currentRelease(): Promise<string> {
  if (resolved && Date.now() - resolved.at < RELEASE_TTL_MS) return resolved.release;
  const newest = await newestRelease();
  if (!newest) return resolved?.release ?? OVERTURE_RELEASE;
  if (resolved && resolved.release !== newest) {
    console.log(`overture: release ${resolved.release} → ${newest}`);
  }
  resolved = { release: newest, at: Date.now() };
  return newest;
}

/** The archive to serve `theme` from, and the release it came from.
 *
 *  The header read lives here rather than in the caller because it is
 *  what catches a release that went away underneath us: one that has
 *  rolled out of the bucket answers the directory range request with a
 *  404, which the pmtiles library raises. That can only happen on a
 *  cached answer old enough to have expired upstream but not here, so
 *  re-listing once is the whole recovery. */
async function resolveArchive(theme: string): Promise<{ archive: PMTiles; release: string }> {
  const release = await currentRelease();
  const archive = getArchive(release, theme);
  try {
    await archive.getHeader();
    return { archive, release };
  } catch (e) {
    const fresh = await newestRelease();
    if (!fresh || fresh === release) throw e;
    resolved = { release: fresh, at: Date.now() };
    const alt = getArchive(fresh, theme);
    await alt.getHeader(); // if this fails too, the failure is real
    console.warn(`overture: ${release} unreadable (${String(e)}); serving ${fresh}`);
    return { archive: alt, release: fresh };
  }
}

export async function handleOvertureTile(
  theme: string,
  match: { z: number; x: number; y: number },
): Promise<Response> {
  const { archive, release } = await resolveArchive(theme);
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
      // The route path doesn't change when the release does, so these
      // tiles can't be immutable: a moderate TTL with SWR is what lets a
      // new release reach clients within the day.
      "cache-control": "public, max-age=3600, stale-while-revalidate=86400",
      // Which release actually served this tile. Nothing pins it, so
      // this is the only way to see from outside what the routes are
      // currently reading.
      "x-overture-release": release,
      "x-attribution": headerSafeHtml(OVERTURE_ATTRIBUTION),
    },
  });
}
