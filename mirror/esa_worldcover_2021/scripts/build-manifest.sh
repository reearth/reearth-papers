#!/usr/bin/env bash
# Generate manifest.json listing every 3°×3° tile in the dataset, then
# upload it to R2 via wrangler. Cheap — re-run any time.
#
# Sources are enumerated from the upstream ESA bucket (anonymous read),
# not from R2, so this script needs no R2 credentials. The mirror is
# byte-exact, so the two listings are equivalent.
set -euo pipefail

HERE=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
# shellcheck source=./_lib.sh
. "$HERE/_lib.sh"

command -v jq >/dev/null || { echo "jq required" >&2; exit 1; }

TMP_LIST=$(mktemp -t esa_manifest_list.XXXXXX)
TMP_OUT=$(mktemp -t esa_manifest_out.XXXXXX)
trap 'rm -f "$TMP_LIST" "$TMP_OUT"' EXIT

log "Listing upstream (anonymous): s3://${SRC_BUCKET}/${SRC_PREFIX}/"
rclone lsjson "$SRC_REMOTE" --include "ESA_WorldCover_10m_2021_v200_*_Map.tif" > "$TMP_LIST"

COUNT=$(jq 'length' "$TMP_LIST")
log "Found ${COUNT} tiles; building manifest.json"

GENERATED_AT=$(date -u +"%Y-%m-%dT%H:%M:%SZ")

jq --arg ts "$GENERATED_AT" --arg src "s3://${SRC_BUCKET}/${SRC_PREFIX}/" '
  def parse_grid: capture("(?<ns>[NS])(?<lat>[0-9]{2})(?<ew>[EW])(?<lon>[0-9]{3})_Map\\.tif$");
  {
    generated_at: $ts,
    source: $src,
    product: "ESA WorldCover",
    version: "v200",
    year: 2021,
    resolution_m: 10,
    tile_size_deg: 3,
    license: "CC-BY-4.0",
    attribution: "ESA WorldCover project 2021 / Contains modified Copernicus Sentinel data (2021) processed by ESA WorldCover consortium",
    count: length,
    total_bytes: ([.[].Size] | add),
    tiles: ([
      .[]
      | (.Name | parse_grid) as $g
      | ($g.lat | tonumber) * (if $g.ns == "N" then 1 else -1 end) as $lat_sw
      | ($g.lon | tonumber) * (if $g.ew == "E" then 1 else -1 end) as $lon_sw
      | {
          name: ($g.ns + $g.lat + $g.ew + $g.lon),
          key: .Name,
          size: .Size,
          bbox: [$lon_sw, $lat_sw, $lon_sw + 3, $lat_sw + 3]
        }
    ] | sort_by(.name))
  }
' "$TMP_LIST" > "$TMP_OUT"

log "Uploading manifest.json ($(wc -c < "$TMP_OUT") bytes)"
wrangler_put "$TMP_OUT" "manifest.json" "application/json"
log "done."
