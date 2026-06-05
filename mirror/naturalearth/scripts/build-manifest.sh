#!/usr/bin/env bash
# Write a small manifest.json describing the mirrored Natural Earth
# archives — generated_at, source URLs, per-COG geometry (read from the
# local COGs via gdalinfo) — and upload it next to the COGs. Lets
# downstream tools introspect what's in R2 without parsing GeoTIFFs.
set -euo pipefail

HERE=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
# shellcheck source=./_lib.sh
. "$HERE/_lib.sh"

command -v jq >/dev/null || { echo "jq required" >&2; exit 1; }
command -v gdalinfo >/dev/null || { echo "GDAL (gdalinfo) required" >&2; exit 1; }

WORK="${WORK:-${HERE}/../.work}"

GENERATED_AT=$(date -u +"%Y-%m-%dT%H:%M:%SZ")
TMP=$(mktemp -t naturalearth_manifest.XXXXXX)
trap 'rm -f "$TMP"' EXIT

cogs="[]"
for name in "${DATASETS[@]}"; do
  out_key=$(cog_key "$name")
  cog="${WORK}/${out_key}"
  [ -f "$cog" ] || { echo "missing ${cog} — run build-cog.sh first" >&2; exit 1; }
  info=$(gdalinfo -json "$cog")
  cogs=$(jq -n \
    --argjson cogs "$cogs" \
    --arg key "$out_key" \
    --arg src "${SRC_BASE}/${name}.zip" \
    --argjson info "$info" '
    $cogs + [{
      key: $key,
      source: $src,
      crs: "EPSG:4326",
      width: $info.size[0],
      height: $info.size[1],
      resolution_deg: $info.geoTransform[1],
      bbox: ($info.cornerCoordinates | [
        .upperLeft[0], .lowerRight[1], .lowerRight[0], .upperLeft[1]
      ])
    }]')
done

jq -n \
  --arg ts "$GENERATED_AT" \
  --arg base "$SRC_BASE" \
  --argjson cogs "$cogs" '
{
  generated_at: $ts,
  product: "Natural Earth 1:10m raster (NACIS CDN)",
  source_page: "https://www.naturalearthdata.com/downloads/10m-raster-data/",
  source_base: $base,
  cogs: $cogs,
  license: "public domain (Natural Earth)",
  attribution: "Made with Natural Earth"
}
' > "$TMP"

log "Uploading manifest.json ($(wc -c < "$TMP") bytes)"
wrangler_put "$TMP" "manifest.json" "application/json"
log "done."
