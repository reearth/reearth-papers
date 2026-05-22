# mirror

Each subdirectory under `mirror/` is a one-source archival pipeline
that lands tile data into the shared `reearth-papers` R2 bucket. The
root Worker (`../src/`) then serves those archives to clients.

| Source              | Cadence  | Build runs on              | R2 prefix                      |
|---------------------|----------|----------------------------|--------------------------------|
| Protomaps           | monthly  | Cloudflare Workflow        | `mirror/protomaps/`            |
| Watercolor          | one-shot | EC2 (us-east-1)            | `mirror/watercolor/`           |
| ESA WorldCover 2021 | one-shot | local (bash + rclone + gdal)| `mirror/esa_worldcover_2021/` |

The split layout exists because the upstreams are fundamentally
different — Protomaps publishes fresh PMTiles archives every day so
we mirror them on a cron, Stamen Watercolor is a frozen historical
raster set copied once from `long-term.cache.maps.stamen.com`, and
ESA WorldCover is a one-shot mirror of an AWS Open Data bucket that's
small enough to drive from a laptop. See each subdirectory's README
for the specifics.
