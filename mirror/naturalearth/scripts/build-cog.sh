#!/usr/bin/env bash
# Translate each Natural Earth raster into a Cloud Optimized GeoTIFF
# and upload it to R2 under its lowercased upstream name.
#
# Projection kept as EPSG:4326 (matches both the source and the rest
# of this repo's serve-side reprojection convention — see
# `src/naturalearth.ts`, which inverts Web Mercator per output pixel).
#
# Skips datasets whose output already exists in R2; set FORCE=1 to
# rebuild.
set -euo pipefail

HERE=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
# shellcheck source=./_lib.sh
. "$HERE/_lib.sh"

command -v gdal_translate >/dev/null || { echo "GDAL (gdal_translate) required" >&2; exit 1; }

WORK="${WORK:-${HERE}/../.work}"
mkdir -p "$WORK"

for ds in "${DATASETS[@]}"; do
  name=$(dataset_name "$ds")
  out_key=$(cog_key "$ds")
  if [ -z "${FORCE:-}" ] && wrangler_exists "$out_key"; then
    log "${out_key} already exists in R2 (set FORCE=1 to rebuild); skipping"
    continue
  fi

  src="${WORK}/${name}.tif"
  [ -f "$src" ] || { echo "missing ${src} — run fetch.sh first" >&2; exit 1; }
  out="${WORK}/${out_key}"

  # COG params — same rationale as mirror/blackmarble/scripts/build-cog.sh:
  #   COMPRESS=JPEG @ QUALITY=85 — the Natural Earth rasters are
  #       photographic-style blended imagery (land cover + shaded
  #       relief), exactly JPEG's sweet spot. The COG driver implicitly
  #       switches photometry to YCbCr for 3-band JPEG.
  #   BLOCKSIZE=512 — COG-standard, good balance for HTTP range reads.
  #   OVERVIEWS=AUTO + LANCZOS — half-resolution pyramid (21600 →
  #       10800 → … → 338 px) so the worker can pick an IFD that
  #       matches the requested Web Mercator zoom without oversampling.
  #   -a_srs EPSG:4326 — the upstream georeference comes from .tfw/.prj
  #       sidecars; stamping the CRS makes the COG self-contained.
  log "Translating ${name}.tif to COG (JPEG q85, internal overviews)"
  gdal_translate "$src" "$out" \
    -of COG \
    -a_srs EPSG:4326 \
    -co COMPRESS=JPEG \
    -co QUALITY=85 \
    -co BLOCKSIZE=512 \
    -co OVERVIEWS=AUTO \
    -co OVERVIEW_RESAMPLING=LANCZOS \
    -co BIGTIFF=IF_SAFER \
    --config GDAL_CACHEMAX 2048

  log "Uploading ${out_key} ($(du -h "$out" | cut -f1)) → R2"
  wrangler_put "$out" "$out_key" "image/tiff"
done

log "done."
