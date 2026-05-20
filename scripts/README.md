# scripts

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
