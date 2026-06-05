# Re:Earth Papers

A tile service for beautiful, openly-licensed maps of the world:
OpenStreetMap rendered into a curated set of raster styles, plus a
growing shelf of global basemaps and thematic layers (Natural Earth,
NASA, ESA, Stamen) mirrored into R2 and served — or rendered on the
fly from COGs — at the edge.

Browse everything at **<https://papers.reearth.land/viewer>**.

## Endpoints

Every tileset is reachable through the same URL shapes (`{id}` values
are listed in the table below):

| URL | What it is |
|---|---|
| `/catalog.json` | Machine-readable index of every tileset: TileJSON URL, MapLibre style (themes), and the `source` archive URL where one exists. |
| `/{id}/tilejson.json` | TileJSON 3.0.0 (`?format=png\|webp` on multi-format rasters; default `webp`). |
| `/{id}/{z}/{x}/{y}.{ext}` | XYZ tiles in the tileset's format(s). |
| `/{id}.{tif,pmtiles}` | The underlying single-file archive, with HTTP Range support — see [Direct archive access](#direct-archive-access). |
| `/styles/{theme}/tile/{z}/{x}/{y}.png` | Rendered OSM raster tile. `{theme}` ∈ `light dark white black grayscale`. |
| `/styles/{theme}/tilejson.json` | TileJSON for a rendered theme. |
| `/styles/{theme}/style.json` | The theme's full MapLibre style, for client-side vector rendering. |
| `/viewer` | Interactive preview of all of the above. |

All responses are CORS-open (`access-control-allow-origin: *`).

## Tilesets

| `{id}` | Dataset | Format | Native max zoom | Archive | License |
|---|---|---|---|---|---|
| `styles/{theme}` | OpenStreetMap via Protomaps, 5 rendered themes | `png` | 15 | — | © OpenStreetMap contributors |
| `protomaps` | Protomaps daily basemap, mirrored monthly | `mvt` | 15 | `protomaps.pmtiles` | © OpenStreetMap contributors |
| `watercolor` | Stamen Watercolor (frozen historical set) | `jpg` | 18 | `watercolor.pmtiles` | CC BY 4.0 |
| `esa_worldcover_2021` | ESA WorldCover 2021 v200 — 10 m land cover | `webp` `png` | 13 | — | CC BY 4.0 |
| `blackmarble` | NASA Black Marble 2016 — Earth at night | `webp` `png` | 8 | `blackmarble.tif` | public domain |
| `ne1` | Natural Earth I — natural-palette land cover + relief | `webp` `png` | 6 | `ne1.tif` | public domain |
| `ne2` | Natural Earth II — idealized pre-modern world | `webp` `png` | 6 | `ne2.tif` | public domain |
| `hypso` | Cross-blended hypsometric tints + relief + ocean bottom | `webp` `png` | 6 | `hypso.tif` | public domain |
| `grayearth` | Gray Earth — monochrome terrain | `webp` `png` | 6 | `grayearth.tif` | public domain |
| `oceanbottom` | Ocean Bottom — CleanTOPO2 depth colors (1:50m) | `webp` `png` | 5 | `oceanbottom.tif` | public domain |
| `bluemarble` | NASA Blue Marble — passthrough to NASA GIBS WMTS | `jpeg` (upstream) | 8 | — | public domain |
| `s2cloudless_2016` | EOX Sentinel-2 cloudless 2016 — passthrough to EOX WMTS | `jpg` (upstream) | 14 | — | CC BY 4.0 |

Clients overzoom past each native max zoom automatically. Passthrough
tilesets are TileJSON-only: the tiles are served by the upstream
provider, not by us.

The registry behind this table lives in
[`src/tilesets.ts`](src/tilesets.ts) — adding a dataset is one entry
there (plus a mirror pipeline under [`mirror/`](mirror/README.md) if
we host the bytes).

## Direct archive access

Datasets backed by exactly one COG or PMTiles archive expose the file
itself with HTTP Range support, so cloud-native GIS clients can skip
the tile pipeline entirely:

```sh
# Open a COG straight from the service with GDAL / QGIS
gdalinfo /vsicurl/https://papers.reearth.land/ne2.tif

# Or consume a PMTiles archive in MapLibre via the pmtiles protocol
pmtiles://https://papers.reearth.land/watercolor.pmtiles
```

## Attribution

Each tileset carries its required attribution in the TileJSON / style
`attribution` field — most map clients render it automatically. If
yours doesn't, display the attribution for the tilesets you use (e.g.
for the rendered themes: *Re:Earth Papers · Protomaps ·
© OpenStreetMap contributors*).

## Status

PoC, but the end-to-end path is live. The rendered OSM themes go
through a maplibre-native container: expect ~10 s on the first cold
tile and 3–7 s while warm. Everything else is served or rendered
in-Worker and is fast from the first request. Cached tiles come from
Cloudflare's edge cache (or R2 for the persisted tilesets) in well
under a second.

See [`CONTRIBUTING.md`](CONTRIBUTING.md) for architecture, local
development, and deployment, and [`mirror/README.md`](mirror/README.md)
for how the datasets get into R2.
