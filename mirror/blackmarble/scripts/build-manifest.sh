#!/usr/bin/env bash
# Write a small manifest.json describing the mirrored Black Marble
# archive — generated_at, source URLs, COG geometry — and upload it
# next to the COG. Lets downstream tools introspect what's in R2
# without parsing the GeoTIFF.
set -euo pipefail

HERE=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
# shellcheck source=./_lib.sh
. "$HERE/_lib.sh"

command -v jq >/dev/null || { echo "jq required" >&2; exit 1; }

GENERATED_AT=$(date -u +"%Y-%m-%dT%H:%M:%SZ")
TMP=$(mktemp -t blackmarble_manifest.XXXXXX)
trap 'rm -f "$TMP"' EXIT

jq -n \
  --arg ts "$GENERATED_AT" \
  --arg base "$SRC_BASE" \
  --argjson tiles "$(printf '%s\n' "${SRC_TILES[@]}" | jq -R . | jq -s .)" '
{
  generated_at: $ts,
  product: "Black Marble 2016 (Earth at Night)",
  source_page: "https://science.nasa.gov/earth/earth-observatory/earth-at-night/maps",
  source_base: $base,
  source_tiles: $tiles,
  cog: {
    key: "black_marble_2016.tif",
    crs: "EPSG:4326",
    width: 86400,
    height: 43200,
    resolution_deg: (1/240),
    resolution_m_equator: 463.83,
    bbox: [-180, -90, 180, 90]
  },
  license: "public domain (NASA Earth Observatory)",
  attribution: "NASA Earth Observatory / Suomi NPP VIIRS"
}
' > "$TMP"

log "Uploading manifest.json ($(wc -c < "$TMP") bytes)"
wrangler_put "$TMP" "manifest.json" "application/json"
log "done."
