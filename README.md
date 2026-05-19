# Re:Earth Papers

A tile service that renders OpenStreetMap (via Protomaps) into beautiful
raster tiles across a curated set of styles.

## Endpoints

- `https://papers.reearth.land/tile/{z}/{x}/{y}.png` — rendered raster
  tile. Pass `?style=<url>` to render against an arbitrary MapLibre
  style; omit it for the default Protomaps basemap.
- `https://papers.reearth.land/v/{z}/{x}/{y}.mvt` — Protomaps vector
  tiles, served directly from our mirror.
- `https://papers.reearth.land/style.json` — the default MapLibre
  style. `?theme=light|dark|white|black|grayscale` switches between
  Protomaps' published themes.

## Status

PoC. The end-to-end path is live; expect ~10 s on the first cold
request and 3–7 s thereafter.

See [`CONTRIBUTING.md`](CONTRIBUTING.md) for development and
deployment.
