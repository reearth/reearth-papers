# mirror

Each subdirectory under `mirror/` is a one-source archival pipeline
that lands tile data into the shared `reearth-papers` R2 bucket. The
root Worker (`../src/`) then serves those archives to clients.

| Source       | Cadence | Build runs on            | R2 prefix              |
|--------------|---------|--------------------------|------------------------|
| Protomaps    | monthly | Cloudflare Workflow      | `mirror/protomaps/`    |
| Watercolor   | one-shot| EC2 (us-east-1)          | `mirror/watercolor/`   |

The split layout exists because the two upstreams are fundamentally
different — Protomaps publishes fresh PMTiles archives every day so
we mirror them on a cron, while Stamen Watercolor is a frozen
historical raster set that we copy once from `long-term.cache.maps.stamen.com`
and never touch again. See each subdirectory's README for the
specifics.
