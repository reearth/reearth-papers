# scripts

## smoke.mjs

Post-deploy smoke test over the public API, run by the Deploy workflow
after every rollout (and runnable by hand). Checks every tileset in
`/catalog.json`, every themed style (`style.json` plus `?renderer=1`),
and the fonts route. Themed rasters are fetched twice: a fixed Tokyo
tile (serving path) and a random z14 tile with a cache-buster — the
tile-cache key embeds the coordinates, so the random tile is never
cached and forces a full MVT → glyph → ezu render
path on every run. Exits non-zero on any failure so the deploy goes
red; passthrough tilesets (third-party origins) only warn.

```
node scripts/smoke.mjs [--base=https://papers.reearth.land]
```

## overture-release.mjs

Refreshes what `src/overture.ts` says about the Overture archives.

The worker doesn't pin a release: Overture keeps a rolling window of
them in its public S3 bucket and deletes what falls out of it (that is
how `2026-06-17.0` took all five `/overture_*` routes down), so the
handler lists the bucket and serves the newest, cached for an hour per
isolate. `x-overture-release` on a tile says which one it was.

What the file still carries is the metadata the catalog and the TileJSON
have to state up front — each theme's zoom range, each layer's id and
minzoom — and those move between releases (`building`'s minzoom went
6 → 4 in `2026-08-19.0`). This script reads the live archives and, with
`--bump`, writes the current numbers back. Layer *membership* is
reported, never rewritten: a new layer needs a description and a
geometry hint, which only a person can write.

Nothing breaks while it goes unrun — the catalog just describes the
tiles slightly wrong — so run it when Overture publishes, or when a
`vector_layers` entry looks off.

```
node scripts/overture-release.mjs [--bump] [--json]
```

## thumbnails.mjs

Generates a thumbnail PNG for every raster tileset listed in the
catalog API. For each tileset, it downloads enough tiles around a
center point to cover the requested output size and then center-crops
the mosaic — tiles are never resized, so the output is at native
tile-pixel resolution.

### Usage

```
node scripts/thumbnails.mjs [options]
```

| Option | Default | Description |
| --- | --- | --- |
| `--base=URL` | `https://papers.reearth.land` | Tile source. Use `--base=http://localhost:8787` for local `wrangler dev`. |
| `--out=DIR` | `thumbnails` | Output directory. |
| `--z=N` | `13` | Tile zoom level. |
| `--width=N` | `1200` | Output width in pixels. |
| `--height=N` | `630` | Output height in pixels (default is the OGP size). |
| `--lng=N` | `139.7671` | Center longitude (Tokyo Station). |
| `--lat=N` | `35.6812` | Center latitude (Tokyo Station). |

### Output

One `{out}/{tileset.id}.png` is written for each `type: "raster"` entry
in `catalog.json`. Empty tiles (HTTP 204) are left transparent, so
tilesets with no data yet still produce a valid PNG instead of failing.

## og.py

Draws the two pieces of artwork this site shows of itself: the social
card (`public/og.png`, 1200×630) and the favicon
(`public/favicon.ico`, `icon-512.png`, `apple-touch-icon.png`). Both are
committed and served as static files — nothing at request time runs
this. The script exists so the framing, the type and the ink are
parameters rather than a memory of what was done in an image editor.

```
python3 scripts/og.py [--out public] [--font path/to/EB_Garamond.ttf]
```

Needs Pillow and numpy, neither of which the worker depends on.

**Typeface: [EB Garamond](https://fonts.google.com/specimen/EB+Garamond)**
(SIL OFL 1.1), from Google Fonts. Only its rasterised output is
committed, so nothing is redistributed — but the `.ttf` has to be on
disk to redraw the card. Point `--font` at it, or set `OG_FONT`.

The card is a `paint-sumi` render of the Bay of Naples. Two things in it
are deliberate and easy to undo by accident:

- The field is fetched at **z12 and downsampled** to 1200×630, not
  fetched at z11. The bay and Vesuvio's pine forest do not both fit in a
  z12 screenful, and z11 draws the coast too coarsely to read at card
  size.
- The title is drawn a glyph at a time, because Pillow has no
  letter-spacing — and a glyph at a time discards the kerning raqm would
  otherwise apply. `draw_title` measures the pair adjustments back out of
  the font (`kern(a,b) = len(a+b) − len(a) − len(b)`) and re-applies them
  before adding the track. Without that step `Re` and `Pa` sit apart and
  the whole card reads as a default.
