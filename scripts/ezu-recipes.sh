#!/usr/bin/env bash
# Regenerate the committed ezu recipes (src/ezu_recipes/) from the
# production renderer styles. The recipes are bundled into the worker
# for the ezu shadow-rendering route, so re-run this — and commit the
# result — whenever the style pipeline changes (same trigger as a
# STYLE_VERSION bump).
#
# Needs the ezu CLI at the version package.json pins @reearth/ezu to:
# `cargo install ezu-cli` (or set EZU_BIN).
#
# Usage: bash scripts/ezu-recipes.sh [base-url]
set -euo pipefail
cd "$(dirname "$0")/.."

BASE="${1:-https://papers.reearth.land}"
EZU="${EZU_BIN:-ezu}"
command -v "$EZU" >/dev/null || {
  echo "ezu CLI not found — cargo install ezu-cli (or set EZU_BIN)" >&2
  exit 1
}

mkdir -p src/ezu_recipes
tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT
# Every public theme. The papers house styles are label-free, so their
# recipes carry no glyph/sprite sources at all. The CJK flavors are not
# baked here: `?cjk=` only renames the fontstacks the glyph sources
# point at, so src/ezu.ts derives the SC/TC variants from these by
# rewriting that one field (see `recipeFor`).
for theme in papers-light papers-dark protomaps-light protomaps-dark \
             protomaps-white protomaps-black protomaps-grayscale; do
  echo "translate: $theme"
  curl -fsS "$BASE/styles/$theme/style.json?renderer=1" -o "$tmp/$theme.json"
  # Forms the translator can't carry over, rewritten to ones it can
  # (see the script for which).
  node scripts/ezu-style-prep.mjs "$tmp/$theme.json" "$tmp/$theme.prep.json"
  "$EZU" translate "$tmp/$theme.prep.json" --out "src/ezu_recipes/$theme.json"
done
