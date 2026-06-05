# Shared helpers for the naturalearth mirror scripts.
# Sourced — not executed.

R2_BUCKET="${R2_BUCKET:-reearth-papers}"
R2_PREFIX="${R2_PREFIX:-mirror/naturalearth}"

# Upstream: Natural Earth's raster downloads, served from the NACIS CDN
# (the "Download" buttons on naturalearthdata.com 302 there). Anonymous
# read, stable URLs. Public domain.
SRC_ROOT="https://naciscdn.org/naturalearth"

# Datasets to mirror, as scale-qualified upstream paths. Each entry
# maps to ${SRC_ROOT}/${PATH}.zip containing $(basename PATH).tif
# (+ .tfw/.prj). Adding another raster is one more entry here plus a
# registry entry in ../../src/naturalearth.ts.
DATASETS=(
  10m/raster/NE1_HR_LC_SR_W_DR # Natural Earth I with shaded relief, water, drainages
  10m/raster/NE2_HR_LC_SR_W_DR # Natural Earth II with shaded relief, water, drainages
  10m/raster/HYP_HR_SR_OB_DR   # Cross-blended hypso with relief, ocean bottom, drainages
  10m/raster/GRAY_HR_SR_OB_DR  # Gray Earth with relief, hypsography, ocean bottom, drainages
  50m/raster/OB_50M            # Ocean Bottom (CleanTOPO2-derived depth colors + relief)
)

# Upstream archive basename for a DATASETS entry.
dataset_name() {
  basename "$1"
}

# R2 object key for a dataset's COG: lowercased upstream basename.
cog_key() {
  printf '%s.tif' "$(dataset_name "$1" | tr '[:upper:]' '[:lower:]')"
}

log() { printf '==> %s\n' "$*" >&2; }

# wrangler_put <local-file> <key-under-prefix> [content-type]
#
# Upload a single object to R2 via the Cloudflare API (no S3 keys
# needed — uses your wrangler login). `--remote` is mandatory; without
# it wrangler writes to its local emulation store.
wrangler_put() {
  local file="$1" key="$2" ct="${3:-application/octet-stream}"
  command -v npx >/dev/null || { echo "npx (Node.js) required for wrangler" >&2; exit 1; }
  ( cd "${REPO_ROOT}" && \
    npx --no-install wrangler r2 object put \
      "${R2_BUCKET}/${R2_PREFIX}/${key}" \
      --file "$file" \
      --content-type "$ct" \
      --remote )
}

# wrangler_exists <key-under-prefix> → exit 0 if object exists, 1 otherwise.
wrangler_exists() {
  ( cd "${REPO_ROOT}" && \
    npx --no-install wrangler r2 object get \
      "${R2_BUCKET}/${R2_PREFIX}/$1" \
      --remote --pipe 2>&1 >/dev/null ) || return 1
  return 0
}

REPO_ROOT=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../../.." && pwd)
