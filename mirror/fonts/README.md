# fonts

Self-hosted glyph PBFs: Protomaps' `basemaps-assets` font stacks with
the CJK gap filled from Noto Sans CJK.

## Why

Protomaps deliberately ships no CJK glyphs — in browsers,
maplibre-gl-js draws kanji/kana/hangul from local fonts
(`localIdeographFontFamily`), so the hosted PBFs stay small. Our
raster renderer is headless maplibre-native on Linux, where that local
fallback is a stub, so CJK labels silently vanish from rendered tiles.

Every other script already works through the upstream assets and must
not be touched:

- Arabic / Hebrew: maplibre-native ships ICU bidi + Arabic shaping,
  and upstream carries the Arabic presentation forms.
- Indic / SE-Asian scripts: pre-shaped at tile build time via
  Protomaps' PGF (`pgf:name` fields) paired with PGF glyphs baked into
  the upstream PBFs.

That is why this pipeline is an **overlay, not a rebuild**: upstream
ranges are copied verbatim, and only the CJK Unicode blocks are
composited. Regenerating full stacks from vanilla Noto fonts would
drop the PGF glyphs and break Devanagari & friends.

## Pipeline

```
bash build.sh    # download fonts → SDF PBFs → merge into out/
bash upload.sh   # put out/ under r2://reearth-papers/mirror/fonts/
```

`build.sh` needs `cargo install build_pbf_glyphs` (Rust) and Node.
Everything is cached under `work/` and resumable.

Steps:

1. Download Noto Sans CJK **per-language subset** OTFs (JP/SC/TC/KR ×
   Regular/Medium) from `notofonts/noto-cjk`. The subsets carry the
   language-appropriate Han glyph variants.
2. `build_pbf_glyphs` renders each font into SDF glyph PBF ranges.
3. Mirror the three upstream stacks (Noto Sans Regular / Medium /
   Italic, 256 ranges each).
4. `merge.mjs` writes the final stacks: upstream verbatim outside the
   CJK blocks; inside them, first-glyph-wins over
   `[upstream, JP, SC, TC, KR]`. Upstream stays first so its
   punctuation and the Arabic presentation forms sharing range
   65024-65279 survive. The Italic stack receives upright CJK (CJK has
   no italic; tofu would be worse). Sanity checks assert あ/東/한/ﻫ
   presence and fail the build otherwise.

## Han unification / flavors

One stack holds one glyph per codepoint, so the default JP-first merge
shows Japanese variants everywhere, including Chinese and Korean place
names. For region-priority stacks later (e.g. zh-Hans maps), generate
a flavor and reference it from the style's `text-font`:

```
PRIORITY=SC,TC,JP,KR SUFFIX=" SC" bash build.sh
```

which emits `Noto Sans Regular SC` etc. alongside the defaults.

## Serving (worker side)

The worker serves these at `/fonts/{fontstack}/{range}.pbf` from the
R2 prefix `mirror/fonts/`, and the styles' `glyphs` template points
there instead of `protomaps.github.io` (both `src/style.ts` and
`mirror/protomaps/src/style.ts`). Bump `STYLE_VERSION` whenever the
glyph set changes — rendered labels are baked into cached tiles.
