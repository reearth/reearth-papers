#!/usr/bin/env bash
# Build the self-hosted glyph PBF set: Protomaps' basemaps-assets
# fonts with the CJK gap filled from Noto Sans CJK.
#
# Protomaps deliberately ships no CJK glyphs (browsers cover CJK via
# localIdeographFontFamily), which leaves our server-side raster
# renderer with no kanji/kana/hangul at all. Everything else — Arabic
# presentation forms, the PGF pre-shaped glyphs that make Indic and SE
# Asian scripts work — already lives in the upstream PBFs, so this
# pipeline is strictly an overlay: upstream ranges are copied as-is
# and only the CJK Unicode blocks are (re)generated. Never rebuild the
# full stacks from vanilla Noto TTFs — that would silently drop the
# PGF glyphs and break Devanagari & friends.
#
# Usage:
#   bash build.sh                 # JP-priority merge (the default)
#   PRIORITY=SC,TC,JP,KR SUFFIX=" SC" bash build.sh
#                                 # extra flavor, e.g. for zh-priority
#                                 # stacks ("Noto Sans Regular SC" …)
#
# Outputs out/<fontstack>/<start>-<end>.pbf, ready for upload.sh.
set -euo pipefail
cd "$(dirname "$0")"

PRIORITY="${PRIORITY:-JP,SC,TC,KR}"
SUFFIX="${SUFFIX:-}"
WORK=work
OUT=out

NOTO_BASE="https://raw.githubusercontent.com/notofonts/noto-cjk/main/Sans/SubsetOTF"
ASSETS_BASE="https://protomaps.github.io/basemaps-assets/fonts"
UPSTREAM_STACKS=("Noto Sans Regular" "Noto Sans Medium" "Noto Sans Italic")

command -v build_pbf_glyphs >/dev/null || {
  echo "build_pbf_glyphs not found — install with: cargo install build_pbf_glyphs" >&2
  exit 1
}

# -- 1. Noto Sans CJK subset OTFs (per-language subsets carry the
#       language-appropriate Han variants; the merge order in
#       merge.mjs decides which variant wins). --------------------
mkdir -p "$WORK/src"
for lang in JP SC TC KR; do
  for weight in Regular Medium; do
    f="$WORK/src/NotoSans${lang}-${weight}.otf"
    if [ ! -s "$f" ]; then
      echo "download NotoSans${lang}-${weight}.otf"
      curl -sfL --retry 3 -o "$f" "$NOTO_BASE/${lang}/NotoSans${lang}-${weight}.otf"
    fi
  done
done

# -- 2. SDF glyph PBFs per font. build_pbf_glyphs names the output
#       directory after the font's internal name, so isolate each
#       font in its own input dir to keep the mapping deterministic. -
for src in "$WORK"/src/*.otf; do
  key="$(basename "$src" .otf)"
  gen="$WORK/gen/$key"
  if [ ! -d "$gen" ]; then
    echo "generate glyphs: $key"
    onedir="$WORK/one/$key"
    mkdir -p "$onedir" "$gen.tmp"
    cp "$src" "$onedir/"
    build_pbf_glyphs "$onedir" "$gen.tmp"
    mv "$gen.tmp" "$gen"
  fi
done

# -- 3. Mirror the upstream Protomaps stacks (all 256 ranges each;
#       missing ranges are treated as empty by merge.mjs). ----------
for stack in "${UPSTREAM_STACKS[@]}"; do
  dir="$WORK/upstream/$stack"
  if [ ! -f "$dir/.complete" ]; then
    echo "mirror upstream: $stack"
    mkdir -p "$dir"
    seq 0 256 65280 | xargs -P 16 -I{} sh -c '
      start={}; end=$((start + 255)); dir="$1"; stack="$2"; base="$3"
      f="$dir/$start-$end.pbf"
      [ -s "$f" ] || curl -sf -o "$f" "$base/$(printf %s "$stack" | sed "s/ /%20/g")/$start-$end.pbf" || true
    ' _ "$dir" "$stack" "$ASSETS_BASE"
    touch "$dir/.complete"
  fi
done

# -- 4. Merge: upstream first (keeps Noto Sans punctuation + Arabic
#       presentation forms), then the CJK fonts in PRIORITY order. ---
node merge.mjs --work="$WORK" --out="$OUT" --priority="$PRIORITY" --suffix="$SUFFIX"
