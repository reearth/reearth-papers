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
// Cost note: we store nothing in R2. Each tile is one or more Range GETs
// to S3 us-west-2; the pmtiles library caches the archive's header +
// directory per isolate. Cloudflare does not cache a Worker's own
// responses, so the cache-control below reaches browsers and nothing
// at the edge: every request for a full tile reads S3 again. Lite tiles
// (handleOvertureLiteTile) are the exception, kept in the Cache API.
//
// Registry-driven, mirroring naturalearth_vector.ts: the central
// registry (src/tilesets.ts) maps over OVERTURE_TILESETS. The MVT layer
// ids + zoom ranges below were read from the live archives' metadata —
// keep them in sync when bumping OVERTURE_RELEASE.

import type { PMTiles } from "pmtiles";

import { openArchive, WorkerFetchSource } from "./archive.js";
import { attributionOf, headerSafeHtml } from "./credits.js";
import { LITE_RULES, LITE_VERSION, liteTile } from "./mvt_lite.js";
import { vectorTileResponse } from "./mvt_response.js";
import type { TilesetDef } from "./tilesets.js";

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
  /** Also serve `<id>_lite`: the same tiles through `liteTile`. */
  lite?: true;
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
    lite: true,
    layers: [
      { id: "land", description: "Land polygons", geometry: "polygon", minzoom: 0 },
      { id: "land_cover", description: "Land cover polygons", geometry: "polygon", minzoom: 0 },
      {
        id: "land_use",
        description:
          "Land use polygons. Below z13 most features carry no `class` or `subtype` (release 2026-11-18.0)",
        geometry: "polygon",
        minzoom: 6,
      },
      { id: "water", description: "Water polygons and waterways", geometry: "polygon", minzoom: 0 },
      {
        id: "bathymetry",
        description:
          "Bathymetry depth polygons. Features carry no properties at z0-4; `depth` starts at z5 (release 2026-11-18.0)",
        geometry: "polygon",
        minzoom: 0,
      },
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
    pm = openArchive(new WorkerFetchSource(archiveUrl(release, theme)));
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
  let xml: string;
  try {
    const res = await fetch(`${S3_BUCKET}/?list-type=2&delimiter=/&prefix=tiles%2F`);
    if (!res.ok) return null;
    xml = await res.text();
  } catch {
    return null;
  }
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

export const overtureArchive = async (theme: string): Promise<PMTiles> =>
  (await resolveArchive(theme)).archive;

type Coords = { z: number; x: number; y: number };

/** What reading one tile from the current archive found. A failed read
 *  has already been logged, and carries the 503 to answer. */
type OvertureRead =
  | { kind: "tile"; data: ArrayBuffer; release: string }
  | { kind: "empty" }
  | { kind: "out-of-range" }
  | { kind: "failed"; response: Response };

async function readOvertureTile(theme: string, match: Coords): Promise<OvertureRead> {
  // Everything below reads the remote archive, and the library throws
  // plain Errors for bad upstream data, so where a throw happens is what
  // says it was a read failure. Uncaught, it would be a 1101 with no
  // CORS header, which a browser reports as a CORS error.
  let served: { archive: PMTiles; release: string };
  try {
    served = await resolveArchive(theme);
  } catch (e) {
    const release = resolved?.release ?? OVERTURE_RELEASE;
    return { kind: "failed", response: readFailed("header", theme, release, match, e) };
  }
  const { archive, release } = served;
  try {
    const header = await archive.getHeader();
    if (match.z < header.minZoom || match.z > header.maxZoom) return { kind: "out-of-range" };
    const tile = await archive.getZxy(match.z, match.x, match.y);
    return tile ? { kind: "tile", data: tile.data, release } : { kind: "empty" };
  } catch (e) {
    return { kind: "failed", response: readFailed("tile", theme, release, match, e) };
  }
}

/** The answer for every read that found no tile. */
function noTile(read: Exclude<OvertureRead, { kind: "tile" }>): Response {
  switch (read.kind) {
    case "out-of-range":
      return new Response("zoom out of range", { status: 404 });
    case "empty":
      // 204 (not 404) for an absent tile: MapLibre's vector source treats
      // it as a successful empty tile, correct for sparse coverage. Same
      // rationale as pmtiles.ts / naturalearth_vector.ts.
      return new Response(null, { status: 204 });
    case "failed":
      return read.response;
  }
}

// The route path doesn't change when the release does, so these tiles
// can't be immutable: a moderate TTL with SWR is what lets a new release
// reach clients within the day.
const CLIENT_CACHE_CONTROL = "public, max-age=3600, stale-while-revalidate=86400";

export async function handleOvertureTile(theme: string, match: Coords): Promise<Response> {
  const read = await readOvertureTile(theme, match);
  if (read.kind !== "tile") return noTile(read);
  return vectorTileResponse(read.data, {
    "cache-control": CLIENT_CACHE_CONTROL,
    // Which release actually served this tile. Nothing pins it, so
    // this is the only way to see from outside what the routes are
    // currently reading.
    "x-overture-release": read.release,
    "x-attribution": headerSafeHtml(OVERTURE_ATTRIBUTION),
  });
}

// A lite tile is a pure function of the filter version, the release and
// the coordinates. That identity is its ETag and its Cache API key, and
// the reason a stored copy can outlive the client's one hour.
const liteEtag = (release: string) => `W/"lite${LITE_VERSION}-${release}"`;

const liteCacheKey = (origin: string, release: string, theme: string, c: Coords) =>
  new Request(`${origin}/__lite/${LITE_VERSION}/${release}/${theme}/${c.z}/${c.x}/${c.y}.mvt`);

const STORED_CACHE_CONTROL = "public, max-age=2592000";

/** If-None-Match holds `etag`, compared weakly (RFC 9110 §13.1.2): the
 *  edge may hand the client a weakened copy of a strong tag. */
function etagMatches(header: string | null, etag: string): boolean {
  if (!header) return false;
  const opaque = (t: string) => t.trim().replace(/^W\//, "");
  return header.split(",").some((t) => opaque(t) === opaque(etag));
}

/** `<theme>_lite`: the tile without the attributes `liteTile` drops,
 *  kept in this data center's Cache API under its release. */
export async function handleOvertureLiteTile(
  request: Request,
  ctx: ExecutionContext,
  theme: string,
  match: Coords,
): Promise<Response> {
  const headers = (release: string) => ({
    "cache-control": CLIENT_CACHE_CONTROL,
    "x-overture-release": release,
    "x-attribution": headerSafeHtml(OVERTURE_ATTRIBUTION),
    etag: liteEtag(release),
  });

  // No I/O on a warm isolate. The guess names the cache entry to look
  // for; what gets stored is keyed on the release the read used.
  const guess = await currentRelease();
  if (etagMatches(request.headers.get("if-none-match"), liteEtag(guess))) {
    return new Response(null, { status: 304, headers: { ...headers(guess), vary: "accept-encoding" } });
  }
  const origin = new URL(request.url).origin;
  const hit = await caches.default.match(liteCacheKey(origin, guess, theme, match));
  if (hit?.body) return vectorTileResponse(hit.body, { ...headers(guess), "x-cache": "edge-hit" });

  const read = await readOvertureTile(theme, match);
  if (read.kind !== "tile") return noTile(read);
  let lite: Uint8Array<ArrayBuffer>;
  try {
    lite = liteTile(new Uint8Array(read.data));
  } catch (e) {
    // Never the unfiltered bytes: a client of this id may rely on their
    // being smaller, and a cache would keep them.
    console.error(
      JSON.stringify({ evt: "overture.lite_failed", theme, release: read.release, ...match, error: String(e) }),
    );
    return new Response("overture tile could not be filtered", {
      status: 502,
      headers: { "cache-control": "no-store" },
    });
  }

  // Stored without Vary, so whether `match` honours Vary cannot decide
  // hit or miss. The edge compresses each response it hands a client,
  // whichever path built it.
  const stored = new Response(lite, {
    headers: {
      ...headers(read.release),
      "cache-control": STORED_CACHE_CONTROL,
      "content-type": "application/x-protobuf",
    },
  });
  ctx.waitUntil(
    caches.default.put(liteCacheKey(origin, read.release, theme, match), stored).catch((e: unknown) => {
      console.warn(`overture lite: cache put failed (${String(e)})`);
    }),
  );
  return vectorTileResponse(lite, { ...headers(read.release), "x-cache": "miss" });
}

type LiteFields = Pick<TilesetDef, "id" | "catalogId" | "name" | "catalogName" | "description"> &
  Required<Pick<TilesetDef, "handleTile" | "tileFilter">>;

/** What `<id>_lite` changes in the registry entry of `d`; the rest is
 *  `d`'s own entry. */
export function overtureLiteFields(d: OvertureTileset): LiteFields {
  const dropped = [...LITE_RULES.dropKeys].map((k) => `\`${k}\``).join(", ");
  return {
    id: `${d.id}_lite`,
    catalogId: `${d.catalogId}-lite`,
    name: `${d.name} (lite)`,
    catalogName: `${d.catalogName} Lite`,
    description:
      `${d.description} Lite: the same tiles without the ${dropped} properties, ` +
      "and without `bathymetry` where none of its features has a property " +
      "(z0–4 in release 2026-11-18.0). For drawing; read the full tileset for provenance.",
    handleTile: (request, _env, ctx, coords) => handleOvertureLiteTile(request, ctx, d.theme, coords),
    tileFilter: LITE_RULES,
  };
}

/** One line per failed tile request, for Workers Logs. `stage` is
 *  "header" when no readable archive was found and "tile" when the
 *  archive opened but the tile read failed. */
interface ReadFailedLog {
  evt: "overture.read_failed";
  stage: "header" | "tile";
  theme: string;
  release: string;
  z: number;
  x: number;
  y: number;
  error: string;
}

function readFailed(
  stage: ReadFailedLog["stage"],
  theme: string,
  release: string,
  match: { z: number; x: number; y: number },
  e: unknown,
): Response {
  const line: ReadFailedLog = {
    evt: "overture.read_failed",
    stage,
    theme,
    release,
    z: match.z,
    x: match.x,
    y: match.y,
    error: String(e),
  };
  console.error(JSON.stringify(line));
  return new Response("overture archive read failed", {
    status: 503,
    headers: { "retry-after": "1", "cache-control": "no-store" },
  });
}
