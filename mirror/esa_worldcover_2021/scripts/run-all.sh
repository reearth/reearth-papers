#!/usr/bin/env bash
# Run the full pipeline end-to-end. Each step is idempotent.
#
# mirror.sh needs R2 keys. If they aren't set, we skip it — useful when
# the bulk mirror is already in place and you only need to refresh the
# derived artefacts.
set -euo pipefail

HERE=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)

if [ -n "${R2_ACCESS_KEY_ID:-}" ] && [ -n "${R2_SECRET_ACCESS_KEY:-}" ] && [ -n "${CLOUDFLARE_ACCOUNT_ID:-}" ]; then
  "$HERE/mirror.sh"
else
  echo "==> mirror.sh skipped (R2_ACCESS_KEY_ID / R2_SECRET_ACCESS_KEY / CLOUDFLARE_ACCOUNT_ID not set)" >&2
fi

"$HERE/build-manifest.sh"
"$HERE/build-overview.sh"
