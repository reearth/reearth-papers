# naturalearth

One-shot, reproducible mirror of [Natural Earth](https://www.naturalearthdata.com/)
raster datasets into the shared `reearth-papers` R2 bucket. Each
dataset becomes a single Cloud Optimized GeoTIFF served by the root
Worker as XYZ raster tiles (see `../../src/naturalearth.ts`).

This pipeline runs **locally** — the upstream is a handful of public
CDN zips (50–400 MB each) and the build step (`gdal_translate -of COG`)
is trivially available on a developer laptop. Cloudflare-side execution
would save nothing.

## Datasets

| Upstream name       | R2 COG key              | What it is |
|---------------------|-------------------------|------------|
| `NE1_HR_LC_SR_W_DR` | `ne1_hr_lc_sr_w_dr.tif` | Natural Earth I — satellite-derived land cover in a light natural palette, with shaded relief, water, drainages |
| `NE2_HR_LC_SR_W_DR` | `ne2_hr_lc_sr_w_dr.tif` | Natural Earth II — idealized world environment with softly blended colors, shaded relief, water, drainages |
| `HYP_HR_SR_OB_DR`   | `hyp_hr_sr_ob_dr.tif`   | Cross-blended hypsometric tints with shaded relief, ocean bottom, drainages |
| `GRAY_HR_SR_OB_DR`  | `gray_hr_sr_ob_dr.tif`  | Gray Earth — monochromatic terrain (single-band grayscale) with relief, hypsography, ocean bottom, drainages |
| `OB_50M`            | `ob_50m.tif`            | Ocean Bottom — CleanTOPO2-derived depth colors + relief (1:50m) |

To mirror another raster, append its scale-qualified path to
`DATASETS` in `scripts/_lib.sh`, re-run, and add a registry entry in
`src/naturalearth.ts`.

## Upstream facts

- Host: `naciscdn.org` (NACIS-managed CDN, anonymous read) — the
  download buttons on naturalearthdata.com redirect there
- Files: `https://naciscdn.org/naturalearth/<scale>/raster/<NAME>.zip`,
  each containing `<NAME>.tif` + `.tfw` (and usually `.prj`) sidecars
- Geometry: EPSG:4326, full global extent `[-180, -90, 180, 90]`.
  1:10m HR variants are 21600×10800 px at 1/60° per pixel (~1.85 km at
  the equator); 1:50m is 10800×5400 px at 1/30° per pixel. Most are
  3-band RGB; Gray Earth is single-band grayscale.
- License: **public domain**. No attribution required; we credit
  "Made with Natural Earth" anyway.

## Output (in R2 under `mirror/naturalearth/`)

| Key                      | Source       | Purpose                                |
|--------------------------|--------------|----------------------------------------|
| `<dataset>.tif` (×5)     | this builder | global COG, EPSG:4326, JPEG-in-TIFF, internal overviews |
| `manifest.json`          | this builder | provenance + COG geometry              |

The COGs are the **only** archived form — XYZ tiles are rendered
on-the-fly by the Worker, mirroring the Black Marble pattern.

## Cost (initial run, all in)

| Item                                    | Est.        |
|-----------------------------------------|-------------|
| NACIS CDN GET (~1.2 GB total)           | $0          |
| R2 ingress                              | free        |
| R2 Class A writes (6 PUTs)              | trivial     |
| R2 storage @ $0.015 / GB / mo × ~0.2 GB | **~$0.01 / mo** |

Re-runs are no-ops (the build short-circuits when the COG exists in
R2; set `FORCE=1` to override).

## Prerequisites

- `curl`, `unzip`
- [GDAL](https://gdal.org/) ≥ 3.7 (for the `COG` driver). Install via
  `brew install gdal` or `apt install gdal-bin`.
- `jq`
- `wrangler` (for upload). `npx wrangler` is fine; you just need to be
  logged into the Cloudflare account that owns `reearth-papers`
  (`npx wrangler login`).

No upstream credentials are ever needed — the NACIS CDN is anonymous.
No S3-compatible R2 keys either — uploads go through wrangler.

## Runbook

```bash
cd mirror/naturalearth

# Everything, in order. Idempotent.
./scripts/run-all.sh
```

Or step by step:

```bash
./scripts/fetch.sh           # download + unzip source TIFFs into ./.work/
./scripts/build-cog.sh       # COG per dataset → upload to R2
./scripts/build-manifest.sh  # manifest.json
```

Inputs and intermediates live under `./.work/` (gitignored by virtue
of the dot prefix). Delete `.work/` after the COGs land in R2 — it's
recoverable from the CDN any time.

## Attribution

The Worker route (`src/naturalearth.ts`) advertises:

```
Made with Natural Earth · public domain
```

in the TileJSON `attribution` field and as an `X-Attribution` response
header, so downstream MapLibre clients pick it up automatically.
