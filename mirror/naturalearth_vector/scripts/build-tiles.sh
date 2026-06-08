#!/usr/bin/env bash
# Build the themed Natural Earth vector PMTiles archives.
#
# For each tileset (physical, admin, …) and each scale tier it uses:
#   1. for every out_layer, merge its source shapefile(s) into one
#      GeoJSON (multiple sources — regional river/lake supplements, the
#      bathymetry depth bands — are appended via an intermediate
#      GeoPackage so they land as a single MVT layer).
#   2. tippecanoe the tier's GeoJSON inputs into one PMTiles at the
#      tier's zoom window, each tagged as its out_layer.
# Then tile-join stitches a tileset's per-tier archives into one z-min..
# z-max PMTiles and uploads it to R2 as <tileset>.pmtiles.
#
# Per-tileset: skips when the output already exists in R2; FORCE=1
# rebuilds. Limit to specific tilesets with ONLY="physical admin".
set -euo pipefail

HERE=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
# shellcheck source=./_lib.sh
. "$HERE/_lib.sh"

command -v ogr2ogr >/dev/null || { echo "GDAL (ogr2ogr) required" >&2; exit 1; }
command -v tippecanoe >/dev/null || { echo "tippecanoe required" >&2; exit 1; }
command -v tile-join >/dev/null || { echo "tile-join (ships with tippecanoe) required" >&2; exit 1; }

WORK="${WORK:-${HERE}/../.work}"
export SRC="${WORK}/src"
GJ="${WORK}/geojson"
MERGE="${WORK}/merge"
TILES="${WORK}/tiles"
mkdir -p "$GJ" "$MERGE" "$TILES"

# Cap per-tile bytes so no single MVT tile gets heavy; tippecanoe drops
# the densest features (and extends zooms) to stay under it.
MAX_TILE_BYTES="${MAX_TILE_BYTES:-300000}"

for tileset in "${TILESETS[@]}"; do
  case " ${ONLY:-${TILESETS[*]}} " in *" $tileset "*) ;; *) continue ;; esac
  out_key="${tileset}.pmtiles"
  if [ -z "${FORCE:-}" ] && wrangler_exists "$out_key"; then
    log "${out_key} already in R2 (FORCE=1 to rebuild); skipping"
    continue
  fi

  tier_archives=()
  while IFS= read -r tier; do
    [ -n "$tier" ] || continue
    read -r minz maxz <<EOF
$(tier_zoom "$tileset" "$tier")
EOF
    layer_args=()
    while IFS= read -r out; do
      [ -n "$out" ] || continue
      gj="${GJ}/${tileset}_${tier}_${out}.geojson"
      # Merge this out_layer's source(s) through a GeoPackage so multi-
      # source layers (lakes/rivers supplements, bathymetry bands) end
      # up as one layer with a unified schema.
      gpkg="${MERGE}/${tileset}_${tier}_${out}.gpkg"
      rm -f "$gpkg" "$gj"
      n=0
      while IFS= read -r shp; do
        [ -n "$shp" ] || continue
        [ -f "$shp" ] || { echo "missing ${shp} — run fetch.sh first" >&2; exit 1; }
        ogr2ogr -f GPKG -append -nln "$out" -t_srs EPSG:4326 \
          -skipfailures "$gpkg" "$shp" >/dev/null 2>&1 || \
          ogr2ogr -f GPKG -append -nln "$out" -t_srs EPSG:4326 "$gpkg" "$shp"
        n=$((n + 1))
      done < <(out_layer_shps "$tileset" "$tier" "$out")
      [ "$n" -gt 0 ] || { echo "no sources for ${tileset}/${tier}/${out}" >&2; exit 1; }
      log "merge ${tileset}/${tier}m ${out} (${n} source(s)) → GeoJSON"
      ogr2ogr -f GeoJSON "$gj" "$gpkg" "$out" >/dev/null
      layer_args+=( -L"${out}:${gj}" )
    done < <(tier_out_layers "$tileset" "$tier")

    out_pm="${TILES}/${tileset}_${tier}m.pmtiles"
    log "tippecanoe ${tileset}/${tier}m → z${minz}-${maxz} (${#layer_args[@]} layers)"
    tippecanoe \
      -o "$out_pm" \
      --name="Natural Earth ${tileset} ${tier}m" \
      --attribution="Made with Natural Earth" \
      -Z"$minz" -z"$maxz" \
      --maximum-tile-bytes="$MAX_TILE_BYTES" \
      --drop-densest-as-needed \
      --extend-zooms-if-still-dropping \
      --coalesce-densest-as-needed \
      --simplification=4 \
      --force \
      "${layer_args[@]}"
    tier_archives+=( "$out_pm" )
  done < <(tileset_tiers "$tileset")

  out="${WORK}/${out_key}"
  log "tile-join ${#tier_archives[@]} tier(s) → ${out_key}"
  tile-join -o "$out" --name="Natural Earth ${tileset}" \
    --attribution="Made with Natural Earth" --force "${tier_archives[@]}"

  log "Uploading ${out_key} ($(du -h "$out" | cut -f1)) → R2"
  wrangler_put "$out" "$out_key" "application/vnd.pmtiles"
done

log "done."
