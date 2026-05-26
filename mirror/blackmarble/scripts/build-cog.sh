#!/usr/bin/env bash
# Mosaic the 8 Black Marble 2016 tiles into a single Cloud Optimized
# GeoTIFF and upload it to R2 as `black_marble_2016.tif`.
#
# Projection kept as EPSG:4326 (matches both the source and the rest
# of this repo's serve-side reprojection convention — see
# `src/blackmarble.ts`, which inverts Web Mercator per output pixel).
#
# Skips if the output already exists in R2; set FORCE=1 to rebuild.
set -euo pipefail

HERE=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
# shellcheck source=./_lib.sh
. "$HERE/_lib.sh"

command -v gdalbuildvrt >/dev/null || { echo "GDAL (gdalbuildvrt) required" >&2; exit 1; }
command -v gdal_translate >/dev/null || { echo "GDAL (gdal_translate) required" >&2; exit 1; }

OUT_KEY="black_marble_2016.tif"
if [ -z "${FORCE:-}" ] && wrangler_exists "$OUT_KEY"; then
  log "${OUT_KEY} already exists in R2 (set FORCE=1 to rebuild); skipping"
  exit 0
fi

WORK="${WORK:-${HERE}/../.work}"
mkdir -p "$WORK"
VRT="${WORK}/mosaic.vrt"
OUT="${WORK}/${OUT_KEY}"

# Verify inputs exist; nudge toward fetch.sh if not.
missing=0
for tile in "${SRC_TILES[@]}"; do
  if [ ! -f "${WORK}/${tile}" ]; then
    echo "missing ${WORK}/${tile} — run fetch.sh first" >&2
    missing=1
  fi
done
[ "$missing" = "0" ] || exit 1

log "Building VRT mosaic from 8 tiles"
gdalbuildvrt "$VRT" "${WORK}"/BlackMarble_2016_*_geo.tif >/dev/null

# COG params:
#   COMPRESS=JPEG @ QUALITY=85 — photographic RGB, nightscape is mostly
#       black with sparse highlights so JPEG handles it cleanly and
#       drops the artefact size by ~10× vs. DEFLATE. The COG driver
#       implicitly switches photometry to YCbCr for 3-band JPEG, so
#       no explicit PHOTOMETRIC option is needed (and setting it
#       triggers a "driver does not support" warning).
#   BLOCKSIZE=512 — COG-standard, good balance for HTTP range reads.
#   OVERVIEWS=AUTO + LANCZOS — half-resolution pyramid down to ~tile
#       size, so the worker can pick an IFD that matches the requested
#       Web Mercator zoom without oversampling.
#   BIGTIFF=IF_SAFER — base raster is 86400×43200×3 ≈ 11 GiB raw, well
#       past the 4 GiB classic-TIFF cap. JPEG-compressed output ends up
#       smaller, but the intermediate planes during translate aren't.
log "Translating to COG (JPEG q85, internal overviews)"
gdal_translate "$VRT" "$OUT" \
  -of COG \
  -co COMPRESS=JPEG \
  -co QUALITY=85 \
  -co BLOCKSIZE=512 \
  -co OVERVIEWS=AUTO \
  -co OVERVIEW_RESAMPLING=LANCZOS \
  -co BIGTIFF=IF_SAFER \
  --config GDAL_CACHEMAX 2048

log "Uploading ${OUT_KEY} ($(du -h "$OUT" | cut -f1)) → R2"
wrangler_put "$OUT" "$OUT_KEY" "image/tiff"
log "done. local copy: $OUT"
