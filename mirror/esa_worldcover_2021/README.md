# esa_worldcover_2021

One-shot, reproducible mirror of the
[ESA WorldCover 2021 v200](https://esa-worldcover.org) land-cover
dataset into the shared `reearth-papers` R2 bucket. The output is
served by the root `reearth-papers` Worker as XYZ raster tiles
(implementation lives separately under `../../src/`).

Unlike `../protomaps/` (Cloudflare Workflow, monthly) and
`../watercolor/` (one-shot on EC2), this pipeline runs **locally**.
Sources are public AWS Open Data, R2 ingress is free, and the only
non-trivial step (the overview-COG build) needs GDAL — which is
trivially available on a developer laptop and impossible on Workers.
Cloudflare-side execution would save ~nothing and add a lot of
plumbing.

## Upstream facts

- Bucket: `s3://esa-worldcover/v200/2021/map/` (eu-central-1)
- Auth: **anonymous read**, sponsored by AWS Open Data Program
- Files: **2,651** GeoTIFFs, **~124 GB** total
- Each file: COG, EPSG:4326, 3°×3°, 36000×36000 px (~10 m / pixel),
  Byte palette band, 6 internal overviews down to 562×562
- Naming: `ESA_WorldCover_10m_2021_v200_{N|S}LLD{E|W}LLLM_Map.tif`,
  where the grid token is the **SW corner** of the 3° tile
- Coverage: global land, latitude bands **N81 down to S60** (no tile
  at sea or above the polar tree line)
- License: CC BY 4.0

## Output (in R2 under `mirror/esa_worldcover_2021/`)

| Key                                                  | Source       | Purpose                       |
|------------------------------------------------------|--------------|-------------------------------|
| `ESA_WorldCover_10m_2021_v200_*_Map.tif` (×2,651)    | upstream S3  | per-3° high-res sources       |
| `overview.tif`                                       | this builder | ~1.7 km/px global mosaic COG, served at low Web Mercator zooms |
| `manifest.json`                                      | this builder | tile inventory (name, bbox, size) + `generated_at` |

Attribution is enforced at serve time by the Worker (TileJSON /
response headers) — we don't drop a `LICENSE.txt` in the bucket
because nothing crawls it.

## Cost (initial run, all in)

| Item                                          | Est.     |
|-----------------------------------------------|----------|
| ESA S3 GET ×2,651 (AWS Open Data, free)       | $0       |
| Local ↔ AWS / R2 bandwidth (your network)     | 124 GB   |
| R2 ingress                                    | free     |
| R2 Class A writes (~2,653 PUTs)               | ~$0.01   |
| R2 storage @ $0.015 / GB / mo × ~124 GB       | ~$1.9/mo |
| **Total compute / fees**                      | **~$0.01 one-off + ~$2/mo storage** |

Re-runs are no-ops (size-only diff) — typically a few seconds.

## Prerequisites

- [`rclone`](https://rclone.org/) ≥ 1.65 (anonymous S3 reads via
  inline backend syntax)
- [GDAL](https://gdal.org/) ≥ 3.7 (for the `COG` driver and
  `/vsis3/`). Install via `brew install gdal` or
  `apt install gdal-bin`.
- `jq`
- `wrangler` — used for the small uploads (manifest, overview).
  `npx wrangler` is fine; you just need to be logged into the
  Cloudflare account that owns the `reearth-papers` bucket
  (`npx wrangler login`).
- **Only for the bulk mirror step**: an R2 S3-compatible API token
  (Object Read & Write, scoped to `reearth-papers`), set via env
  vars below. If those vars are unset, `run-all.sh` skips
  `mirror.sh` and only refreshes the derived artefacts.

## Environment

```bash
# Required for build-manifest.sh / build-overview.sh: just
# `wrangler login` once. No env vars.

# Required only for the bulk mirror.sh step:
export CLOUDFLARE_ACCOUNT_ID=...
export R2_ACCESS_KEY_ID=...
export R2_SECRET_ACCESS_KEY=...

# Optional overrides:
export R2_BUCKET=reearth-papers
export R2_PREFIX=mirror/esa_worldcover_2021
export TRANSFERS=16            # rclone --transfers (mirror.sh)
export CHECKERS=32             # rclone --checkers  (mirror.sh)
export OVERVIEW_TR=0.016       # target resolution in degrees (build-overview.sh)
export FORCE=1                 # rebuild overview.tif even if it exists
```

No upstream credentials are ever needed — the ESA bucket is
anonymous-read.

## Runbook

```bash
cd mirror/esa_worldcover_2021

# Everything, in order. Idempotent. mirror.sh is auto-skipped when
# R2 keys aren't set in the environment.
./scripts/run-all.sh
```

Or step by step:

```bash
./scripts/mirror.sh            # S3 → R2 bulk sync (heavy on first run, no-op after)
./scripts/build-manifest.sh    # Upstream list → manifest.json → R2 (via wrangler)
./scripts/build-overview.sh    # /vsis3/ mosaic → overview.tif → R2 (via wrangler)
```

The overview build does **not** download the full 124 GB — GDAL reads
only the internal pyramids of each source via HTTP Range, totalling a
few hundred MB. Expect 10–30 minutes wall time depending on your
network.

## Attribution

Any Worker route or downstream product derived from this mirror MUST
carry:

```
© ESA WorldCover project 2021 / Contains modified Copernicus Sentinel
data (2021) processed by ESA WorldCover consortium
```

The serving endpoint (Worker, separately) should advertise it via
`License` / `X-Attribution` headers and embed it in any TileJSON /
MapLibre style that uses the layer.
