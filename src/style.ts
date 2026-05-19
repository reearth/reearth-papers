// Dynamically built MapLibre style backed by the Protomaps PMTiles
// vector tiles served from this worker's `/v/{z}/{x}/{y}.mvt`. Clients
// can either render the style directly (full client-side vector path)
// or use the rendered raster output via `/styles/{theme}/tile/...`.
//
// Glyphs and sprites are referenced from Protomaps' public GitHub
// Pages CDN — small enough that mirroring them is premature, and
// they're versioned by URL path so an upstream change can't silently
// shift our rendering.

import { layers, namedTheme } from "protomaps-themes-base";

const ASSETS_BASE = "https://protomaps.github.io/basemaps-assets";
// Source name referenced by the generated layers — must match the
// first argument passed to `layers(...)` below. We call it `v` so it
// reads as a stable handle for the `/v/{z}/{x}/{y}.mvt` endpoint the
// style points at.
const SOURCE_NAME = "v";

const ATTRIBUTION =
  '<a href="https://papers.reearth.land">Re:Earth Papers</a> · ' +
  '<a href="https://protomaps.com">Protomaps</a> · ' +
  '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors';

export type Theme = "light" | "dark" | "white" | "black" | "grayscale";

export const THEMES: readonly Theme[] = [
  "light",
  "dark",
  "white",
  "black",
  "grayscale",
];

export function isTheme(s: string): s is Theme {
  return (THEMES as readonly string[]).includes(s);
}

export function buildStyle(theme: Theme, origin: string): Record<string, unknown> {
  return {
    version: 8,
    name: `Re:Earth Papers — ${theme}`,
    sources: {
      [SOURCE_NAME]: {
        type: "vector",
        tiles: [`${origin}/v/{z}/{x}/{y}.mvt`],
        // Protomaps planet builds carry data through z15; downstream
        // overzoom handles anything tighter.
        maxzoom: 15,
        attribution: ATTRIBUTION,
      },
    },
    glyphs: `${ASSETS_BASE}/fonts/{fontstack}/{range}.pbf`,
    sprite: `${ASSETS_BASE}/sprites/v4/${theme}`,
    layers: layers(SOURCE_NAME, namedTheme(theme), { lang: "en" }),
  };
}

export function handleStyle(theme: Theme, request: Request): Response {
  const origin = new URL(request.url).origin;
  return new Response(JSON.stringify(buildStyle(theme, origin)), {
    headers: {
      "content-type": "application/json",
      "cache-control": "public, max-age=300",
      "access-control-allow-origin": "*",
    },
  });
}
