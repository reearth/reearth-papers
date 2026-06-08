#!/usr/bin/env bash
# Download and unpack every Natural Earth vector archive the build needs
# into ./.work/src. Idempotent — `curl -C -` resumes, and each unit
# short-circuits once its shapefile(s) are extracted.
#
# Anonymous, no credentials required. The full themed set is a few
# hundred MB (the 10m roads/counties/admin shapefiles dominate).
set -euo pipefail

HERE=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
# shellcheck source=./_lib.sh
. "$HERE/_lib.sh"

command -v curl >/dev/null || { echo "curl required" >&2; exit 1; }
command -v unzip >/dev/null || { echo "unzip required" >&2; exit 1; }

WORK="${WORK:-${HERE}/../.work}"
export SRC="${WORK}/src"
mkdir -p "$SRC"

# Has this unit already been extracted? Bundles (bathymetry, parks)
# unpack to several shapefiles, so probe by the unit's glob.
unit_extracted() { ls "${SRC}"/$(unit_glob "$1") >/dev/null 2>&1; }

while IFS= read -r unit; do
  name=$(ne_basename "$unit")
  zip="${SRC}/${name}.zip"
  if unit_extracted "$unit"; then
    log "${name} already extracted; skipping"
    continue
  fi
  log "fetch ${name}.zip"
  curl -fL --retry 5 --retry-delay 5 --continue-at - -o "$zip" "$(ne_url "$unit")"
  log "unzip ${name}.zip"
  # `-j` flattens any per-archive subdirectory; Natural Earth ships the
  # full shapefile sidecar set (.shp/.shx/.dbf/.prj/.cpg). Bundles like
  # bathymetry_all / parks carry many shapefiles — extract them all.
  unzip -o -j "$zip" '*.shp' '*.shx' '*.dbf' '*.prj' '*.cpg' -d "$SRC" >/dev/null || [ $? -eq 11 ]
  unit_extracted "$unit" || { echo "expected shapefile(s) for ${name} after unzip" >&2; exit 1; }
done < <(download_units)

log "all source shapefiles in ${SRC}"
