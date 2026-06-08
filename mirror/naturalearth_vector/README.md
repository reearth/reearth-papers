# naturalearth_vector

One-shot, reproducible mirror of [Natural Earth](https://www.naturalearthdata.com/)
**vector** data into a set of themed PMTiles archives in the shared
`reearth-papers` R2 bucket. The root Worker serves each as MVT vector
tiles (see `../../src/naturalearth_vector.ts`), each with a ready-made
MapLibre style at `/<id>/style.json`.

This is the vector counterpart to `../naturalearth/` (which mirrors
Natural Earth's *raster* maps as COGs). It runs **locally** — the
upstream is public-domain shapefiles and the build (`ogr2ogr` +
`tippecanoe`) runs in a few minutes on a laptop.

## Themed tilesets

Natural Earth's vector catalogue is broad, so instead of one giant
archive we split it by theme. Splitting keeps any single MVT tile small
(a basemap client pulling `physical` never also pays for road or
bathymetry geometry). Each tileset is built across the Natural Earth
scales that suit its zooms and stitched with `tile-join`:

| Tileset (`<id>.pmtiles`) | Scales → zoom        | Contents |
|--------------------------|----------------------|----------|
| `physical`   | 110m z0–2 · 50m z3–4 · 10m z5–8 | ocean, land, coastline, lakes (+ regional supplements), rivers (+ supplements), glaciated areas, antarctic ice shelves, reefs, playas, minor islands, geographic lines, marine & physical region polys |
| `admin`      | 110m z0–2 · 50m z3–4 · 10m z5–8 | countries, map units/subunits, sovereignty, admin-1 states/provinces, admin-2 counties, land/maritime/disputed boundary lines, pacific groupings |
| `labels`     | 110m z0–2 · 50m z3–4 · 10m z5–8 | populated places, admin-0/1 label points, physical region & elevation label points |
| `landuse`    | 50m z3–4 · 10m z5–8 | urban areas, parks & protected lands (area/line/point) |
| `transport`  | 10m z4–10           | roads (+ N. America), railroads (+ N. America), airports, ports, time zones |
| `bathymetry` | 10m z0–6            | ocean-bottom depth bands, merged into one `bathymetry` layer with a `depth` (m) attribute |

Rows sharing an `out_layer` are merged into one MVT layer (regional
lake/river supplements fold into `lakes`/`rivers`; every bathymetry
band folds into `bathymetry`). The merge goes through an intermediate
GeoPackage so a unified schema results.

The `out_layer` names are the contract with
`src/naturalearth_vector.ts` (`NE_VECTOR_TILESETS[].layers` + the
generated MapLibre style). Editing the curated set is one or more rows
in the `LAYERS` table in `scripts/_lib.sh`, kept in sync with that file.

**Deliberately excluded** as pure duplicates (not extra coverage):
point-of-view country variants (`admin_0_countries_<iso>`), and the
`*_scale_rank` / `*_simple` / `*_lakes` / `*_seams` / `*_to_match` /
`*_names` helper renditions.

## Upstream facts

- Host: `naciscdn.org` (NACIS-managed CDN, anonymous read)
- Files: `https://naciscdn.org/naturalearth/<scale>m/<physical|cultural>/ne_<scale>m_<name>.zip`,
  standard shapefile bundles. A few themes (`parks_and_protected_lands`,
  `bathymetry_all`) ship as one zip holding several shapefiles — the
  scripts handle that (see `zip_suffix` / `unit_glob` in `_lib.sh`).
- Geometry: EPSG:4326, full global extent
- License: **public domain**. No attribution required; we credit
  "Made with Natural Earth" anyway.

## Output (in R2 under `mirror/naturalearth_vector/`)

| Key                  | Source       | Purpose                              |
|----------------------|--------------|--------------------------------------|
| `<tileset>.pmtiles` (×6) | this builder | the themed MVT archives          |
| `manifest.json`      | this builder | provenance + per-tileset zoom range + layer→source map |

The archives are treated as immutable by the Worker (cached hard at the
edge). `build-tiles.sh` skips a tileset whose `<id>.pmtiles` already
exists in R2; `FORCE=1` rebuilds all, and `ONLY="physical admin"` limits
to specific ones.

## Prerequisites

- `curl`, `unzip`, `jq`
- [GDAL](https://gdal.org/) ≥ 3.7 (`ogr2ogr`). `brew install gdal`.
- [tippecanoe](https://github.com/felt/tippecanoe) ≥ 2.x (ships
  `tile-join`, writes PMTiles natively). `brew install tippecanoe`.
- [`pmtiles`](https://github.com/protomaps/go-pmtiles) CLI (manifest
  header read). `brew install pmtiles`.
- `wrangler` (upload, via `npx`). Be logged into the Cloudflare account
  that owns `reearth-papers` (`npx wrangler login`). Uploads use
  `wrangler r2 object put --remote` — no S3 keys needed.

## Runbook

```bash
cd mirror/naturalearth_vector

# Everything, in order. Idempotent.
./scripts/run-all.sh
```

Or step by step:

```bash
./scripts/fetch.sh                 # download + unzip every source shapefile → ./.work/src
./scripts/build-tiles.sh           # per tileset: ogr2ogr → tippecanoe → tile-join → upload
./scripts/build-manifest.sh        # manifest.json

FORCE=1 ./scripts/build-tiles.sh             # rebuild all
ONLY="transport" FORCE=1 ./scripts/build-tiles.sh   # rebuild just one
MAX_TILE_BYTES=250000 ./scripts/build-tiles.sh      # tighter per-tile size cap
```

Inputs and intermediates live under `./.work/` (gitignored). Delete it
after the archives land — it's recoverable from the CDN any time.

## Attribution

The Worker routes advertise:

```
Made with Natural Earth · public domain
```

in each TileJSON `attribution`, the MVT `X-Attribution` response header,
and the bundled MapLibre styles.
