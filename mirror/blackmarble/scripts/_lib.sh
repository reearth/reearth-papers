# Shared helpers for the blackmarble mirror scripts.
# Sourced — not executed.

R2_BUCKET="${R2_BUCKET:-reearth-papers}"
R2_PREFIX="${R2_PREFIX:-mirror/blackmarble}"

# Upstream: NASA Earth Observatory "Earth at Night 2016" (Visible Earth
# image id 144898). The CMS at visibleearth.nasa.gov 301-redirects to
# science.nasa.gov, but the underlying asset files still live at the
# `assets.science.nasa.gov` CDN under the same numeric image record.
SRC_BASE="https://assets.science.nasa.gov/content/dam/science/esd/eo/images/imagerecords/144000/144898"

# 8 full-resolution tiles (500 m/px, each 21600×21600, 4 cols × 2 rows).
# Column order A..D goes west→east; row 1 is the northern half.
SRC_TILES=(
  BlackMarble_2016_A1_geo.tif BlackMarble_2016_B1_geo.tif
  BlackMarble_2016_C1_geo.tif BlackMarble_2016_D1_geo.tif
  BlackMarble_2016_A2_geo.tif BlackMarble_2016_B2_geo.tif
  BlackMarble_2016_C2_geo.tif BlackMarble_2016_D2_geo.tif
)

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
