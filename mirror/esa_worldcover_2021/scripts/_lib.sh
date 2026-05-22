# Shared helpers for the esa_worldcover_2021 mirror scripts.
# Sourced — not executed.

# Always-available config (no creds needed).
R2_BUCKET="${R2_BUCKET:-reearth-papers}"
R2_PREFIX="${R2_PREFIX:-mirror/esa_worldcover_2021}"

# Upstream is hosted by Sinergise on the AWS Open Data Program — anonymous
# read, free egress, no requester-pays.
SRC_BUCKET="esa-worldcover"
SRC_REGION="eu-central-1"
SRC_PREFIX="v200/2021/map"

# Anonymous rclone remote for the upstream bucket. Used by every script
# (manifest enumeration, overview source listing, mirror.sh sync source).
SRC_REMOTE=":s3,provider=AWS,region=${SRC_REGION},no_check_bucket=true,no_sign_request=true:${SRC_BUCKET}/${SRC_PREFIX}"

log() { printf '==> %s\n' "$*" >&2; }

# Require the S3-compatible R2 credentials. Only mirror.sh needs them
# (bulk sync goes through rclone). The other scripts upload via
# `wrangler r2 object put`, which reuses your wrangler auth.
require_r2_keys() {
  : "${CLOUDFLARE_ACCOUNT_ID:?required for bulk mirror: Cloudflare account id}"
  : "${R2_ACCESS_KEY_ID:?required for bulk mirror: R2 access key id}"
  : "${R2_SECRET_ACCESS_KEY:?required for bulk mirror: R2 secret access key}"
  DST_REMOTE=":s3,provider=Cloudflare,access_key_id=${R2_ACCESS_KEY_ID},secret_access_key=${R2_SECRET_ACCESS_KEY},endpoint=https://${CLOUDFLARE_ACCOUNT_ID}.r2.cloudflarestorage.com:${R2_BUCKET}/${R2_PREFIX}"
}

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
  local key="$1" out
  out=$( cd "${REPO_ROOT}" && \
    npx --no-install wrangler r2 object get \
      "${R2_BUCKET}/${R2_PREFIX}/${key}" \
      --remote --pipe 2>&1 >/dev/null ) || return 1
  return 0
}

# Resolve the repo root so wrangler picks up the right wrangler.toml
# regardless of where the user invokes the script from.
REPO_ROOT=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../../.." && pwd)
