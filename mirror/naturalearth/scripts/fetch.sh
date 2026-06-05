#!/usr/bin/env bash
# Download and unpack the Natural Earth raster archives into the local
# work directory. Idempotent — `curl -C -` resumes, and the unzip step
# short-circuits when the .tif is already extracted.
#
# Anonymous, no credentials required. NE2_HR_LC_SR_W_DR.zip is ~311 MB.
set -euo pipefail

HERE=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
# shellcheck source=./_lib.sh
. "$HERE/_lib.sh"

command -v curl >/dev/null || { echo "curl required" >&2; exit 1; }
command -v unzip >/dev/null || { echo "unzip required" >&2; exit 1; }

WORK="${WORK:-${HERE}/../.work}"
mkdir -p "$WORK"

for ds in "${DATASETS[@]}"; do
  name=$(dataset_name "$ds")
  zip="${WORK}/${name}.zip"
  tif="${WORK}/${name}.tif"
  if [ -f "$tif" ]; then
    log "${name}.tif already extracted; skipping"
    continue
  fi
  log "fetch ${name}.zip"
  # `--continue-at -` resumes a partial download; combined with
  # `--retry`/`--retry-delay` this survives transient hiccups. `-f`
  # makes HTTP errors exit non-zero.
  curl -fL --retry 5 --retry-delay 5 --continue-at - -o "$zip" \
    "${SRC_ROOT}/${ds}.zip"
  # Archives place the .tif either at the root or under a same-named
  # directory depending on vintage; `-j` flattens both layouts. Not all
  # archives carry every sidecar (OB_50M ships only .tif/.tfw) — unzip
  # exits 11 when a pattern matches nothing, which is fine as long as
  # the .tif landed (checked below).
  log "unzip ${name}.zip"
  unzip -o -j "$zip" '*.tif' '*.tfw' '*.prj' '*.README*' '*VERSION*' \
    -d "$WORK" >/dev/null || [ $? -eq 11 ]
  [ -f "$tif" ] || { echo "expected ${tif} after unzip" >&2; exit 1; }
done

log "all datasets in ${WORK}"
du -h "${WORK}"/*.tif | sort
