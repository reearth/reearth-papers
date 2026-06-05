#!/usr/bin/env bash
# End-to-end pipeline. Idempotent — every step short-circuits when its
# output is already present (locally or in R2).
set -euo pipefail

HERE=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)

"$HERE/fetch.sh"
"$HERE/build-cog.sh"
"$HERE/build-manifest.sh"
