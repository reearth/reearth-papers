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
  /**
   * The query string that is part of this tile's cache key, canonically
   * spelled, for the routes that have one.
   *
   * Not the request's own query. A client may append anything — a
   * cache-buster, a smoke-test stamp — and none of it changes the picture;
   * carrying it would split one tile into as many ids as people invent, and
   * put URLs in a warm plan that differ from the cached ones by noise. What
   * belongs here is what the cache key was built from, which is the same
   * string, spelled the same way.
   */
  search?: string;
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
 * The path is the request's own rather than composed from the coordinates,
 * because this worker serves the same kind of tile at two different shapes —
 * `/styles/{theme}/tile/{z}/{x}/{y}.{ext}` for themes and paint styles,
 * `/{id}/{z}/{x}/{y}.{ext}` for the registered tilesets — and a manifest has
 * one template. Anything assembled here would be a second way of spelling a
 * URL that already exists, and okibi's contract is that the id and the
 * template rebuild the original request *exactly*. A composed one did not: it
 * dropped the format extension, and every URL in a warm plan answered 404.
 *
 * The query is not the request's own. Only what the cache key was built from
 * belongs in a tile's identity; anything else a client appends would split
 * one picture into as many ids as people invent.
 *
 * The leading slash goes, so that `url_template` can end in `/{id}`.
 */
function idOf(request: Request, search: string | undefined): string {
  const path = new URL(request.url).pathname.slice(1);
  return search ? `${path}?${search}` : path;
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
    id: idOf(request, demand.search),
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
