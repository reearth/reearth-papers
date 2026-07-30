# mirror

Each subdirectory under `mirror/` is a one-source archival pipeline
that lands tile data into the shared `reearth-papers` R2 bucket. The
root Worker (`../src/`) then serves those archives to clients.

| Source              | Cadence  | Build runs on              | R2 prefix                      |
|---------------------|----------|----------------------------|--------------------------------|
| Protomaps           | monthly  | Cloudflare Workflow        | `mirror/protomaps/`            |
| Watercolor          | one-shot | EC2 (us-east-1)            | `mirror/watercolor/`           |
| ESA WorldCover 2021 | one-shot | local (bash + rclone + gdal)| `mirror/esa_worldcover_2021/` |
| Black Marble 2016   | one-shot | local (bash + curl + gdal) | `mirror/blackmarble/`          |
| Natural Earth 10m   | one-shot | local (bash + curl + gdal) | `mirror/naturalearth/`         |
| Natural Earth vector| one-shot | local (bash + gdal + tippecanoe) | `mirror/naturalearth_vector/` |
| Fonts (glyph PBFs)  | one-shot | local (cargo + node)       | `mirror/fonts/`                |

The split layout exists because the upstreams are fundamentally
different — Protomaps publishes fresh PMTiles archives every day so
we mirror them on a cron, Stamen Watercolor is a frozen historical
raster set copied once from `long-term.cache.maps.stamen.com`,
ESA WorldCover is a one-shot mirror of an AWS Open Data bucket that's
small enough to drive from a laptop, Black Marble 2016 is a fixed
set of 8 GeoTIFFs from NASA Earth Observatory mosaicked into a single
COG, Natural Earth (raster) is a set of public-domain global rasters
each translated into its own COG, and Natural Earth (vector) is a
curated multi-scale slice of the same project's vector data built into
a single PMTiles archive with tippecanoe. See each subdirectory's
README for the specifics.
