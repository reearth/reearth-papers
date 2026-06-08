// Vector tile endpoints backed by the Natural Earth vector PMTiles
// archives in R2.
//
// Natural Earth's vector data is broad, so rather than one giant
// archive we split it into a handful of themed tilesets (physical,
// admin, labels, land use, transport, bathymetry) — each a single
// immutable PMTiles object built once by `mirror/naturalearth_vector/`
// (tippecanoe + tile-join across the 110m/50m/10m scales). Splitting by
// theme keeps any individual MVT tile small: a basemap client pulling
// `naturalearth_physical` never also pays for road or bathymetry
// geometry it isn't drawing.
//
// Everything here is registry-driven from `NE_VECTOR_TILESETS`; the
// central tileset registry (src/tilesets.ts) maps over it. The MVT
// layer ids below are the contract with three places that must agree:
// the tippecanoe build (`scripts/_lib.sh`'s LAYERS table), the TileJSON
// `vector_layers` we advertise, and the generated MapLibre style.

import { PMTiles, type RangeResponse, type Source } from "pmtiles";

// Public domain — no attribution required; we credit Natural Earth
// anyway, matching the raster side (src/naturalearth.ts).
export const NE_VECTOR_ATTRIBUTION =
  '<a href="https://papers.reearth.land">Re:Earth Papers</a> · ' +
  'Made with <a href="https://www.naturalearthdata.com">Natural Earth</a> · ' +
  "public domain";

// Cartographic role of a layer — drives both draw order and paint in
// the generated style (see styleLayersFor below).
export type LayerKind =
  | "ocean"
  | "bathymetry"
  | "land"
  | "region_area"
  | "ice"
  | "wetland"
  | "island"
  | "water"
  | "reef"
  | "urban"
  | "park_area"
  | "country"
  | "state"
  | "county"
  | "river"
  | "coast"
  | "geo_line"
  | "timezone"
  | "park_line"
  | "road"
  | "rail"
  | "boundary"
  | "boundary_maritime"
  | "boundary_disputed"
  | "pacific"
  | "transport_point"
  | "place"
  | "label_point";

export interface VectorLayer {
  /** MVT source-layer id (matches the build's out_layer). */
  id: string;
  description: string;
  kind: LayerKind;
  /** Coarsest zoom this layer carries data at (the lowest tier it's
   *  fed from). The tileset's `maxzoom` caps the top. */
  minzoom: number;
}

export interface NeVectorTileset {
  /** Route id: `/<id>/{z}/{x}/{y}.mvt`. */
  id: string;
  /** Public catalog id. */
  catalogId: string;
  name: string;
  catalogName: string;
  description: string;
  /** R2 object key of the PMTiles archive. */
  archiveKey: string;
  minzoom: number;
  maxzoom: number;
  layers: readonly VectorLayer[];
}

const KEY = (name: string) => `mirror/naturalearth_vector/${name}.pmtiles`;

export const NE_VECTOR_TILESETS: readonly NeVectorTileset[] = [
  {
    id: "naturalearth_physical",
    catalogId: "naturalearth-physical",
    name: "Natural Earth — physical",
    catalogName: "Natural Earth Physical",
    description:
      "Natural Earth physical vector layers — coastline, land/ocean, " +
      "lakes, rivers, glaciers, ice shelves, reefs, islands and named " +
      "physical regions — multi-scale (110m → z0–2, 50m → z3–4, 10m → " +
      "z5–8) in one PMTiles archive.",
    archiveKey: KEY("physical"),
    minzoom: 0,
    maxzoom: 8,
    layers: [
      { id: "ocean", description: "Ocean polygons", kind: "ocean", minzoom: 0 },
      { id: "land", description: "Land polygons", kind: "land", minzoom: 0 },
      { id: "coastline", description: "Coastlines", kind: "coast", minzoom: 0 },
      { id: "lakes", description: "Lakes (incl. regional supplements)", kind: "water", minzoom: 0 },
      {
        id: "rivers",
        description: "Rivers and lake centerlines (incl. regional supplements)",
        kind: "river",
        minzoom: 0,
      },
      { id: "glaciated_areas", description: "Glaciated areas", kind: "ice", minzoom: 0 },
      {
        id: "antarctic_ice_shelves",
        description: "Antarctic ice shelf polygons",
        kind: "ice",
        minzoom: 3,
      },
      { id: "reefs", description: "Reefs", kind: "reef", minzoom: 5 },
      { id: "playas", description: "Playas", kind: "wetland", minzoom: 3 },
      { id: "minor_islands", description: "Minor islands", kind: "island", minzoom: 5 },
      {
        id: "geographic_lines",
        description: "Geographic lines (equator, tropics, polar circles)",
        kind: "geo_line",
        minzoom: 0,
      },
      {
        id: "marine_polys",
        description: "Marine region polygons (seas, gulfs, bays)",
        kind: "region_area",
        minzoom: 0,
      },
      {
        id: "regions_polys",
        description: "Physical region polygons (deserts, ranges, plains)",
        kind: "region_area",
        minzoom: 0,
      },
    ],
  },
  {
    id: "naturalearth_admin",
    catalogId: "naturalearth-admin",
    name: "Natural Earth — admin",
    catalogName: "Natural Earth Admin",
    description:
      "Natural Earth administrative vector layers — countries, map " +
      "units/subunits, sovereignty, state/province and US county polygons, " +
      "plus land, maritime and disputed boundary lines — multi-scale " +
      "(110m → z0–2, 50m → z3–4, 10m → z5–8).",
    archiveKey: KEY("admin"),
    minzoom: 0,
    maxzoom: 8,
    layers: [
      { id: "countries", description: "Admin-0 country polygons", kind: "country", minzoom: 0 },
      { id: "map_units", description: "Admin-0 map unit polygons", kind: "country", minzoom: 0 },
      {
        id: "map_subunits",
        description: "Admin-0 map subunit polygons",
        kind: "country",
        minzoom: 3,
      },
      {
        id: "sovereignty",
        description: "Admin-0 sovereignty polygons",
        kind: "country",
        minzoom: 0,
      },
      {
        id: "states_provinces",
        description: "Admin-1 state / province polygons",
        kind: "state",
        minzoom: 0,
      },
      { id: "counties", description: "Admin-2 US county polygons", kind: "county", minzoom: 5 },
      {
        id: "boundary_lines",
        description: "Admin-0 land boundary lines",
        kind: "boundary",
        minzoom: 0,
      },
      {
        id: "states_lines",
        description: "Admin-1 state / province boundary lines",
        kind: "boundary",
        minzoom: 0,
      },
      {
        id: "boundary_maritime",
        description: "Admin-0 maritime indicator lines",
        kind: "boundary_maritime",
        minzoom: 3,
      },
      {
        id: "boundary_disputed",
        description: "Admin-0 disputed-area boundary lines",
        kind: "boundary_disputed",
        minzoom: 3,
      },
      {
        id: "pacific_groupings",
        description: "Pacific grouping lines",
        kind: "pacific",
        minzoom: 0,
      },
    ],
  },
  {
    id: "naturalearth_labels",
    catalogId: "naturalearth-labels",
    name: "Natural Earth — labels",
    catalogName: "Natural Earth Labels",
    description:
      "Natural Earth label points — populated places plus admin-0/1 and " +
      "physical-region label points (with elevation points) — for " +
      "client-side labelling. Multi-scale (110m → z0–2, 50m → z3–4, 10m " +
      "→ z5–8).",
    archiveKey: KEY("labels"),
    minzoom: 0,
    maxzoom: 8,
    layers: [
      { id: "places", description: "Populated places", kind: "place", minzoom: 0 },
      {
        id: "admin_0_labels",
        description: "Admin-0 (country) label points",
        kind: "label_point",
        minzoom: 5,
      },
      {
        id: "admin_1_labels",
        description: "Admin-1 (state/province) label points",
        kind: "label_point",
        minzoom: 5,
      },
      {
        id: "region_points",
        description: "Physical region label points",
        kind: "label_point",
        minzoom: 0,
      },
      {
        id: "region_elevation_points",
        description: "Elevation label points (peaks, depressions)",
        kind: "label_point",
        minzoom: 0,
      },
    ],
  },
  {
    id: "naturalearth_landuse",
    catalogId: "naturalearth-landuse",
    name: "Natural Earth — land use",
    catalogName: "Natural Earth Land Use",
    description:
      "Natural Earth land-use vector layers — urban areas plus parks and " +
      "protected lands (areas, lines, points). 50m → z3–4, 10m → z5–8.",
    archiveKey: KEY("landuse"),
    minzoom: 3,
    maxzoom: 8,
    layers: [
      { id: "urban_areas", description: "Urban area polygons", kind: "urban", minzoom: 3 },
      {
        id: "parks_area",
        description: "Parks and protected land polygons",
        kind: "park_area",
        minzoom: 5,
      },
      {
        id: "parks_line",
        description: "Parks and protected land lines",
        kind: "park_line",
        minzoom: 5,
      },
      {
        id: "parks_point",
        description: "Parks and protected land points",
        kind: "label_point",
        minzoom: 5,
      },
    ],
  },
  {
    id: "naturalearth_transport",
    catalogId: "naturalearth-transport",
    name: "Natural Earth — transport",
    catalogName: "Natural Earth Transport",
    description:
      "Natural Earth transport vector layers — roads (incl. North " +
      "America), railroads (incl. North America), airports, ports and " +
      "time zones. 10m only, z4–10.",
    archiveKey: KEY("transport"),
    minzoom: 4,
    maxzoom: 10,
    layers: [
      { id: "roads", description: "Roads", kind: "road", minzoom: 4 },
      { id: "roads_north_america", description: "Roads (North America)", kind: "road", minzoom: 4 },
      { id: "railroads", description: "Railroads", kind: "rail", minzoom: 4 },
      {
        id: "railroads_north_america",
        description: "Railroads (North America)",
        kind: "rail",
        minzoom: 4,
      },
      { id: "airports", description: "Airports", kind: "transport_point", minzoom: 4 },
      { id: "ports", description: "Ports", kind: "transport_point", minzoom: 4 },
      { id: "time_zones", description: "Time zone boundaries", kind: "timezone", minzoom: 4 },
    ],
  },
  {
    id: "naturalearth_bathymetry",
    catalogId: "naturalearth-bathymetry",
    name: "Natural Earth — bathymetry",
    catalogName: "Natural Earth Bathymetry",
    description:
      "Natural Earth ocean-bottom bathymetry — depth-band polygons (the " +
      "1:10m bathymetry series) merged into one layer carrying a `depth` " +
      "attribute (metres). z0–6.",
    archiveKey: KEY("bathymetry"),
    minzoom: 0,
    maxzoom: 6,
    layers: [
      {
        id: "bathymetry",
        description: "Bathymetry depth-band polygons (depth in metres)",
        kind: "bathymetry",
        minzoom: 0,
      },
    ],
  },
];

export const NE_VECTOR_TILESETS_BY_KEY: ReadonlyMap<string, NeVectorTileset> = new Map(
  NE_VECTOR_TILESETS.map((t) => [t.id, t]),
);

// -- serving ---------------------------------------------------------------

// One PMTiles wrapper per archive key, kept at module scope so the
// pmtiles library's internal header/directory cache survives between
// requests on the same isolate.
const archiveCache = new Map<string, PMTiles>();

class R2PmtilesSource implements Source {
  readonly #bucket: R2Bucket;
  readonly #key: string;

  constructor(bucket: R2Bucket, key: string) {
    this.#bucket = bucket;
    this.#key = key;
  }

  getKey(): string {
    return `r2://${this.#key}`;
  }

  async getBytes(offset: number, length: number): Promise<RangeResponse> {
    const obj = await this.#bucket.get(this.#key, { range: { offset, length } });
    if (!obj) {
      throw new Error(`natural earth vector archive not found in R2: ${this.#key}`);
    }
    return { data: await obj.arrayBuffer(), etag: obj.httpEtag };
  }
}

function getArchive(env: Env, key: string): PMTiles {
  let pm = archiveCache.get(key);
  if (!pm) {
    pm = new PMTiles(new R2PmtilesSource(env.R2, key));
    archiveCache.set(key, pm);
  }
  return pm;
}

export async function handleNeVectorTile(
  archiveKey: string,
  match: { z: number; x: number; y: number },
  env: Env,
): Promise<Response> {
  const archive = getArchive(env, archiveKey);
  const header = await archive.getHeader();

  if (match.z < header.minZoom || match.z > header.maxZoom) {
    return new Response("zoom out of range", { status: 404 });
  }

  const tile = await archive.getZxy(match.z, match.x, match.y);
  // 204 (not 404) for an absent tile: MapLibre's vector source treats it
  // as a successful empty tile, correct for sparse coverage. Same
  // rationale as pmtiles.ts.
  if (!tile) return new Response(null, { status: 204 });

  // `getZxy` returns already-decompressed bytes; send raw with no
  // Content-Encoding — see the note in pmtiles.ts.
  return new Response(tile.data, {
    headers: {
      "content-type": "application/vnd.mapbox-vector-tile",
      // Immutable, theme-keyed archive; cache hard at the edge.
      "cache-control": "public, max-age=31536000, immutable",
      "x-attribution": NE_VECTOR_ATTRIBUTION,
    },
  });
}

// -- generated style -------------------------------------------------------

// Glyphs borrowed from Protomaps' public asset CDN (same as the themed
// styles in style.ts) — Natural Earth ships no fonts of its own.
const GLYPHS = "https://protomaps.github.io/basemaps-assets/fonts/{fontstack}/{range}.pbf";

// Palette (paper-ish, matching the viewer chrome).
const C = {
  paper: "#f7f4ee",
  ocean: "#a9cfe0",
  land: "#efe9dd",
  ice: "#f4f7f9",
  reef: "#bfe0d8",
  wetland: "#e7e2cf",
  urban: "#e3dccb",
  park: "#cfe0bf",
  boundary: "#9b8e76",
  maritime: "#9fc0d0",
  disputed: "#c0594a",
  road: "#d6a878",
  rail: "#9a937f",
  river: "#a9cfe0",
  coast: "#7fa9bd",
  ink: "#3a342a",
  inkSoft: "#6b6452",
};

const zlerp = (z0: number, w0: number, z1: number, w1: number) =>
  ["interpolate", ["linear"], ["zoom"], z0, w0, z1, w1];

// Returns the MapLibre style layers for one MVT layer, tagged with a
// draw-order `rank` so the caller can sort fills under lines under
// labels regardless of declaration order.
function styleLayersFor(
  layer: VectorLayer,
  source: string,
): { rank: number; spec: Record<string, unknown> }[] {
  const sl = layer.id;
  const base = { source, "source-layer": sl };
  const fill = (rank: number, color: string, opacity = 1, id = sl) => [
    { rank, spec: { id, type: "fill", ...base, paint: { "fill-color": color, "fill-opacity": opacity } } },
  ];
  const line = (rank: number, paint: Record<string, unknown>, id = sl) => [
    { rank, spec: { id, type: "line", ...base, paint } },
  ];
  const outline = (rank: number, color: string) =>
    line(rank, { "line-color": color, "line-width": 0.5, "line-opacity": 0.5 }, `${sl}_outline`);
  const symbol = (
    rank: number,
    textSize: unknown,
    color: string,
    extra: Record<string, unknown> = {},
  ) => [
    {
      rank,
      spec: {
        id: sl,
        type: "symbol",
        ...base,
        layout: {
          "text-field": ["coalesce", ["get", "NAME_EN"], ["get", "NAME"], ["get", "name"]],
          "text-font": ["Noto Sans Regular"],
          "text-size": textSize,
          "text-max-width": 7,
          ...extra,
        },
        paint: { "text-color": color, "text-halo-color": C.paper, "text-halo-width": 1.2 },
      },
    },
  ];

  switch (layer.kind) {
    case "ocean":
      return fill(10, C.ocean);
    case "bathymetry":
      // Graduated by depth (metres, larger = deeper = darker).
      return fill(11, [
        "interpolate",
        ["linear"],
        ["to-number", ["get", "depth"], 0],
        0, "#cfe6f0",
        200, "#bcdcec",
        1000, "#9fcbe2",
        3000, "#7fb6d6",
        6000, "#5b9cc6",
        10000, "#3f86b8",
      ] as unknown as string);
    case "land":
      return fill(20, C.land);
    case "region_area":
      return []; // label source only — no fill, avoids overdraw
    case "ice":
      return fill(22, C.ice);
    case "wetland":
      return fill(23, C.wetland, 0.7);
    case "island":
      return fill(24, C.land);
    case "water":
      return fill(30, C.ocean);
    case "reef":
      return fill(31, C.reef, 0.6);
    case "urban":
      return fill(35, C.urban);
    case "park_area":
      return fill(36, C.park, 0.6);
    case "country":
    case "state":
    case "county":
      return outline(layer.kind === "country" ? 40 : 41, C.boundary);
    case "river":
      return line(50, { "line-color": C.river, "line-width": zlerp(3, 0.4, 10, 1.4) });
    case "coast":
      return line(51, { "line-color": C.coast, "line-width": zlerp(0, 0.4, 10, 1.0) });
    case "geo_line":
      return line(52, { "line-color": C.inkSoft, "line-dasharray": [3, 3], "line-width": 0.5, "line-opacity": 0.5 });
    case "timezone":
      return line(52, { "line-color": C.inkSoft, "line-dasharray": [2, 4], "line-width": 0.4, "line-opacity": 0.4 });
    case "park_line":
      return line(53, { "line-color": "#7fa86a", "line-width": 0.6 });
    case "road":
      return line(55, { "line-color": C.road, "line-width": zlerp(5, 0.4, 10, 2.0) });
    case "rail":
      return line(56, { "line-color": C.rail, "line-dasharray": [3, 2], "line-width": zlerp(6, 0.4, 10, 1.0) });
    case "boundary":
      return line(60, { "line-color": C.boundary, "line-width": zlerp(0, 0.5, 10, 1.4) });
    case "boundary_maritime":
      return line(61, { "line-color": C.maritime, "line-dasharray": [4, 3], "line-width": 0.6 });
    case "boundary_disputed":
      return line(62, { "line-color": C.disputed, "line-dasharray": [2, 2], "line-width": 0.8 });
    case "pacific":
      return line(63, { "line-color": C.boundary, "line-dasharray": [1, 2], "line-width": 0.5, "line-opacity": 0.6 });
    case "transport_point":
      return [
        {
          rank: 70,
          spec: {
            id: sl,
            type: "circle",
            ...base,
            paint: {
              "circle-radius": 2.5,
              "circle-color": C.ink,
              "circle-stroke-color": C.paper,
              "circle-stroke-width": 1,
            },
          },
        },
      ];
    case "place":
      return symbol(80, zlerp(2, 10, 10, 15), C.ink);
    case "label_point":
      return symbol(81, zlerp(2, 9, 10, 13), C.inkSoft);
    default:
      return [];
  }
}

// Self-contained MapLibre style for one NE vector tileset. Surfaced via
// the catalog `style` field so the viewer renders it client-side.
export function naturalEarthVectorStyle(
  tileset: NeVectorTileset,
  origin: string,
): Record<string, unknown> {
  const SOURCE = "ne";
  const hasOcean = tileset.layers.some((l) => l.kind === "ocean" || l.kind === "bathymetry");
  const built = tileset.layers
    .flatMap((l) => styleLayersFor(l, SOURCE))
    .sort((a, b) => a.rank - b.rank)
    .map((x) => x.spec);

  const layers: Record<string, unknown>[] = [
    {
      id: "background",
      type: "background",
      paint: { "background-color": hasOcean ? C.ocean : C.paper },
    },
    ...built,
  ];

  return {
    version: 8,
    name: tileset.name,
    glyphs: GLYPHS,
    sources: {
      [SOURCE]: {
        type: "vector",
        tiles: [`${origin}/${tileset.id}/{z}/{x}/{y}.mvt`],
        minzoom: tileset.minzoom,
        maxzoom: tileset.maxzoom,
        attribution: NE_VECTOR_ATTRIBUTION,
      },
    },
    layers,
  };
}
