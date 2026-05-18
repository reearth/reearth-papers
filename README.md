# reearth-papers

PoC: render MapLibre vector tiles to raster tiles on Cloudflare Workers
Containers.

## Architecture

```
client
  │  GET /tile/{z}/{x}/{y}.png?style=<url>
  ▼
Cloudflare Worker  (./)
  │  containerInstance.fetch()
  ▼
Workers Container  (container/)
  │  Rust + maplibre-native (software GL via Xvfb + llvmpipe)
  ▼
  256×256 PNG
```

The Worker is a thin router/proxy; the container does the actual MapLibre
style rendering. The container speaks plain HTTP on `$PORT` and exposes:

| Method | Path | Description |
|--------|------|-------------|
| `GET`  | `/health` | liveness |
| `GET`  | `/tile/:z/:x/:y` | render a 256×256 PNG for the given XYZ tile. `?style=<url>` overrides `STYLE_URL` env. |

## Run locally

```bash
# Build & run the container directly (no Workers)
cd container
docker build -t papers-tile .
docker run --rm -p 8080:8080 \
  -e STYLE_URL=https://demotiles.maplibre.org/style.json \
  papers-tile
curl 'http://localhost:8080/tile/0/0/0' -o tile.png

# Or run end-to-end through wrangler (requires Docker, from repo root)
npm install
npx wrangler dev
curl 'http://localhost:8787/tile/0/0/0.png?style=https://demotiles.maplibre.org/style.json' -o tile.png
```

## Status

PoC — verifies that a maplibre-native–based renderer works inside a
Workers Container, called synchronously from a Worker.
