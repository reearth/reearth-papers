#!/usr/bin/env bash
# Mirror ESA WorldCover 2021 v200 source COGs from AWS Open Data into R2.
#
# This is the only script that needs S3-compatible R2 keys (bulk sync
# via rclone). build-manifest.sh / build-overview.sh upload through
# wrangler instead, so day-to-day re-runs don't need keys at all.
#
# Idempotent: rclone --size-only skips files already present byte-exact.
# A first full run transfers ~124 GB / 2,651 files; re-runs are no-ops.
set -euo pipefail

HERE=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
# shellcheck source=./_lib.sh
. "$HERE/_lib.sh"
require_r2_keys

log "Mirroring s3://${SRC_BUCKET}/${SRC_PREFIX}/ → ${R2_BUCKET}/${R2_PREFIX}/"
log "(files with matching size in R2 are skipped — re-runs are cheap)"

rclone copy "$SRC_REMOTE" "$DST_REMOTE" \
  --include "ESA_WorldCover_10m_2021_v200_*_Map.tif" \
  --size-only \
  --transfers "${TRANSFERS:-16}" \
  --checkers "${CHECKERS:-32}" \
  --s3-no-head \
  --progress
