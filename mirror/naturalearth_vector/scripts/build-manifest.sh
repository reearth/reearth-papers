#!/usr/bin/env bash
# Write a manifest.json describing the themed Natural Earth vector
# archives — generated_at, source base, and per-tileset zoom range +
# layer→source mapping (header read from the local PMTiles via
# `pmtiles show`) — and upload it next to the archives.
set -euo pipefail

HERE=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
# shellcheck source=./_lib.sh
. "$HERE/_lib.sh"

command -v jq >/dev/null || { echo "jq required" >&2; exit 1; }
command -v pmtiles >/dev/null || { echo "pmtiles CLI required" >&2; exit 1; }

WORK="${WORK:-${HERE}/../.work}"

GENERATED_AT=$(date -u +"%Y-%m-%dT%H:%M:%SZ")
TMP=$(mktemp -t naturalearth_vector_manifest.XXXXXX)
trap 'rm -f "$TMP"' EXIT

tilesets_json="[]"
for tileset in "${TILESETS[@]}"; do
  pm="${WORK}/${tileset}.pmtiles"
  [ -f "$pm" ] || { log "skip ${tileset} (no local ${tileset}.pmtiles)"; continue; }
  header=$(pmtiles show --header-json "$pm")

  # layer → source basenames, from the LAYERS table.
  layers="[]"
  while IFS= read -r l; do
    [ "$(rec_field "$l" 1)" = "$tileset" ] || continue
    out=$(rec_field "$l" 5)
    src="$(ne_basename "$(printf '%s|%s|%s' "$(rec_field "$l" 2)" "$(rec_field "$l" 3)" "$(rec_field "$l" 4)")")"
    layers=$(jq -n --argjson layers "$layers" --arg id "$out" --arg src "$src" '
      ($layers | map(select(.id == $id)) | length) as $have
      | if $have > 0
        then ($layers | map(if .id == $id then .sources += [$src] else . end))
        else $layers + [{ id: $id, sources: [$src] }] end')
  done < <(printf '%s\n' "${LAYERS[@]}")

  tilesets_json=$(jq -n --argjson all "$tilesets_json" \
    --arg id "$tileset" --arg key "${tileset}.pmtiles" \
    --argjson header "$header" --argjson layers "$layers" '
    $all + [{
      id: $id, archive: $key,
      minzoom: $header.min_zoom, maxzoom: $header.max_zoom,
      layers: $layers
    }]')
done

jq -n \
  --arg ts "$GENERATED_AT" \
  --arg base "$SRC_ROOT" \
  --argjson tilesets "$tilesets_json" '
{
  generated_at: $ts,
  product: "Natural Earth vector (NACIS CDN)",
  source_page: "https://www.naturalearthdata.com/downloads/",
  source_base: $base,
  tilesets: $tilesets,
  license: "public domain (Natural Earth)",
  attribution: "Made with Natural Earth"
}
' > "$TMP"

log "Uploading manifest.json ($(wc -c < "$TMP") bytes)"
wrangler_put "$TMP" "manifest.json" "application/json"
log "done."
