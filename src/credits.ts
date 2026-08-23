// Where every tileset's data comes from, and what the map itself has to
// say about it.
//
// Two different things are wanted from the same facts:
//
//   - The tile credit — the line a map client renders in its corner.
//     It has to be short, because it sits on top of somebody else's
//     application.
//   - The credits page (/attribution) — the full chain, with licences
//     and links, which is where the short line points.
//
// What may be folded into the page, and what must stay on the map, is
// not a matter of taste:
//
//   - A licence that requires its notice on the *produced work* keeps
//     its name on the map. ODbL is the one that does this here (§4.3:
//     the produced work carries the notice), which is why
//     `© OpenStreetMap contributors` survives every compression below.
//   - CC BY 4.0 explicitly allows the required information to be
//     satisfied "by providing a URI or hyperlink to a resource that
//     includes the required information" (§3(a)(2)), so those credits
//     fold behind the `Re:Earth Papers` link.
//   - Public-domain and open-government sources carry no obligation at
//     all; they are on the page because a reader deserves to know what
//     they are looking at, not because a licence says so.
//
// This is the same arrangement Mapterhorn uses to stand for its ~148
// upstream DEMs under one name. It only works while the link works: if
// `/attribution` stops listing a source, the fold stops being a fold
// and becomes a dropped credit.

/** One upstream, as its producer names it. */
export interface Credit {
  name: string;
  url?: string;
  /** Licence, spelled the way the producer spells it. */
  license: string;
  licenseUrl?: string;
  /** Text the licence asks to be carried verbatim, where there is any. */
  note?: string;
  /** The HTML this credit contributes to the *map* credit. Present only
   *  for licences whose notice must appear on the produced work; every
   *  other credit lives on the page alone. */
  onMap?: string;
}

/** The service's own link — and the path by which every folded credit
 *  is still reachable. Compression rests on this href. */
export const PAPERS = '<a href="https://papers.reearth.land/attribution">Re:Earth Papers</a>';

const OSM: Credit = {
  name: "OpenStreetMap contributors",
  url: "https://www.openstreetmap.org/copyright",
  license: "ODbL 1.0",
  licenseUrl: "https://opendatacommons.org/licenses/odbl/1-0/",
  onMap:
    '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors',
};

const PROTOMAPS: Credit = {
  name: "Protomaps",
  url: "https://protomaps.com",
  license: "basemap build of OpenStreetMap data (ODbL); tooling BSD-3",
  note: "The daily vector basemap the rendered styles are drawn from.",
};

const NATURAL_EARTH: Credit = {
  name: "Natural Earth",
  url: "https://www.naturalearthdata.com",
  license: "public domain",
};

export interface CreditGroup {
  /** Heading on the credits page. */
  title: string;
  /** Shown under the heading, where the group needs a word of context. */
  note?: string;
  credits: readonly Credit[];
}

/** Keyed by the shelf a tileset sits on rather than by tileset id —
 *  most of these cover a family. */
const GROUPS = {
  osm: {
    title: "Rendered basemaps & OpenStreetMap vector",
    credits: [PROTOMAPS, OSM],
  },
  paint: {
    title: "Paint styles",
    note:
      "A paint style publishes its own credit with the style, not from " +
      "this registry, so a live paint tile may still name each of these " +
      "in its TileJSON; the line below is what it compresses to. Terrain " +
      "is read by every paint style except pencil-sketch, which shades " +
      "nothing.",
    credits: [
      PROTOMAPS,
      OSM,
      {
        name: "Re:Earth Terrain",
        url: "https://terrain.reearth.land/",
        license: "see its own credits",
        licenseUrl: "https://terrain.reearth.land/",
        note: "The DEM the paint styles shade from.",
      },
      {
        name: "Mapterhorn",
        url: "https://mapterhorn.com/",
        license: "open data; CC BY 4.0, public-domain and open-government sources",
        licenseUrl: "https://mapterhorn.com/attribution/",
        note:
          "Mapterhorn stands for ~148 upstream elevation sources under one " +
          "name, on the same terms this page uses: none of them is " +
          "share-alike or non-commercial, and the full list is published at " +
          "download.mapterhorn.com/attribution.json.",
      },
      {
        name: "EGM2008 (NGA)",
        url: "https://earth-info.nga.mil/",
        license: "public domain (U.S. Government work)",
        note: "The geoid the elevations are referenced to.",
      },
    ],
  },
  overture: {
    title: "Overture Maps",
    credits: [
      {
        name: "Overture Maps Foundation",
        url: "https://overturemaps.org",
        license: "ODbL 1.0 / CDLA-Permissive-2.0, per theme",
        licenseUrl: "https://docs.overturemaps.org/attribution/",
        onMap: '<a href="https://overturemaps.org">Overture Maps Foundation</a>',
      },
      OSM,
    ],
  },
  watercolor: {
    title: "Stamen Watercolor",
    credits: [
      {
        name: "Stamen Design",
        url: "https://stamen.com",
        license: "CC BY 4.0",
        licenseUrl: "https://creativecommons.org/licenses/by/4.0/",
      },
      OSM,
    ],
  },
  naturalEarth: {
    title: "Natural Earth",
    credits: [NATURAL_EARTH],
  },
  esaWorldcover: {
    title: "ESA WorldCover",
    credits: [
      {
        name: "ESA WorldCover project 2021",
        url: "https://esa-worldcover.org",
        license: "CC BY 4.0",
        licenseUrl: "https://creativecommons.org/licenses/by/4.0/",
        note:
          "Contains modified Copernicus Sentinel data (2021) processed by " +
          "ESA WorldCover consortium.",
      },
    ],
  },
  blackmarble: {
    title: "NASA Black Marble",
    credits: [
      {
        name: "NASA Earth Observatory",
        url: "https://science.nasa.gov/earth/earth-observatory/earth-at-night/maps",
        license: "public domain (U.S. Government work)",
        note: "Suomi NPP VIIRS · Black Marble 2016.",
      },
    ],
  },
  bluemarble: {
    title: "NASA Blue Marble",
    credits: [
      {
        name: "NASA EOSDIS GIBS",
        url: "https://earthdata.nasa.gov/gibs",
        license: "public domain (U.S. Government work)",
        note: "Blue Marble: Next Generation. Tiles are served by GIBS, not by us.",
      },
    ],
  },
  s2cloudless: {
    title: "Sentinel-2 cloudless 2016",
    credits: [
      {
        name: "EOX IT Services GmbH",
        url: "https://s2maps.eu",
        license: "CC BY 4.0",
        licenseUrl: "https://creativecommons.org/licenses/by/4.0/",
        note:
          "Sentinel-2 cloudless 2016 by EOX IT Services GmbH. " +
          "Contains modified Copernicus Sentinel data 2016 & 2017. " +
          "Tiles are served by EOX, not by us.",
      },
    ],
  },
} satisfies Record<string, CreditGroup>;

export type CreditGroupId = keyof typeof GROUPS;

/** Widened to `CreditGroup`: the literal inference from `satisfies`
 *  drops the optional fields an entry happens not to set. */
export const CREDIT_GROUPS: Readonly<Record<CreditGroupId, CreditGroup>> = GROUPS;

/** The map credit for a group: this service, plus only those names a
 *  licence puts on the produced work itself. Everything else is one
 *  click away through the `Re:Earth Papers` link. */
export function attributionOf(group: CreditGroupId): string {
  const onMap = CREDIT_GROUPS[group].credits.flatMap((c) => (c.onMap ? [c.onMap] : []));
  return [PAPERS, ...onMap].join(" · ");
}
