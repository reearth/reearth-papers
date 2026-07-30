// Dynamically built MapLibre style backed by the Protomaps PMTiles
// vector tiles served from this worker's `/protomaps/{z}/{x}/{y}.mvt`. Clients
// can either render the style directly (full client-side vector path)
// or use the rendered raster output via `/styles/{theme}/tile/...`.
//
// Glyphs are self-hosted at /fonts/ (mirror/fonts/ fills the CJK gap
// Protomaps' hosted PBFs deliberately leave to browser local fonts —
// our headless renderer has no such fallback). Sprites still come from
// Protomaps' GitHub Pages CDN, versioned by URL path.

import { layers, namedTheme } from "protomaps-themes-base";

import { applyCjkFlavor, type CjkFlavor, isCjkFlavor } from "./cjk_flavor.js";
import { isPapersTheme, papersLayers } from "./papers_layers.js";

const ASSETS_BASE = "https://protomaps.github.io/basemaps-assets";
// Source name referenced by the generated layers — must match the
// first argument passed to `layers(...)` below.
const SOURCE_NAME = "v";

const ATTRIBUTION =
  '<a href="https://papers.reearth.land">Re:Earth Papers</a> · ' +
  '<a href="https://protomaps.com">Protomaps</a> · ' +
  '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors';

export type Theme =
  | "papers-light"
  | "papers-dark"
  | "light"
  | "dark"
  | "white"
  | "black"
  | "grayscale";

// Order matters: this drives the catalog, and the catalog drives the
// viewer's gallery. The house styles lead.
export const THEMES: readonly Theme[] = [
  "papers-light",
  "papers-dark",
  "light",
  "dark",
  "white",
  "black",
  "grayscale",
];

/** Display name for the catalog. Themes without an entry fall back to
 *  `Protomaps Basemap (<theme>)` — they *are* stock Protomaps themes. */
export const THEME_NAMES: Partial<Record<Theme, string>> = {
  "papers-light": "Papers Light",
  "papers-dark": "Papers Dark",
};

export function themeName(theme: Theme): string {
  return THEME_NAMES[theme] ?? `Protomaps Basemap (${theme})`;
}

/** Catalog id. The stock themes keep their `protomaps-` prefix; the
 *  house styles are already namespaced by their `papers-` one. */
export function themeCatalogId(theme: Theme): string {
  return isPapersTheme(theme) ? theme : `protomaps-${theme}`;
}

export function isTheme(s: string): s is Theme {
  return (THEMES as readonly string[]).includes(s);
}

export function buildStyle(
  theme: Theme,
  origin: string,
  cjk?: CjkFlavor,
): Record<string, unknown> {
  const source = {
    type: "vector",
    tiles: [`${origin}/protomaps/{z}/{x}/{y}.mvt`],
    // Protomaps planet builds carry data through z15; downstream
    // overzoom handles anything tighter.
    maxzoom: 15,
    attribution: ATTRIBUTION,
  };

  // The house styles carry no symbol layers at all, so they need
  // neither glyphs nor a sprite — which also keeps the renderer from
  // pulling ~50 MB of font/sprite assets before its first tile.
  if (isPapersTheme(theme)) {
    return {
      version: 8,
      name: `Re:Earth Papers — ${themeName(theme)}`,
      sources: { [SOURCE_NAME]: source },
      layers: papersLayers(SOURCE_NAME, theme),
    };
  }

  // ?cjk=sc|tc swaps the base fontstacks for the region-priority ones
  // (see cjk_flavor.ts) — Han-unified codepoints then render with
  // Simplified / Traditional variants instead of the JP-first default.
  const stockLayers = layers(SOURCE_NAME, namedTheme(theme), { lang: "en" });
  return {
    version: 8,
    name: `Re:Earth Papers — ${theme}`,
    sources: { [SOURCE_NAME]: source },
    glyphs: `${origin}/fonts/{fontstack}/{range}.pbf`,
    sprite: `${ASSETS_BASE}/sprites/v4/${theme}`,
    layers: cjk ? applyCjkFlavor(stockLayers, cjk) : stockLayers,
  };
}

export function handleStyle(theme: Theme, request: Request): Response {
  const url = new URL(request.url);
  const origin = url.origin;
  const cjkParam = url.searchParams.get("cjk") ?? "";
  const cjk = isCjkFlavor(cjkParam) ? cjkParam : undefined;
  return new Response(JSON.stringify(buildStyle(theme, origin, cjk)), {
    headers: {
      "content-type": "application/json",
      "cache-control": "public, max-age=300",
      "access-control-allow-origin": "*",
    },
  });
}
