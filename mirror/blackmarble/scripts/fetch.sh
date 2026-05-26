#!/usr/bin/env bash
# Download the 8 full-resolution Black Marble 2016 GeoTIFF tiles into
# the local work directory. Idempotent — `curl -C -` resumes; if the
# file already matches the upstream Content-Length it short-circuits.
#
# Anonymous, no credentials required. Combined download ~5–7 GB; runs
# once per machine and is then re-used by build-cog.sh.
set -euo pipefail

HERE=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
# shellcheck source=./_lib.sh
. "$HERE/_lib.sh"

command -v curl >/dev/null || { echo "curl required" >&2; exit 1; }

WORK="${WORK:-${HERE}/../.work}"
mkdir -p "$WORK"

for tile in "${SRC_TILES[@]}"; do
  url="${SRC_BASE}/${tile}"
  out="${WORK}/${tile}"
  log "fetch ${tile}"
  # `--continue-at -` resumes a partial download; combined with
  # `--retry`/`--retry-delay` this survives transient hiccups on the
  # multi-GB transfers. `-f` makes HTTP errors exit non-zero.
  curl -fL --retry 5 --retry-delay 5 --continue-at - -o "$out" "$url"
done

log "all 8 tiles in ${WORK}"
du -h "${WORK}"/BlackMarble_2016_*_geo.tif | sort
