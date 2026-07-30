// Dynamically built MapLibre style backed by the mirrored Protomaps
// PMTiles vector tiles served from this worker.
//
// The layers come from `protomaps-themes-base`, the official Protomaps
// theme package. Glyphs come from the main worker's /fonts/ route
// (mirror/fonts/ fills the CJK gap Protomaps' hosted PBFs leave to
// browser local fonts — the headless renderer has no such fallback);
// the container's loopback proxy fetches them with reqwest/rustls, so
// the libcurl TLS issue that pushed tiles onto workers.dev doesn't
// apply. Sprites still come from Protomaps' GitHub Pages CDN.

import { layers, namedTheme } from "protomaps-themes-base";

// Reaches across into the main worker's source on purpose: the house
// cartography is ~300 lines and both workers must render it
// identically, so it lives in exactly one file. The two projects
// deploy separately but always from the same checkout. Same deal for
// the CJK flavor logic.
import { applyCjkFlavor, isCjkFlavor } from "../../../src/cjk_flavor.js";
import { isPapersTheme, papersLayers } from "../../../src/papers_layers.js";

const ASSETS_BASE = "https://protomaps.github.io/basemaps-assets";
const FONTS_BASE = "https://papers.reearth.land/fonts";
// Tile source name referenced by the generated layers — must match the
// first argument passed to `layers(...)` below.
const SOURCE_NAME = "protomaps";

// Keep in sync with THEMES in the main worker's src/style.ts — it's
// what decides which `?theme=` values the renderer can be asked for.
type Theme =
  | "papers-light"
  | "papers-dark"
  | "light"
  | "dark"
  | "white"
  | "black"
  | "grayscale";

const VALID_THEMES: ReadonlySet<Theme> = new Set([
  "papers-light",
  "papers-dark",
  "light",
  "dark",
  "white",
  "black",
  "grayscale",
]);

function isTheme(s: string): s is Theme {
  return VALID_THEMES.has(s as Theme);
}

export function handleStyle(url: URL, env: Env): Response {
  const themeParam = url.searchParams.get("theme") ?? "light";
  const theme: Theme = isTheme(themeParam) ? themeParam : "light";
  // ?minimal=1 omits glyphs + sprite and keeps only non-label/icon
  // layers. Used for isolating network issues to the asset CDN —
  // without it the container fetches ~50 MB of glyphs + sprite assets
  // from protomaps.github.io before rendering.
  const minimal = url.searchParams.get("minimal") === "1";

  // Vector tile URL points at the mirror worker's workers.dev
  // hostname. The container's libcurl/OpenSSL kept failing TLS to
  // `papers.reearth.land:443` (SSL_ERROR_SYSCALL) while reqwest/rustls
  // on the same URL worked, so routing the tile fetches through the
  // mirror's workers.dev cert chain sidesteps the issue.
  //
  // The `?token=` query is the same secret the caller used to fetch
  // this style — the loopback proxy in the renderer container
  // preserves query strings, so embedding it here is enough to keep
  // tile fetches authenticated end-to-end.
  const token = encodeURIComponent(env.INTERNAL_TOKEN);
  const tileUrl =
    `https://reearth-papers-mirror.reearth.workers.dev/protomaps/{z}/{x}/{y}.mvt?token=${token}`;

  // ?cjk=sc|tc swaps the base fontstacks for the region-priority ones
  // (see src/cjk_flavor.ts). The renderer worker appends it per tile
  // based on the tile's location.
  const cjkParam = url.searchParams.get("cjk") ?? "";
  const cjk = isCjkFlavor(cjkParam) ? cjkParam : undefined;

  // The house styles carry no symbol layers, so `?minimal=1` is a
  // no-op for them and they never need glyphs or a sprite.
  const papers = isPapersTheme(theme);
  const stockLayers = layers(SOURCE_NAME, namedTheme(theme), { lang: "en" });
  const allLayers: { type?: unknown }[] = papers
    ? papersLayers(SOURCE_NAME, theme)
    : cjk
      ? applyCjkFlavor(stockLayers, cjk)
      : stockLayers;
  const keptLayers = minimal
    ? allLayers.filter((l) => l.type !== "symbol")
    : allLayers;

  const style: Record<string, unknown> = {
    version: 8,
    name: `Protomaps Basemap: ${theme}${minimal ? " (minimal)" : ""}`,
    sources: {
      [SOURCE_NAME]: {
        type: "vector",
        tiles: [tileUrl],
        // Protomaps planet builds carry data through z15; downstream
        // overzoom handles anything tighter.
        maxzoom: 15,
        attribution:
          '<a href="https://protomaps.com">Protomaps</a> &copy; <a href="https://openstreetmap.org">OpenStreetMap</a>',
      },
    },
    layers: keptLayers,
  };
  if (!minimal && !papers) {
    style.glyphs = `${FONTS_BASE}/{fontstack}/{range}.pbf`;
    style.sprite = `${ASSETS_BASE}/sprites/v4/${theme}`;
  }

  return new Response(JSON.stringify(style), {
    headers: {
      "content-type": "application/json",
      "cache-control": "public, max-age=300",
      "access-control-allow-origin": "*",
    },
  });
}
