#!/usr/bin/env bash
# Upload the generated glyph PBFs to R2 under mirror/fonts/.
# One-shot, resumable at file granularity (wrangler overwrites).
#
# With multiple Cloudflare accounts, set CLOUDFLARE_ACCOUNT_ID (find it
# via `npx wrangler whoami`).
#
# Usage: [CLOUDFLARE_ACCOUNT_ID=…] bash upload.sh [out]
set -euo pipefail
cd "$(dirname "$0")"

OUT="${1:-out}"
BUCKET=reearth-papers
PREFIX=mirror/fonts

[ -d "$OUT" ] || { echo "$OUT/ not found — run build.sh first" >&2; exit 1; }

# -0/-n1 keeps space-containing fontstack paths intact and sidesteps
# macOS xargs -I replacement-length limits.
export OUT BUCKET PREFIX
find "$OUT" -name '*.pbf' -print0 | sort -z | xargs -0 -n 1 -P 8 sh -c '
  f="$1"; rel="${f#"$OUT"/}"
  npx wrangler r2 object put "$BUCKET/$PREFIX/$rel" \
    --file "$f" --content-type application/x-protobuf --remote >/dev/null 2>&1 \
    && echo "$rel" || echo "FAILED: $rel" >&2
' _
echo "done: $(find "$OUT" -name '*.pbf' | wc -l | tr -d ' ') objects under $PREFIX/"
