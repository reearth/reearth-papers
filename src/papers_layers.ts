// "Papers Light" / "Papers Dark" — the house basemap cartography.
//
// Ported from the GSI-vector styles that PLATEAU VIEW ships
// (eukarya-inc/plateau-view `server/tiles/{light,dark}Style.json`) and
// re-targeted at the Protomaps basemap schema so it works worldwide
// instead of only over Japan.
//
// What carries over from the original:
//   - the exact greyscale palettes (10 greys light / 9 dark),
//   - no labels, no buildings, no landuse — it's a backdrop meant to sit
//     under 3D city models and data overlays, not a general-purpose map,
//   - roads drawn casing-then-fill at a *ground-constant* width past
//     z10 (they widen with zoom like real carriageways) and at a
//     screen-constant width below it,
//   - railways as a dark line with tie ticks at mid zoom, turning into
//     the classic light-filled "ladder" once the ground width is wide
//     enough to read.
//
// What had to be reinterpreted, because the schemas don't line up:
//   - GSI stacks features by `vt_lvorder` 0..4 (five identical layer
//     groups). Protomaps encodes the same idea as `is_tunnel` /
//     `is_bridge` flags, so the five groups collapse to three passes.
//   - GSI carries a real carriageway width per feature (`vt_width` /
//     `vt_rnkwidth`). Protomaps has no width attribute, so widths are
//     derived from `kind`, keeping the original's unit scale (the value
//     is the line width in px at z23, halving per zoom level down).
//   - There is no coastline layer upstream; the water polygon's
//     `fill-outline-color` stands in for GSI's `Cstline`.
//
// Shared verbatim by the public style (src/style.ts) and the one the
// renderer container fetches (mirror/protomaps/src/style.ts) — the two
// workers deploy separately, and cartography this long drifts the
// moment it's copied.

export type PapersTheme = "papers-light" | "papers-dark";

interface Palette {
  /** Below z4 and above z8; the mid band uses `backgroundMid`. */
  background: string;
  backgroundMid: string;
  earth: string;
  water: string;
  /** Land/water edge — GSI's `Cstline`. */
  coastline: string;
  /** River + stream centrelines. */
  waterline: string;
  boundary: string;
  /** Casing under motorway-class roads. */
  motorwayCasing: string;
  motorway: string;
  /** Casing under everything else. */
  roadCasing: string;
  road: string;
  /** Railway line at low zoom, and its casing at high zoom. */
  railway: string;
  /** Railway infill once the ladder rendering kicks in. */
  railwayFill: string;
}

const PALETTES: Record<PapersTheme, Palette> = {
  "papers-light": {
    background: "rgb(255, 255, 255)",
    backgroundMid: "rgb(191, 191, 191)",
    earth: "rgb(255, 255, 255)",
    water: "rgb(191, 191, 191)",
    coastline: "rgb(179, 179, 179)",
    waterline: "rgb(172, 172, 172)",
    boundary: "rgb(84, 84, 84)",
    motorwayCasing: "rgb(153, 153, 153)",
    motorway: "rgb(168, 168, 168)",
    roadCasing: "rgb(217, 217, 217)",
    road: "rgb(230, 230, 230)",
    railway: "rgb(153, 153, 153)",
    railwayFill: "rgb(235, 235, 235)",
  },
  "papers-dark": {
    background: "rgb(38, 38, 38)",
    backgroundMid: "rgb(0, 0, 0)",
    earth: "rgb(38, 38, 38)",
    water: "rgb(0, 0, 0)",
    coastline: "rgb(51, 51, 51)",
    waterline: "rgb(13, 13, 13)",
    boundary: "rgb(168, 168, 168)",
    motorwayCasing: "rgb(115, 115, 115)",
    motorway: "rgb(102, 102, 102)",
    roadCasing: "rgb(77, 77, 77)",
    road: "rgb(64, 64, 64)",
    railway: "rgb(102, 102, 102)",
    railwayFill: "rgb(38, 38, 38)",
  },
};

// Loosely typed so this module stays dependency-free; both callers
// serialise the result straight to JSON.
type Expr = unknown;
type Layer = Record<string, unknown>;

/** Zoom at which the ground-constant rendering takes over from the
 *  screen-constant overview rendering.
 *
 *  GSI splits at z11 and so did we, until measuring the tiles: Protomaps
 *  only starts emitting `is_tunnel` / `is_bridge` at z12 (checked over
 *  Tokyo Bay — z8–z11 carry neither attribute at all). Below z12 an
 *  undersea tunnel is therefore indistinguishable from a surface road,
 *  and the surface pass — which draws above the water fill — would paint
 *  it across the sea. So the detail rendering starts where the flags do,
 *  and everything below it goes through the overview layers under the
 *  water fill. */
const DETAIL_MINZOOM = 12;
/** Below this, railways are a single hairline rather than a ladder. */
const RAIL_LADDER_MINZOOM = 15;

/** The `roads` source layer also carries `rail`, `ferry` and `aeroway`
 *  features. Only these five are roads — the rest get their own
 *  treatment or none at all, and matching on "not rail" would draw
 *  ferry routes and runways as if they were streets. */
const ROAD_KINDS = ["highway", "major_road", "minor_road", "other", "path"];

/** Motorway-class gets the darker of the two road colours, matching
 *  GSI's 高速自動車国道等 / vt_motorway split. */
const IS_MOTORWAY: Expr = [
  "any",
  ["==", ["get", "kind"], "highway"],
  ["==", ["get", "kind_detail"], "motorway"],
];

/** Line width in px at z23 — the unit GSI's `vt_width` uses (roughly
 *  hundredths of a metre). Halves with every zoom level below that. */
const ROAD_GROUND_WIDTH: Expr = [
  "match",
  ["get", "kind"],
  "highway",
  3000,
  "major_road",
  1800,
  "minor_road",
  900,
  "path",
  300,
  600,
];

/** Same unit as ROAD_GROUND_WIDTH. GSI doubles these for double track
 *  (`vt_sngldbl`); Protomaps carries no track count, so we take the
 *  single-track width — over-wide rails swamp a dense station area at
 *  z17, and under-wide ones only read as slightly finer track. */
const RAIL_GROUND_WIDTH: Expr = [
  "match",
  ["get", "kind_detail"],
  "subway",
  500,
  ["tram", "light_rail", "monorail", "funicular"],
  400,
  ["narrow_gauge", "siding", "yard", "spur"],
  300,
  600,
];

/** Everything below the surface — tunnels, and subways whether or not
 *  they carry the flag — is drawn through at half opacity, as upstream. */
const SUBSURFACE_OPACITY = 0.5;
/** Subways read as tunnels even where OSM doesn't tag them as one. */
const IS_SUBSURFACE: Expr = [
  "any",
  ["has", "is_tunnel"],
  ["==", ["get", "kind_detail"], "subway"],
];
const IS_SURFACE: Expr = ["!", IS_SUBSURFACE];

/**
 * A width that stays constant *on the ground*: `w` px at z23, halving
 * per level down, plus a constant `casing` px on top (GSI adds its
 * outline width to both interpolation stops, so the casing reads as a
 * fixed screen-space halo at every zoom).
 */
function groundWidth(w: Expr, casing = 0): Expr {
  // 2^-13 — the z10 value of a width defined at z23.
  const add = (base: Expr): Expr => (casing ? ["+", base, casing] : base);
  return [
    "interpolate",
    ["exponential", 2],
    ["zoom"],
    10,
    add(["*", w, 0.0001220703125]),
    23,
    add(w),
  ];
}

/**
 * The overview counterpart: `w` px where the detail rendering takes
 * over, shrinking exponentially down to z4 so the road network fades
 * rather than clutters the world view.
 */
function overviewWidth(w: Expr): Expr {
  return [
    "interpolate",
    ["exponential", 2],
    ["zoom"],
    4,
    ["*", w, 0.0078125], // 2^-7
    DETAIL_MINZOOM,
    w,
  ];
}

/** Casing + fill pair for one road pass (tunnel / ground / bridge).
 *  `opacity` is 0.5 for the subsurface pass. */
function roadPass(id: string, filter: Expr, p: Palette, opacity = 1): Layer[] {
  const color = (motorway: string, other: string): Expr => [
    "case",
    IS_MOTORWAY,
    motorway,
    other,
  ];
  const layout = {
    "line-join": "round",
    "line-cap": "butt",
    "line-round-limit": 1.57,
  };
  return [
    {
      id: `roads_${id}_casing`,
      type: "line",
      source: "@@source",
      "source-layer": "roads",
      minzoom: DETAIL_MINZOOM,
      filter,
      layout,
      paint: {
        "line-color": color(p.motorwayCasing, p.roadCasing),
        "line-opacity": opacity,
        "line-width": groundWidth(ROAD_GROUND_WIDTH, 3),
      },
    },
    {
      id: `roads_${id}`,
      type: "line",
      source: "@@source",
      "source-layer": "roads",
      minzoom: DETAIL_MINZOOM,
      filter,
      layout,
      paint: {
        "line-color": color(p.motorway, p.road),
        "line-opacity": opacity,
        "line-width": groundWidth(ROAD_GROUND_WIDTH),
      },
    },
  ];
}

/**
 * Build the full layer list for a Papers theme.
 *
 * `source` is the name of the vector source in the enclosing style —
 * the two workers name theirs differently.
 */
export function papersLayers(source: string, theme: PapersTheme): Layer[] {
  const p = PALETTES[theme];

  const isRail: Expr = ["==", ["get", "kind"], "rail"];
  const road = (extra: Expr): Expr => [
    "all",
    ["in", ["get", "kind"], ["literal", ROAD_KINDS]],
    extra,
  ];

  const layers: Layer[] = [
    {
      id: "background",
      type: "background",
      paint: {
        // Mid-zoom band takes the water colour so the ocean reads
        // continuous where the polygon coverage thins out.
        "background-color": [
          "step",
          ["zoom"],
          p.background,
          4,
          p.backgroundMid,
          8,
          p.background,
        ],
      },
    },
    {
      id: "earth",
      type: "fill",
      source: "@@source",
      "source-layer": "earth",
      filter: ["==", ["geometry-type"], "Polygon"],
      paint: { "fill-color": p.earth },
    },

    // -- subsurface pass, drawn *under* the water fill on purpose. An
    // undersea tunnel (Tokyo Bay Aqua-Line, the Channel Tunnel) is then
    // masked by the sea it runs beneath, while a tunnel on land still
    // shows through at half opacity the way GSI draws its 地下 features.
    // No attribute tells us "this tunnel is under water", so the draw
    // order does the work instead.
    ...roadPass("tunnel", road(IS_SUBSURFACE), p, SUBSURFACE_OPACITY),
    {
      id: "railway_tunnel",
      type: "line",
      source: "@@source",
      "source-layer": "roads",
      minzoom: DETAIL_MINZOOM,
      filter: ["all", isRail, IS_SUBSURFACE],
      paint: {
        "line-color": p.railway,
        "line-opacity": SUBSURFACE_OPACITY,
        // A plain line, not the ladder — matching GSI, which excludes
        // トンネル/地下 from its ladder rendering entirely.
        "line-width": groundWidth(RAIL_GROUND_WIDTH),
      },
    },

    // -- overview network (z4–11). Screen-constant widths: at this
    // scale a ground-constant road would be sub-pixel everywhere.
    //
    // Also under the water fill, for a different reason: Protomaps drops
    // `is_tunnel` at overview zooms, so an undersea crossing can't be
    // filtered out here — letting the sea paint over it is the only way.
    // The trade is that a long bridge (the Aqua-Line's span, Øresund)
    // disappears too, which at 1px on a z9 map costs nothing.
    {
      id: "roads_overview",
      type: "line",
      source: "@@source",
      "source-layer": "roads",
      maxzoom: DETAIL_MINZOOM,
      filter: [
        "in",
        ["get", "kind"],
        ["literal", ["highway", "major_road", "minor_road"]],
      ],
      layout: { "line-cap": "round", "line-join": "round" },
      paint: {
        "line-color": ["case", IS_MOTORWAY, p.motorway, p.road],
        "line-width": overviewWidth([
          "match",
          ["get", "kind"],
          "highway",
          2,
          "major_road",
          1.5,
          1,
        ]),
      },
    },
    {
      id: "railway_overview",
      type: "line",
      source: "@@source",
      "source-layer": "roads",
      maxzoom: DETAIL_MINZOOM,
      filter: isRail,
      paint: {
        "line-color": p.railway,
        "line-width": overviewWidth(2),
      },
    },

    {
      id: "water",
      type: "fill",
      source: "@@source",
      "source-layer": "water",
      filter: ["==", ["geometry-type"], "Polygon"],
      // Stands in for GSI's separate coastline layer.
      paint: { "fill-color": p.water, "fill-outline-color": p.coastline },
    },
    {
      id: "water_river",
      type: "line",
      source: "@@source",
      "source-layer": "water",
      minzoom: 9,
      filter: ["==", ["get", "kind"], "river"],
      paint: {
        "line-color": p.waterline,
        "line-width": ["interpolate", ["exponential", 1.6], ["zoom"], 9, 0, 9.5, 1, 18, 12],
      },
    },
    {
      id: "water_stream",
      type: "line",
      source: "@@source",
      "source-layer": "water",
      minzoom: 14,
      filter: ["==", ["get", "kind"], "stream"],
      paint: { "line-color": p.waterline, "line-width": 1 },
    },

    // -- boundaries. Dashed at 1px, exactly as upstream: the long/short
    // pattern reads as an administrative edge without competing with
    // the road network for contrast.
    //
    // `kind_detail` is the OSM admin level (2 country, 4 region/state,
    // 6+ county/municipality). The three tiers mirror GSI's: prefecture
    // borders throughout, municipal borders only from z11 — below that
    // a country like France contributes thousands of commune edges and
    // the map turns to hatching.
    {
      id: "boundaries_municipal",
      type: "line",
      source: "@@source",
      "source-layer": "boundaries",
      minzoom: 11,
      filter: [">", ["get", "kind_detail"], 4],
      layout: { "line-cap": "round", "line-join": "round" },
      paint: {
        "line-color": p.boundary,
        "line-width": 1,
        "line-dasharray": [2, 2, 0.01, 2],
      },
    },
    {
      id: "boundaries_region",
      type: "line",
      source: "@@source",
      "source-layer": "boundaries",
      minzoom: 4,
      filter: [
        "all",
        [">", ["get", "kind_detail"], 2],
        ["<=", ["get", "kind_detail"], 4],
      ],
      layout: { "line-cap": "round", "line-join": "round" },
      paint: {
        "line-color": p.boundary,
        "line-width": 1,
        // Fades in the way GSI's 地方界 does at overview zooms.
        "line-opacity": ["step", ["zoom"], 0.5, 8, 1],
        "line-dasharray": [2, 2, 0.01, 2],
      },
    },
    {
      id: "boundaries_country",
      type: "line",
      source: "@@source",
      "source-layer": "boundaries",
      filter: ["<=", ["get", "kind_detail"], 2],
      layout: { "line-cap": "round", "line-join": "round" },
      paint: {
        "line-color": p.boundary,
        "line-width": 1,
        "line-dasharray": [2, 2, 0.01, 2],
      },
    },

    // -- surface network (z11+). Bridges come after the railways below,
    // so a deck covers what it crosses.
    ...roadPass(
      "ground",
      road(["all", IS_SURFACE, ["!", ["has", "is_bridge"]]]),
      p,
    ),
  ];

  // -- railways at detail zoom. Below the ladder threshold: a solid
  // line with a heavy dashed overlay, which renders as ties across the
  // track. Above it: dark casing with a light infill. Tunnels are
  // handled by the subsurface pass above and excluded here.
  const surfaceRail: Expr = ["all", isRail, IS_SURFACE];
  layers.push(
    {
      id: "railway_casing",
      type: "line",
      source: "@@source",
      "source-layer": "roads",
      minzoom: DETAIL_MINZOOM,
      filter: surfaceRail,
      paint: {
        "line-color": p.railway,
        // Proportional, not a fixed halo — GSI sizes its rail casing as
        // a multiple of the track width, so the ladder keeps reading at
        // every zoom instead of collapsing once the track gets wide.
        "line-width": groundWidth(["*", RAIL_GROUND_WIDTH, 1.6]),
      },
    },
    {
      id: "railway_ties",
      type: "line",
      source: "@@source",
      "source-layer": "roads",
      minzoom: DETAIL_MINZOOM,
      maxzoom: RAIL_LADDER_MINZOOM,
      filter: surfaceRail,
      paint: {
        "line-color": p.railway,
        "line-width": groundWidth(["*", RAIL_GROUND_WIDTH, 2]),
        "line-dasharray": [0.2, 2],
      },
    },
    {
      id: "railway_fill",
      type: "line",
      source: "@@source",
      "source-layer": "roads",
      minzoom: RAIL_LADDER_MINZOOM,
      filter: surfaceRail,
      paint: {
        "line-color": p.railwayFill,
        "line-width": groundWidth(RAIL_GROUND_WIDTH),
      },
    },
  );

  // Bridges last: they sit above both the ground network and the rails
  // they cross.
  layers.push(
    ...roadPass("bridge", road(["all", IS_SURFACE, ["has", "is_bridge"]]), p),
  );

  // The `source` placeholder keeps the layer definitions above free of
  // per-caller plumbing.
  return layers.map((l) => (l.source === "@@source" ? { ...l, source } : l));
}

export function isPapersTheme(s: string): s is PapersTheme {
  return s === "papers-light" || s === "papers-dark";
}
