#!/usr/bin/env bash
# Build a single low-resolution mosaic COG covering all sources, and
# upload it as overview.tif via wrangler. Used by the Worker for low
# Web Mercator zooms (≈z0–7) where reading hundreds of per-3° COGs
# would be prohibitive.
#
# Reads sources directly from ESA's public S3 via /vsis3/ (anonymous,
# free egress). Only the overview pyramids inside each source COG are
# fetched (≈hundreds of MB total), not the full 124 GB.
#
# Skips if overview.tif already exists in R2; set FORCE=1 to rebuild.
# No R2 credentials needed — uploads through wrangler.
set -euo pipefail

HERE=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
# shellcheck source=./_lib.sh
. "$HERE/_lib.sh"

command -v gdalbuildvrt >/dev/null || { echo "GDAL (gdalbuildvrt) required" >&2; exit 1; }
command -v gdal_translate >/dev/null || { echo "GDAL (gdal_translate) required" >&2; exit 1; }

if [ -z "${FORCE:-}" ] && wrangler_exists "overview.tif"; then
  log "overview.tif already exists in R2 (set FORCE=1 to rebuild); skipping"
  exit 0
fi

WORK="${WORK:-${HERE}/../.work}"
mkdir -p "$WORK"
LIST="$WORK/sources.txt"
VRT="$WORK/sources.vrt"
OUT="$WORK/overview.tif"

log "Enumerating sources from upstream (anonymous)"
rclone lsf "$SRC_REMOTE" --include "ESA_WorldCover_10m_2021_v200_*_Map.tif" \
  | awk -v p="/vsis3/${SRC_BUCKET}/${SRC_PREFIX}" '{ print p "/" $0 }' \
  > "$LIST"
COUNT=$(wc -l < "$LIST" | tr -d ' ')
log "Sources: ${COUNT}"

# GDAL /vsis3/ env. AWS_NO_SIGN_REQUEST=YES + AWS_REGION lets us read
# the Open Data bucket anonymously. VSI_CACHE keeps repeated header
# reads from hammering S3.
export AWS_NO_SIGN_REQUEST=YES
export AWS_REGION="${SRC_REGION}"
export GDAL_DISABLE_READDIR_ON_OPEN=EMPTY_DIR
export VSI_CACHE=TRUE
export VSI_CACHE_SIZE=536870912
export GDAL_HTTP_MULTIPLEX=YES
export GDAL_HTTP_VERSION=2
export CPL_VSIL_CURL_USE_HEAD=NO

log "Building VRT mosaic"
gdalbuildvrt -input_file_list "$LIST" "$VRT" >/dev/null

# Target resolution: 0.016° ≈ 1.78 km/px at the equator. World extent
# (-180,-60,180,84) → ≈22500 × 9000 pixels. Plenty for z0–7 (z7 needs
# ≤313 m/px) and the output compresses well because the values are a
# small classified palette.
TR="${OVERVIEW_TR:-0.016}"
log "Generating overview COG @ ${TR}° (~$(awk -v t=$TR 'BEGIN{printf "%.2f", 111*t}') km/px)"
gdal_translate "$VRT" "$OUT" \
  -of COG \
  -tr "$TR" "$TR" \
  -r nearest \
  -projwin -180 84 180 -60 \
  -co COMPRESSION=DEFLATE \
  -co LEVEL=9 \
  -co PREDICTOR=NO \
  -co BLOCKSIZE=512 \
  -co OVERVIEWS=AUTO \
  -co OVERVIEW_RESAMPLING=NEAREST \
  --config GDAL_CACHEMAX 2048

log "Uploading overview.tif ($(du -h "$OUT" | cut -f1)) → R2"
wrangler_put "$OUT" "overview.tif" "image/tiff"
log "done. local copy: $OUT"
