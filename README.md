# Re:Earth Papers

A tile service that renders OpenStreetMap (via Protomaps) into beautiful
raster tiles across a curated set of styles.

## Endpoints

- `https://papers.reearth.land/` — interactive preview page.
- `https://papers.reearth.land/styles/{theme}/tile/{z}/{x}/{y}.png` —
  rendered raster tile.
- `https://papers.reearth.land/styles/{theme}/tilejson.json` —
  TileJSON 3.0.0 for the raster tiles (includes attribution).
- `https://papers.reearth.land/styles/{theme}/style.json` — MapLibre
  style document with the theme baked in.
- `https://papers.reearth.land/v/{z}/{x}/{y}.mvt` — Protomaps vector
  tiles, served directly from our mirror.
- `https://papers.reearth.land/v/tilejson.json` — TileJSON for the
  vector tiles.
- `https://papers.reearth.land/watercolor/{z}/{x}/{y}.jpg` — Stamen
  Watercolor raster tiles (mirrored, frozen historical set).
- `https://papers.reearth.land/watercolor/tilejson.json` — TileJSON
  for the watercolor tiles.
- `https://papers.reearth.land/catalog.json` — machine-readable index
  of every tileset exposed by the service (raster themes, vector,
  watercolor), with the TileJSON / style.json URL for each.

`{theme}` is one of `light`, `dark`, `white`, `black`, `grayscale`.

## Attribution

Any product using these tiles must display:

> Re:Earth Papers · Protomaps · © OpenStreetMap contributors

The TileJSON / style.json documents above carry this in their
`attribution` field already; most map clients render it automatically.

## Status

PoC. The end-to-end path is live; expect ~10 s on the first cold
request and 3–7 s thereafter. Subsequent renders of cached tiles are
served from CF's edge cache (Cache API) or R2 in well under a second.

See [`CONTRIBUTING.md`](CONTRIBUTING.md) for development and
deployment.
