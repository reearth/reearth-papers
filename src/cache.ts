// Cartography version for the rendered raster tiles.
//
// It namespaces the ezu tile cache (src/ezu.ts pairs it with
// EZU_RECIPE_VERSION) and rides in the style URL the maplibre-native
// container fetches, so a warm container re-reads the style after an
// edit instead of serving pre-edit renders from its own cache.
//
// The two-layer key helpers that used to live here went with the
// cutover to ezu-first: the ezu route caches through
// src/render_cache.ts, and the container path is comparison-only and
// keeps nothing in R2.
//
// It also has to travel in the style URL itself (see `styleUrlForCache`
// in index.ts): the renderer container memoises the style it fetched
// keyed on that URL — in memory *and* on disk, for the life of the
// instance — so a warm container would otherwise keep re-rendering from
// the pre-edit style no matter how many times we invalidate on our side.
// v4: tiles went 256px → 512px (rendered at native viewport size, no
// downscale) — mixing sizes within one cache namespace would corrupt
// client rendering, so the old namespace must be orphaned wholesale.
// v5: self-hosted glyphs with CJK (mirror/fonts/) — cached tiles
// rendered before the switch have no kanji/kana/hangul baked in.
// v6: v5 renders went out with randomly missing glyph ranges (the
// container proxy's per-request TLS storm, fixed in proxy.rs) — those
// half-labeled tiles are baked into the v5 namespace.
// v7: pois anchors pinned for Tile-mode placement (see the mirror's
// pinVariableAnchors) — v6 tiles are missing a large share of POIs.
// v8: pois text made optional so icons survive Tile mode's
// border-priority pass stealing the text's spot.
// v9: the papers house styles re-calibrated against PLATEAU's rendered
// tiles — screen-space widths halved for the 512px tile, road casings
// withheld from the fine classes at mid zoom, boundaries moved under the
// water fill and sea crossings over it, and the z12 double-draw of the
// overview and detail road networks fixed. Every papers tile changes.
export const STYLE_VERSION = 9;
