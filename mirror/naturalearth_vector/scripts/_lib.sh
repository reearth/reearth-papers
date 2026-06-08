# Shared helpers for the naturalearth_vector mirror scripts.
# Sourced — not executed. Bash 3.2 compatible (no associative arrays).

R2_BUCKET="${R2_BUCKET:-reearth-papers}"
R2_PREFIX="${R2_PREFIX:-mirror/naturalearth_vector}"

# Upstream: Natural Earth's vector downloads, served from the NACIS CDN
# (the "Download" buttons on naturalearthdata.com 302 there). Anonymous
# read, stable URLs, public domain.
SRC_ROOT="https://naciscdn.org/naturalearth"

# Themed output tilesets. Each becomes <id>.pmtiles under ${R2_PREFIX}
# and one NeVectorTileset entry in src/naturalearth_vector.ts. Keep this
# list (and the per-tileset layers / zoom windows below) in sync with
# that file.
TILESETS=(physical admin labels landuse transport bathymetry)

# Tippecanoe zoom window per (tileset, scale tier). Coarser Natural
# Earth scales feed low zooms, finer scales the high zooms; tile-join
# stitches a tileset's per-tier archives into one. Transport and
# bathymetry are 10m-only (single tier).
#
#   tileset|tier|min_zoom|max_zoom
TIERZOOM=(
  "physical|110|0|2"  "physical|50|3|4"  "physical|10|5|8"
  "admin|110|0|2"     "admin|50|3|4"     "admin|10|5|8"
  "labels|110|0|2"    "labels|50|3|4"    "labels|10|5|8"
  "landuse|50|3|4"    "landuse|10|5|8"
  "transport|10|4|10"
  "bathymetry|10|0|6"
)

# The full layer catalogue. One line per (tileset, tier, source file):
#
#   tileset|tier|category|ne_suffix|out_layer
#
# `ne_suffix` is the upstream basename minus the `ne_<tier>m_` prefix;
# the source archive is ${SRC_ROOT}/<tier>m/<category>/ne_<tier>m_<suffix>.zip.
# Rows sharing (tileset, tier, out_layer) are MERGED into one MVT layer
# (e.g. regional lake/river supplements fold into `lakes`/`rivers`, and
# every bathymetry depth band folds into `bathymetry`). The out_layer
# names are the contract with src/naturalearth_vector.ts.
#
# Deliberately excluded: point-of-view country variants
# (admin_0_countries_<iso>), *_scale_rank / *_simple / *_lakes / *_seams
# / *_to_match / *_names helper renditions — pure duplicates, not extra
# coverage.
LAYERS=(
  # ---- physical -------------------------------------------------------
  "physical|110|physical|ocean|ocean"
  "physical|110|physical|land|land"
  "physical|110|physical|coastline|coastline"
  "physical|110|physical|lakes|lakes"
  "physical|110|physical|rivers_lake_centerlines|rivers"
  "physical|110|physical|glaciated_areas|glaciated_areas"
  "physical|110|physical|geographic_lines|geographic_lines"
  "physical|110|physical|geography_marine_polys|marine_polys"
  "physical|110|physical|geography_regions_polys|regions_polys"

  "physical|50|physical|ocean|ocean"
  "physical|50|physical|land|land"
  "physical|50|physical|coastline|coastline"
  "physical|50|physical|lakes|lakes"
  "physical|50|physical|lakes_historic|lakes"
  "physical|50|physical|rivers_lake_centerlines|rivers"
  "physical|50|physical|glaciated_areas|glaciated_areas"
  "physical|50|physical|antarctic_ice_shelves_polys|antarctic_ice_shelves"
  "physical|50|physical|playas|playas"
  "physical|50|physical|geographic_lines|geographic_lines"
  "physical|50|physical|geography_marine_polys|marine_polys"
  "physical|50|physical|geography_regions_polys|regions_polys"

  "physical|10|physical|ocean|ocean"
  "physical|10|physical|land|land"
  "physical|10|physical|coastline|coastline"
  "physical|10|physical|lakes|lakes"
  "physical|10|physical|lakes_historic|lakes"
  "physical|10|physical|lakes_europe|lakes"
  "physical|10|physical|lakes_north_america|lakes"
  "physical|10|physical|lakes_australia|lakes"
  "physical|10|physical|lakes_pluvial|lakes"
  "physical|10|physical|rivers_lake_centerlines|rivers"
  "physical|10|physical|rivers_europe|rivers"
  "physical|10|physical|rivers_north_america|rivers"
  "physical|10|physical|rivers_australia|rivers"
  "physical|10|physical|glaciated_areas|glaciated_areas"
  "physical|10|physical|antarctic_ice_shelves_polys|antarctic_ice_shelves"
  "physical|10|physical|reefs|reefs"
  "physical|10|physical|playas|playas"
  "physical|10|physical|minor_islands|minor_islands"
  "physical|10|physical|geographic_lines|geographic_lines"
  "physical|10|physical|geography_marine_polys|marine_polys"
  "physical|10|physical|geography_regions_polys|regions_polys"

  # ---- admin ----------------------------------------------------------
  "admin|110|cultural|admin_0_countries|countries"
  "admin|110|cultural|admin_0_map_units|map_units"
  "admin|110|cultural|admin_0_sovereignty|sovereignty"
  "admin|110|cultural|admin_0_boundary_lines_land|boundary_lines"
  "admin|110|cultural|admin_0_pacific_groupings|pacific_groupings"
  "admin|110|cultural|admin_1_states_provinces|states_provinces"
  "admin|110|cultural|admin_1_states_provinces_lines|states_lines"

  "admin|50|cultural|admin_0_countries|countries"
  "admin|50|cultural|admin_0_map_units|map_units"
  "admin|50|cultural|admin_0_map_subunits|map_subunits"
  "admin|50|cultural|admin_0_sovereignty|sovereignty"
  "admin|50|cultural|admin_0_boundary_lines_land|boundary_lines"
  "admin|50|cultural|admin_0_boundary_lines_maritime_indicator|boundary_maritime"
  "admin|50|cultural|admin_0_boundary_lines_disputed_areas|boundary_disputed"
  "admin|50|cultural|admin_0_pacific_groupings|pacific_groupings"
  "admin|50|cultural|admin_1_states_provinces|states_provinces"
  "admin|50|cultural|admin_1_states_provinces_lines|states_lines"

  "admin|10|cultural|admin_0_countries|countries"
  "admin|10|cultural|admin_0_map_units|map_units"
  "admin|10|cultural|admin_0_map_subunits|map_subunits"
  "admin|10|cultural|admin_0_sovereignty|sovereignty"
  "admin|10|cultural|admin_0_boundary_lines_land|boundary_lines"
  "admin|10|cultural|admin_0_boundary_lines_maritime_indicator|boundary_maritime"
  "admin|10|cultural|admin_0_boundary_lines_disputed_areas|boundary_disputed"
  "admin|10|cultural|admin_0_pacific_groupings|pacific_groupings"
  "admin|10|cultural|admin_1_states_provinces|states_provinces"
  "admin|10|cultural|admin_1_states_provinces_lines|states_lines"
  "admin|10|cultural|admin_2_counties|counties"

  # ---- labels (point layers) -----------------------------------------
  "labels|110|cultural|populated_places|places"
  "labels|110|physical|geography_regions_points|region_points"
  "labels|110|physical|geography_regions_elevation_points|region_elevation_points"

  "labels|50|cultural|populated_places|places"
  "labels|50|physical|geography_regions_points|region_points"
  "labels|50|physical|geography_regions_elevation_points|region_elevation_points"

  "labels|10|cultural|populated_places|places"
  "labels|10|cultural|admin_0_label_points|admin_0_labels"
  "labels|10|cultural|admin_1_label_points|admin_1_labels"
  "labels|10|physical|geography_regions_points|region_points"
  "labels|10|physical|geography_regions_elevation_points|region_elevation_points"

  # ---- land use -------------------------------------------------------
  "landuse|50|cultural|urban_areas|urban_areas"

  "landuse|10|cultural|urban_areas|urban_areas"
  "landuse|10|cultural|parks_and_protected_lands_area|parks_area"
  "landuse|10|cultural|parks_and_protected_lands_line|parks_line"
  "landuse|10|cultural|parks_and_protected_lands_point|parks_point"

  # ---- transport (10m only) ------------------------------------------
  "transport|10|cultural|roads|roads"
  "transport|10|cultural|roads_north_america|roads_north_america"
  "transport|10|cultural|railroads|railroads"
  "transport|10|cultural|railroads_north_america|railroads_north_america"
  "transport|10|cultural|airports|airports"
  "transport|10|cultural|ports|ports"
  "transport|10|cultural|time_zones|time_zones"

  # ---- bathymetry (10m only; all depth bands → one layer) ------------
  "bathymetry|10|physical|bathymetry_all|bathymetry"
)

# Field accessor for an "a|b|c|..." record.
rec_field() { printf '%s' "$1" | cut -d'|' -f"$2"; }

# Print a unique list preserving first-seen order (stdin → stdout).
uniq_ordered() { awk '!seen[$0]++'; }

# A few Natural Earth themes ship as a single bundle .zip holding
# several shapefiles rather than one zip per layer. Map a layer's
# ne_suffix to the .zip basename suffix that actually exists on the CDN.
zip_suffix() {
  case "$1" in
    parks_and_protected_lands_*) printf 'parks_and_protected_lands' ;;
    *) printf '%s' "$1" ;;
  esac
}

# Glob (relative to $SRC) of the shapefile(s) a download unit
# "tier|category|zip_suffix" unpacks to — bundles expand to many.
unit_glob() {
  local tier zsuf
  tier=$(rec_field "$1" 1); zsuf=$(rec_field "$1" 3)
  case "$zsuf" in
    bathymetry_all)            printf 'ne_%sm_bathymetry_*.shp' "$tier" ;;
    parks_and_protected_lands) printf 'ne_%sm_parks_and_protected_lands*.shp' "$tier" ;;
    *)                         printf 'ne_%sm_%s.shp' "$tier" "$zsuf" ;;
  esac
}

# Unique "tier|category|zip_suffix" download units across all layers.
download_units() {
  local l
  for l in "${LAYERS[@]}"; do
    printf '%s|%s|%s\n' \
      "$(rec_field "$l" 2)" "$(rec_field "$l" 3)" "$(zip_suffix "$(rec_field "$l" 4)")"
  done | uniq_ordered
}

# ne_<tier>m_<suffix> basename for a "tier|category|suffix" unit.
ne_basename() { printf 'ne_%sm_%s' "$(rec_field "$1" 1)" "$(rec_field "$1" 3)"; }

# Upstream .zip URL for a "tier|category|suffix" unit.
ne_url() {
  local tier cat suf
  tier=$(rec_field "$1" 1); cat=$(rec_field "$1" 2); suf=$(rec_field "$1" 3)
  printf '%s/%sm/%s/ne_%sm_%s.zip' "$SRC_ROOT" "$tier" "$cat" "$tier" "$suf"
}

# Zoom window "minz maxz" for a (tileset, tier) pair.
tier_zoom() {
  local r
  for r in "${TIERZOOM[@]}"; do
    if [ "$(rec_field "$r" 1)" = "$1" ] && [ "$(rec_field "$r" 2)" = "$2" ]; then
      printf '%s %s' "$(rec_field "$r" 3)" "$(rec_field "$r" 4)"; return 0
    fi
  done
  return 1
}

# Tiers used by a tileset (in TIERZOOM order).
tileset_tiers() {
  local r
  for r in "${TIERZOOM[@]}"; do
    [ "$(rec_field "$r" 1)" = "$1" ] && rec_field "$r" 2
  done
}

# out_layers for a (tileset, tier), unique in declaration order.
tier_out_layers() {
  local l
  for l in "${LAYERS[@]}"; do
    [ "$(rec_field "$l" 1)" = "$1" ] && [ "$(rec_field "$l" 2)" = "$2" ] && rec_field "$l" 5
  done | uniq_ordered
}

# Source shapefiles (one path per line) feeding a (tileset, tier,
# out_layer) group. Expands the bathymetry `*_all` bundle to its depth
# bands. WORK/SRC must be exported by the caller.
out_layer_shps() {
  local tileset="$1" tier="$2" out="$3" l cat suf
  for l in "${LAYERS[@]}"; do
    [ "$(rec_field "$l" 1)" = "$tileset" ] || continue
    [ "$(rec_field "$l" 2)" = "$tier" ] || continue
    [ "$(rec_field "$l" 5)" = "$out" ] || continue
    suf=$(rec_field "$l" 4)
    case "$suf" in
      *_all)
        # bathymetry_all.zip unzips to per-band shapefiles.
        ls "${SRC}"/ne_"${tier}"m_bathymetry_*.shp 2>/dev/null
        ;;
      *)
        printf '%s/ne_%sm_%s.shp\n' "$SRC" "$tier" "$suf"
        ;;
    esac
  done
}

log() { printf '==> %s\n' "$*" >&2; }

# wrangler_put <local-file> <key-under-prefix> [content-type]
wrangler_put() {
  local file="$1" key="$2" ct="${3:-application/octet-stream}"
  command -v npx >/dev/null || { echo "npx (Node.js) required for wrangler" >&2; exit 1; }
  ( cd "${REPO_ROOT}" && \
    npx --no-install wrangler r2 object put \
      "${R2_BUCKET}/${R2_PREFIX}/${key}" \
      --file "$file" --content-type "$ct" --remote )
}

# wrangler_exists <key-under-prefix> → exit 0 if object exists.
wrangler_exists() {
  ( cd "${REPO_ROOT}" && \
    npx --no-install wrangler r2 object get \
      "${R2_BUCKET}/${R2_PREFIX}/$1" --remote --pipe 2>&1 >/dev/null ) || return 1
  return 0
}

# wrangler_delete <key-under-prefix>
wrangler_delete() {
  ( cd "${REPO_ROOT}" && \
    npx --no-install wrangler r2 object delete \
      "${R2_BUCKET}/${R2_PREFIX}/$1" --remote )
}

REPO_ROOT=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../../.." && pwd)
