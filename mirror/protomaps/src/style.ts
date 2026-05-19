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
  const tileUrl = "https://reearth-papers-mirror.reearth.workers.dev/v/{z}/{x}/{y}.mvt";

  const allLayers = layers(SOURCE_NAME, namedTheme(theme), { lang: "en" });
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
  if (!minimal) {
    style.glyphs = `${ASSETS_BASE}/fonts/{fontstack}/{range}.pbf`;
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
