// Passthrough tilesets.
//
// A passthrough tileset is TileJSON-only: its `tiles` point straight at
// an upstream provider, so we serve no bytes and store nothing in R2.
// Attribution — baked into the generated TileJSON — is the only thing
// we own.
//
// To add a source, append ONE entry to PASSTHROUGH_TILESETS below.
// Everything else is derived from it automatically:
//   - the TileJSON route  /<id>/tilejson.json  (see index.ts)
//   - the catalog.json entry                    (see catalog.ts)
//
// Requirement: the upstream MUST send `access-control-allow-origin: *`
// so browser clients can fetch its tiles cross-origin. Verify before
// adding (e.g. `curl -sI <tile-url> | grep -i access-control`).

export interface PassthroughTileset {
  /** Route prefix and catalog id, e.g. "bluemarble" → /bluemarble/tilejson.json */
  id: string;
  name: string;
  description: string;
  attribution: string;
  /** Upstream XYZ tile URL template(s), with {z}/{x}/{y} placeholders. */
  tiles: string[];
  minzoom: number;
  /** Native max zoom; clients overzoom past this. */
  maxzoom: number;
}

const PAPERS = '<a href="https://papers.reearth.land">Re:Earth Papers</a>';

export const PASSTHROUGH_TILESETS: PassthroughTileset[] = [
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
    tiles: [
      "https://gibs.earthdata.nasa.gov/wmts/epsg3857/best/BlueMarble_NextGeneration/default/GoogleMapsCompatible_Level8/{z}/{y}/{x}.jpeg",
    ],
    minzoom: 0,
    maxzoom: 8,
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
    tiles: [
      "https://tiles.maps.eox.at/wmts/1.0.0/s2cloudless_3857/default/GoogleMapsCompatible/{z}/{y}/{x}.jpg",
    ],
    minzoom: 0,
    maxzoom: 14,
  },
];

export const PASSTHROUGH_BY_ID: Map<string, PassthroughTileset> = new Map(
  PASSTHROUGH_TILESETS.map((t) => [t.id, t]),
);
