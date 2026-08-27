// Tile-demand events, so something outside this worker can warm what people
// actually ask for.
//
// A paint tile is seconds of WASM CPU and every one of them goes out
// `immutable, max-age=1y`, which is exactly the shape that makes an
// invalidation expensive: the cache does not decay, it dies all at once when a
// version constant moves, and the next visitor to each tile pays the full
// render. okibi's job is to know which tiles that is worth doing early for,
// and it can only know that if we write down what was asked for.
//
// One event per tile request, hits included — a hit is the evidence that
// somebody wants that tile, and a ledger of misses would only record where the
// cache failed. See https://github.com/reearth/okibi, spec/tile-demand.md.
//
// Everything here is best-effort. Nothing in this file may fail a tile
// response: the ledger is worth a lot and no single tile is worth losing for
// it.

import { quadkeyForTile } from "@reearth/okibi";
import {
  type CacheLayer,
  type Epoch,
  type TileDemand,
  createWriter,
  originOf,
} from "@reearth/okibi/writer";

import epochs from "../okibi.epochs.json";
import type { TileCoords } from "./tilesets.js";

/** Where a tile sits, in the space okibi compares services in. */
export function tileSpace(coords: TileCoords): { qk: string; qk8: string } {
  const qk = quadkeyForTile("web-mercator", coords.z, coords.x, coords.y);
  return { qk, qk8: qk.slice(0, 8) };
}

/**
 * What a caller of `serveRenderedTile` says about the tile it is serving.
 *
 * The epochs are the ones the cache key was built from, handed over rather
 * than rebuilt: this service resolves the mirror snapshot at request time, so
 * part of its key is a string no configuration file could hold, and an event
 * that reconstructed it a second way would be describing a tile that does not
 * exist.
 */
export interface Demand {
  tileset: string;
  coords: TileCoords;
  fmt: string;
  epoch: Epoch;
}

/**
 * Write one event, if the binding is there.
 *
 * The binding is optional so that a deployment without Analytics Engine — a
 * preview, a fork, `wrangler dev` — serves tiles exactly as before.
 */
export function writeDemand(
  env: Env,
  request: Request,
  demand: Demand,
  cacheStatus: "hit" | "miss",
  layer: CacheLayer | undefined,
  genMs: number,
  bytes: number,
): void {
  if (!env.TILE_DEMAND) return;

  try {
    writeChecked(env, request, demand, cacheStatus, layer, genMs, bytes);
  } catch (error) {
    // Projection refuses a tile that is off its grid, and building an event
    // is not worth a failed tile: this runs on the response path, and the
    // caller has already produced the bytes somebody asked for.
    console.warn("okibi:", error);
  }
}

/**
 * The identifier okibi rebuilds this request's URL from.
 *
 * Taken from the request rather than composed from the coordinates, because
 * this worker serves the same kind of tile at two different shapes —
 * `/styles/{theme}/tile/{z}/{x}/{y}.{ext}` for themes and paint styles,
 * `/{id}/{z}/{x}/{y}.{ext}` for the registered tilesets — and a paint style's
 * parameters are part of its cache key and live in the query string. Anything
 * assembled here would be a second way of spelling a URL that already exists,
 * and okibi's contract is that the id and the manifest's template rebuild the
 * original URL *exactly*. A composed one did not: it dropped the format
 * extension, and every URL a warm plan contained answered 404.
 *
 * The leading slash goes, so that `url_template` can end in `/{id}`.
 */
function idOf(request: Request): string {
  const url = new URL(request.url);
  return `${url.pathname.slice(1)}${url.search}`;
}

function writeChecked(
  env: Env,
  request: Request,
  demand: Demand,
  cacheStatus: "hit" | "miss",
  layer: CacheLayer | undefined,
  genMs: number,
  bytes: number,
): void {
  const { qk } = tileSpace(demand.coords);
  const event: TileDemand = {
    tileset: demand.tileset,
    kind: "content",
    id: idOf(request),
    qk,
    cacheStatus,
    // Which layer had the bytes does not change whether the tile is worth
    // warming, but it does change what serving it cost: the edge is free and
    // an R2 read is a priced operation.
    cacheLayer: layer,
    epoch: demand.epoch,
    fmt: demand.fmt,
    // Unforgeable on purpose: a bare marker anyone could send would let
    // anyone remove their own requests from the record of what people ask
    // for, and demand that is not recorded is demand that is never warmed.
    origin: originOf(request, env.OKIBI_WARM_SECRET),
    genMs,
    bytes,
    z: demand.coords.z,
  };

  createWriter({
    dataset: env.TILE_DEMAND,
    epochs,
    // A refused event must not become a refused tile. It is already the case
    // that `write` does not throw; this is where the complaint goes.
    onError: (error) => console.warn("okibi:", error),
  }).write(event);
}
