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
//   - the casing withheld from the fine street classes until z13, which
//     is what keeps arterials reading as ribbons over a faint
//     residential texture instead of flattening into one grey tone,
//   - railways as a light bed under a dark centreline with tie ticks,
//     the centreline freezing at z14 so the bed opens out into the
//     classic "ladder" above it.
//
// What had to be reinterpreted, because the schemas don't line up:
//   - GSI stacks features by `vt_lvorder` 0..4 (five identical layer
//     groups). Protomaps encodes the same idea as `is_tunnel` /
//     `is_bridge` flags, so the five groups collapse to three passes.
//   - GSI carries a real carriageway width per feature (`vt_width` /
//     `vt_rnkwidth`). Protomaps has no width attribute, so widths are
//     derived from `kind`, keeping the original's unit scale (the value
//     is the line width in px at z23, halving per zoom level down), and
//     per-feature `min_zoom` stands in for GSI simply not carrying a
//     farm track in its mid-zoom tiles.
//   - There is no coastline layer upstream; the water polygon's
//     `fill-outline-color` stands in for GSI's `Cstline`.
//   - GSI's tiles are 256px, ours 512px, so every zoom threshold and
//     every screen-space width upstream states needs converting — see
//     SCREEN_SCALE and `gsiZoom`.
//
// Calibrated against PLATEAU's own rendered tiles
// (tile.plateauview.mlit.go.jp/tiles/{light,dark}-map), matching the
// share of inked pixels over Tokyo, Osaka and rural Nagano at z6–z16.
// Two knowing departures, both because our data is the whole planet:
// municipal boundaries start at z10 rather than being drawn at every
// zoom (GSI's 地方界 layer shows them solid below z8, which over Europe
// is thousands of commune edges), and the overview road network is
// thinner at z8–z9 simply because Protomaps carries fewer roads there.
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

/** Screen-space widths — casings, boundary hairlines, stream lines — are
 *  half of the number GSI writes in its style, and this is why.
 *
 *  GSI's widths are authored against a 256px tile: the PLATEAU tile
 *  server hands MapLibre a `tileSize: 256` raster, so at map zoom N it
 *  paints the z(N+1) tile — the style evaluated one level in, at half
 *  scale. Ours is a `tileSize: 512` raster, evaluated at the map zoom
 *  itself. Ground-constant widths come out identical either way (one
 *  level shallower cancels the doubled scale), but a constant screen
 *  width does not: GSI's 3px road casing lands as 1.5px on screen, and
 *  taking the 3 literally is what made the road network read as a grey
 *  mush at z12 — every lane sub-pixel, every casing 3px wide.
 *
 *  Multiply any width GSI states in screen px by this. */
const SCREEN_SCALE = 0.5;

/** The zoom counterpart of SCREEN_SCALE: a threshold GSI states in its
 *  own tile zooms is one level in from the map zoom we evaluate at. */
const gsiZoom = (z: number): number => z - 1;

/** GSI's `outlineWidth` — the halo a road casing adds around the
 *  carriageway, in its screen px. */
const ROAD_CASING_PX = 3 * SCREEN_SCALE;

/** Zoom at which the ground-constant rendering takes over from the
 *  screen-constant overview rendering. GSI hands over at its z11, i.e.
 *  z10 here, but Protomaps only starts emitting `is_tunnel` /
 *  `is_bridge` at z12 (checked over Tokyo Bay — z8–z11 carry neither
 *  attribute at all), and a zoom's worth of roads all drawn as if they
 *  were on the surface costs more than handing over a level late. */
const DETAIL_MINZOOM = 12;
/** Belt and braces on top of the overview layers' `maxzoom` — see the
 *  comment there. */
const IS_OVERVIEW_ZOOM: Expr = ["<", ["zoom"], DETAIL_MINZOOM];

/** GSI shows 市区町村界 from its z11 (and, through its 地方界 layer, at
 *  every zoom below z8 as well — which we skip: outside Japan that is
 *  every French commune edge at once). */
const MUNICIPAL_BOUNDARY_MINZOOM = gsiZoom(11);

/** Where the railway centreline stops widening and the light bed starts
 *  showing from under it. Below it a track is a solid dark line with
 *  ties; above it, the ladder. */
const RAIL_LADDER_MINZOOM = gsiZoom(15);

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
 * `groundWidth`, but it stops widening at RAIL_LADDER_MINZOOM — the
 * railway centreline and its ties freeze there so the bed underneath can
 * grow out from behind them.
 */
function cappedGroundWidth(w: Expr): Expr {
  return [
    "interpolate",
    ["exponential", 2],
    ["zoom"],
    10,
    ["*", w, 0.0001220703125], // 2^-13
    RAIL_LADDER_MINZOOM,
    ["*", w, 2 ** (RAIL_LADDER_MINZOOM - 23)],
  ];
}

/**
 * The overview counterpart: `w` px at z10, shrinking exponentially down
 * to z3 so the road network fades rather than clutters the world view,
 * and held flat from z10 up to where the detail pass takes over.
 *
 * The stops are GSI's (z4→z11 on a 256px tile, so z3→z10 here); topping
 * out at DETAIL_MINZOOM instead left z10 at a quarter width, and the
 * overview network all but vanished two zooms before it hands over.
 */
function overviewWidth(w: Expr): Expr {
  return [
    "interpolate",
    ["exponential", 2],
    ["zoom"],
    3,
    ["*", w, 0.0078125 * SCREEN_SCALE], // 2^-7
    10,
    ["*", w, SCREEN_SCALE],
  ];
}

/** Protomaps tags every road with the zoom it is meant to appear at —
 *  and then ships it a level or two early so overzoomed tiles have
 *  something to draw. Honouring it is what keeps a forest track or a
 *  farm road out of a z12 view of the Japanese Alps; GSI gets the same
 *  effect by simply not carrying those features in its mid-zoom tiles.
 *  Features without the attribute are kept. */
const AT_OWN_MINZOOM: Expr = [
  "any",
  ["!", ["has", "min_zoom"]],
  ["<=", ["get", "min_zoom"], ["zoom"]],
];

/** Until this zoom the fine street classes are drawn as a bare
 *  centreline — no casing. GSI does this explicitly (its casing layers
 *  filter out 市区町村道等/その他/不明 narrower than 5.5 m until its z14)
 *  and it is what gives the mid-zoom map its hierarchy: arterials read
 *  as ribbons while the residential grid stays a faint texture
 *  underneath. Casing every class instead flattens a whole ward into one
 *  grey tone, because at z12 the 1.5px halo is three times the
 *  carriageway it wraps. */
const CASING_ALL_KINDS_MINZOOM = gsiZoom(14);
const CASING_KINDS_BELOW = ["highway", "major_road"];
const HAS_CASING: Expr = [
  "any",
  [">=", ["zoom"], CASING_ALL_KINDS_MINZOOM],
  ["in", ["get", "kind"], ["literal", CASING_KINDS_BELOW]],
];

/** Casing + fill pair for one road pass (tunnel / ground / bridge).
 *  `opacity` is 0.5 for the subsurface pass, which also drops its casing
 *  — GSI's casing layers exclude every トンネル / 地下 road code, so an
 *  underground road is a bare centreline there and reads as one crossing
 *  Tokyo Bay rather than as a full-weight ribbon. */
function roadPass(
  id: string,
  filter: Expr,
  p: Palette,
  { opacity = 1, casing = true }: { opacity?: number; casing?: boolean } = {},
): Layer[] {
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
  const casingLayer: Layer[] = casing
    ? [
        {
          id: `roads_${id}_casing`,
          type: "line",
          source: "@@source",
          "source-layer": "roads",
          minzoom: DETAIL_MINZOOM,
          filter: ["all", filter, HAS_CASING],
          layout,
          paint: {
            "line-color": color(p.motorwayCasing, p.roadCasing),
            "line-opacity": opacity,
            "line-width": groundWidth(ROAD_GROUND_WIDTH, ROAD_CASING_PX),
          },
        },
      ]
    : [];
  return [
    ...casingLayer,
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
    AT_OWN_MINZOOM,
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

    // -- boundaries, drawn *under* the water fill on purpose.
    //
    // GSI's `AdmBdry` stops at the coastline, so PLATEAU's basemap shows
    // no administrative edges out at sea. OSM's do run offshore — every
    // bay ward carries its slice of Tokyo Bay — and Protomaps' tiles
    // carry no maritime flag to filter them by. Letting the sea paint
    // over them reproduces the upstream look: dashes on land, clean
    // water. It also clips a boundary that follows a river or a lake
    // shore, which is how GSI reads too.
    //
    // Dashed at GSI's 1px, exactly as upstream: the long/short pattern
    // reads as an administrative edge without competing with the road
    // network for contrast.
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
      minzoom: MUNICIPAL_BOUNDARY_MINZOOM,
      filter: [">", ["get", "kind_detail"], 4],
      layout: { "line-cap": "round", "line-join": "round" },
      paint: {
        "line-color": p.boundary,
        "line-width": SCREEN_SCALE,
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
        "line-width": SCREEN_SCALE,
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
        "line-width": SCREEN_SCALE,
        "line-dasharray": [2, 2, 0.01, 2],
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
        "line-width": [
          "interpolate",
          ["exponential", 1.6],
          ["zoom"],
          9,
          0,
          9.5,
          SCREEN_SCALE,
          18,
          12 * SCREEN_SCALE,
        ],
      },
    },
    {
      id: "water_stream",
      type: "line",
      source: "@@source",
      "source-layer": "water",
      minzoom: 14,
      filter: ["==", ["get", "kind"], "stream"],
      paint: { "line-color": p.waterline, "line-width": SCREEN_SCALE },
    },

    // -- subsurface pass: tunnels and subways, at half opacity, the way
    // GSI draws its 地下 features.
    //
    // Above the water fill, which means an undersea crossing paints
    // across the sea it runs beneath — the Aqua-Line's tunnel half
    // reaching Kawasaki, the Seikan tunnel across the Tsugaru Strait.
    // That is what PLATEAU shows, checked tile by tile over Tokyo Bay,
    // and hiding them under the sea instead left the crossing snapped in
    // half mid-water with no hint that it continues.
    ...roadPass("tunnel", road(IS_SUBSURFACE), p, {
      opacity: SUBSURFACE_OPACITY,
      casing: false,
    }),
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
    // Protomaps drops `is_tunnel` / `is_bridge` below z12, so this one
    // pass carries surface, bridge and tunnel alike — including the sea
    // crossings, at full strength, as upstream.
    //
    // The handover is spelled out in the filter as well as in `maxzoom`
    // because `maxzoom` alone once painted the overview network and the
    // detail network on top of each other at exactly z12 — the single
    // biggest reason the mid-zoom map came out heavier than PLATEAU's.
    // gl-js stops drawing a layer *at* its maxzoom; `ezu translate`
    // below 0.6.1 copied that number into a bound ezu treats as
    // inclusive, so the raster tiles drew one zoom too far
    // (reearth/ezu#90, fixed in 0.6.1). The recipes are regenerated
    // artifacts, so keep the filter: it holds the handover at one zoom
    // whichever CLI version bakes them.
    {
      id: "roads_overview",
      type: "line",
      source: "@@source",
      "source-layer": "roads",
      maxzoom: DETAIL_MINZOOM,
      filter: [
        "all",
        IS_OVERVIEW_ZOOM,
        ["in", ["get", "kind"], ["literal", ["highway", "major_road", "minor_road"]]],
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
      filter: ["all", IS_OVERVIEW_ZOOM, isRail],
      paint: {
        "line-color": p.railway,
        "line-width": overviewWidth(2),
      },
    },

    // -- surface network (z12+). Bridges come after the railways below,
    // so a deck covers what it crosses.
    ...roadPass(
      "ground",
      road(["all", IS_SURFACE, ["!", ["has", "is_bridge"]]]),
      p,
    ),
  ];

  // -- railways at detail zoom, three passes deep, as GSI stacks them:
  // a light bed at the full ground width, a dark centreline over it, and
  // dark ties at twice the centreline's width so they read as ticks
  // sticking out either side.
  //
  // The trick is that only the bed keeps growing. Centreline and ties
  // stop widening at RAIL_LADDER_MINZOOM, so up to there the dark line
  // covers the bed exactly — a solid dark track with ties — and past it
  // the bed opens out from under the line into the classic light-ballast
  // ladder. Sizing the dark line as a fixed multiple of the bed instead
  // (which is what we did before, reading GSI's 3× station casing as if
  // it applied to every track) leaves the ties buried inside the line at
  // every zoom, and the track reads as a plain grey ribbon.
  //
  // Tunnels are handled by the subsurface pass above and excluded here.
  const surfaceRail: Expr = ["all", isRail, IS_SURFACE];
  layers.push(
    {
      id: "railway_fill",
      type: "line",
      source: "@@source",
      "source-layer": "roads",
      minzoom: DETAIL_MINZOOM,
      filter: surfaceRail,
      paint: {
        "line-color": p.railwayFill,
        "line-width": groundWidth(RAIL_GROUND_WIDTH),
      },
    },
    {
      id: "railway_casing",
      type: "line",
      source: "@@source",
      "source-layer": "roads",
      minzoom: DETAIL_MINZOOM,
      filter: surfaceRail,
      paint: {
        "line-color": p.railway,
        "line-width": cappedGroundWidth(RAIL_GROUND_WIDTH),
      },
    },
    {
      id: "railway_ties",
      type: "line",
      source: "@@source",
      "source-layer": "roads",
      minzoom: DETAIL_MINZOOM,
      filter: surfaceRail,
      paint: {
        "line-color": p.railway,
        "line-width": cappedGroundWidth(["*", RAIL_GROUND_WIDTH, 2]),
        "line-dasharray": [0.2, 2],
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
