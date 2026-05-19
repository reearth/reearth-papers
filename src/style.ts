// Dynamically built MapLibre style backed by the mirrored Protomaps
// PMTiles vector tiles served from this worker.
//
// The layers come from `protomaps-themes-base`, the official Protomaps
// theme package. Glyphs and sprites are referenced from Protomaps'
// public GitHub Pages CDN — small enough that mirroring them is
// premature, and they're versioned by URL path so an upstream change
// can't silently shift our rendering.

import { layers, namedTheme } from "protomaps-themes-base";

const ASSETS_BASE = "https://protomaps.github.io/basemaps-assets";
// Tile source name referenced by the generated layers — must match the
// first argument passed to `layers(...)` below.
const SOURCE_NAME = "protomaps";

type Theme = "light" | "dark" | "white" | "black" | "grayscale";

const VALID_THEMES: ReadonlySet<Theme> = new Set([
  "light",
  "dark",
  "white",
  "black",
  "grayscale",
]);

function isTheme(s: string): s is Theme {
  return VALID_THEMES.has(s as Theme);
}

export function handleStyle(url: URL, request: Request): Response {
  const themeParam = url.searchParams.get("theme") ?? "light";
  const theme: Theme = isTheme(themeParam) ? themeParam : "light";

  // Build the vector tile URL on the same origin the style is served
  // from, so the style works on both `papers.reearth.land` and any
  // workers.dev preview without hard-coding the production host.
  const origin = new URL(request.url).origin;
  const tileUrl = `${origin}/v/{z}/{x}/{y}.mvt`;

  const style = {
    version: 8,
    name: `Protomaps Basemap: ${theme}`,
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
    glyphs: `${ASSETS_BASE}/fonts/{fontstack}/{range}.pbf`,
    sprite: `${ASSETS_BASE}/sprites/v4/${theme}`,
    layers: layers(SOURCE_NAME, namedTheme(theme), { lang: "en" }),
  };

  return new Response(JSON.stringify(style), {
    headers: {
      "content-type": "application/json",
      "cache-control": "public, max-age=300",
      "access-control-allow-origin": "*",
    },
  });
}
