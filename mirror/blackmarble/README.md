# blackmarble

One-shot, reproducible mirror of NASA Earth Observatory's
[**Earth at Night 2016** ("Black Marble")](https://science.nasa.gov/earth/earth-observatory/earth-at-night/maps)
into the shared `reearth-papers` R2 bucket. The output is a single
Cloud Optimized GeoTIFF served by the root Worker as XYZ raster
tiles (see `../../src/blackmarble.ts`).

This pipeline runs **locally** — the upstream is a fixed set of 8
public CDN files at `assets.science.nasa.gov`, total ~5–7 GB, and the
build step (`gdal_translate -of COG`) is trivially available on a
developer laptop. Cloudflare-side execution would save nothing.

## Upstream facts

- Host: `assets.science.nasa.gov` (NASA-managed CDN, anonymous read)
- Image record: `144000/144898` (Visible Earth id 144898, now hosted
  under `science.nasa.gov/earth/earth-observatory/earth-at-night/maps`)
- Files: **8 GeoTIFFs**, each `BlackMarble_2016_{A..D}{1..2}_geo.tif`
- Per-tile geometry: 21600×21600 px, EPSG:4326, 500 m / pixel
  (1/240°), laid out 4 cols × 2 rows
- Combined mosaic: 86400×43200 px, full global extent
  (`[-180, -90, 180, 90]`)
- License: produced by NASA / NOAA; in the public domain. Credit
  "NASA Earth Observatory / Suomi NPP VIIRS".

## Output (in R2 under `mirror/blackmarble/`)

| Key                       | Source       | Purpose                                |
|---------------------------|--------------|----------------------------------------|
| `black_marble_2016.tif`   | this builder | global COG, EPSG:4326, JPEG-in-TIFF, internal overviews |
| `manifest.json`           | this builder | provenance + COG geometry              |

The COG is the **only** archived form — XYZ tiles are rendered
on-the-fly by the Worker, mirroring the ESA WorldCover pattern. If
runtime CPU costs ever become a concern we can pre-bake a PMTiles
derivative from this same COG.

## Cost (initial run, all in)

| Item                                    | Est.        |
|-----------------------------------------|-------------|
| NASA CDN GET ×8 (~5–7 GB total)         | $0          |
| Your network ↔ NASA, ↔ R2               | one-shot    |
| R2 ingress                              | free        |
| R2 Class A writes (2 PUTs)              | trivial     |
| R2 storage @ $0.015 / GB / mo × ~1 GB   | **~$0.02 / mo** |

Re-runs are no-ops (the build short-circuits when the COG exists in
R2; set `FORCE=1` to override).

## Prerequisites

- `curl`
- [GDAL](https://gdal.org/) ≥ 3.7 (for the `COG` driver). Install via
  `brew install gdal` or `apt install gdal-bin`.
- `jq`
- `wrangler` (for upload). `npx wrangler` is fine; you just need to be
  logged into the Cloudflare account that owns `reearth-papers`
  (`npx wrangler login`).

No upstream credentials are ever needed — the NASA CDN is anonymous.
No S3-compatible R2 keys either — uploads go through wrangler.

## Runbook

```bash
cd mirror/blackmarble

# Everything, in order. Idempotent.
./scripts/run-all.sh
```

Or step by step:

```bash
./scripts/fetch.sh           # download 8 source TIFFs into ./.work/
./scripts/build-cog.sh       # mosaic + COG → upload as black_marble_2016.tif
./scripts/build-manifest.sh  # manifest.json
```

The 8 input tiles weigh ~5–7 GB and live under `./.work/` (gitignored
by virtue of the dot prefix). Delete `.work/` after the COG lands in
R2 — it's recoverable from the CDN any time.

## Attribution

The Worker route (`src/blackmarble.ts`) advertises:

```
NASA Earth Observatory · Suomi NPP VIIRS · Black Marble 2016
```

in the TileJSON `attribution` field and as an `X-Attribution` response
header, so downstream MapLibre clients pick it up automatically.
