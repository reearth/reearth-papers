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
