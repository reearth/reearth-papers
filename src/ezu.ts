// ezu shadow renderer — the same themed cartography as the
// maplibre-native container, rendered entirely inside this worker
// (pure-CPU WASM, no container round-trip). Served at
// /styles/{theme}/ezu/{z}/{x}/{y}.{webp,png} for side-by-side comparison
// (viewer `?compare=ezu`); the container path stays authoritative
// until the comparison graduates to a cutover.
//
// The recipes under src/ezu_recipes/ are pre-translated from the
// production `style.json?renderer=1` documents (scripts/ezu-recipes.sh)
// because the WASM build ships the renderer only, not the MapLibre →
// recipe translator. Regenerate + commit them whenever the style
// pipeline changes (ezu-cli ≥ 0.4.1 — older recipes render but lose
// part of the memory win).
//
// The WASM renderer owns no I/O: this module fetches the MVTs (centre
// + the neighbours the recipe asks for — ezu's label collision is
// world-space deterministic and reads neighbour tiles, which is what
// keeps labels from splitting at tile seams), the sprite, and the
// glyphs. Glyphs go through src/glyphs.ts: `neededCodepoints()` names
// them individually, and only those are kept and re-bound as a subset
// message, so the renderer's bank holds a tile's worth rather than the
// ~38MB of 256-codepoint blocks the same labels used to drag in. The
// sprite lands in a persistent bank, so warm isolates skip that fetch.
// The /simd variant: workerd supports WASM SIMD128, and the scalar
// build leaves a 1.5-3x pixel-loop speedup on the table.
import { Renderer, simdEnabled } from "@reearth/ezu/simd";

import papersDarkRecipe from "./ezu_recipes/papers-dark.json";
import papersLightRecipe from "./ezu_recipes/papers-light.json";
import protomapsBlackRecipe from "./ezu_recipes/protomaps-black.json";
import protomapsDarkRecipe from "./ezu_recipes/protomaps-dark.json";
import protomapsGrayscaleRecipe from "./ezu_recipes/protomaps-grayscale.json";
import protomapsLightRecipe from "./ezu_recipes/protomaps-light.json";
import protomapsWhiteRecipe from "./ezu_recipes/protomaps-white.json";
import { handleFont } from "./fonts.js";
import { buildSubsetPbf, glyphStoreStats, hasGlyph, ingestGlyphPbf } from "./glyphs.js";
import { handleVectorTile } from "./pmtiles.js";

const RECIPES: Record<string, unknown> = {
  // The papers house styles are label-free: their recipes carry no
  // glyph or sprite sources, so their renders skip every asset fetch.
  "papers-light": papersLightRecipe,
  "papers-dark": papersDarkRecipe,
  "protomaps-light": protomapsLightRecipe,
  "protomaps-dark": protomapsDarkRecipe,
  "protomaps-white": protomapsWhiteRecipe,
  "protomaps-black": protomapsBlackRecipe,
  "protomaps-grayscale": protomapsGrayscaleRecipe,
};

/** Themes the shadow route serves. Widen alongside scripts/ezu-recipes.sh. */
export const EZU_THEMES = new Set(Object.keys(RECIPES));

/** Namespaces the ezu tile cache alongside STYLE_VERSION. Bump when the
 *  committed recipes are regenerated, and equally when a renderer upgrade
 *  changes the pixels — 3 is the ezu 0.5.0 paint fix, which otherwise
 *  leaves pre-upgrade renders sitting in the cache next to new ones. */
export const EZU_RECIPE_VERSION = 3;

/** The protomaps vector source carries data through z15; the shadow
 *  route doesn't overzoom (comparison happens within range). */
export const EZU_MAXZOOM = 15;

interface EzuState {
  renderer: InstanceType<typeof Renderer>;
  mvtSource: string;
  /** Offsets the recipe wants beyond the centre tile. */
  neighborOffsets: [number, number][];
  /** glyphs source name → percent-encoded fontstack for /fonts. */
  glyphStacks: Map<string, string>;
  sprite: { name: string; image: string; index: string } | null;
  spriteReady: Promise<void> | null;
  /** glyphs source name → the fontstack name to stamp on subset PBFs. */
  glyphFontstacks: Map<string, string>;
  /** `${source}:${codepoint}` the mirror turned out to have no glyph for.
   *  Without this every tile mentioning one refetches its whole block. */
  absentGlyphs: Set<string>;
  /** Serialises bind → glyph-fetch → render sequences: the glyph fetch
   *  awaits mid-sequence, and a concurrent request clearing sources on
   *  the shared renderer there would corrupt the render. */
  lock: Promise<void>;
  /** Renders currently using this state. A state with work in flight
   *  must never be evicted — `free()` under an active render would
   *  pull the renderer out from under it. */
  inFlight: number;
  /** Monotonic stamp for LRU eviction (a counter, not a clock: Workers
   *  freezes `Date.now()` between I/O so it can't order same-tick uses). */
  lastUsed: number;
  /** Evicted from `states`, but still referenced by renders that were
   *  already running. The last one out calls `free()`. */
  disposed: boolean;
}

const states = new Map<string, EzuState>();
let useCounter = 0;

// Diagnostics for the isolate-spread question: `renderTile` is synchronous,
// so tiles sharing an isolate can only render one after another. Whether a
// viewport's tiles land on one isolate or several is not something the
// platform documents or we can set, so measure it — the ezu route stamps
// these onto every response (see `handleEzu`) and a burst of requests shows
// how many distinct isolates answered.
let isolateId: string | null = null;
let rendersServed = 0;
let lastHeapBytes = 0;
let lastGlyphBytes = 0;

/** Stable per-isolate label. Generated lazily: a module-scope RNG call runs
 *  outside any request's I/O context. */
export function ezuIsolateId(): string {
  isolateId ??= Math.random().toString(36).slice(2, 10);
  return isolateId;
}

/** Renders this isolate has completed, renders running right now, and what
 *  the renderer reported holding after the last one (`memoryUsage()`). */
export function ezuRenderStats(): {
  served: number;
  inFlight: number;
  heapBytes: number;
  glyphBytes: number;
  storeBytes: number;
  storeGlyphs: number;
} {
  const store = glyphStoreStats();
  return {
    served: rendersServed,
    inFlight: activePermits,
    heapBytes: lastHeapBytes,
    glyphBytes: lastGlyphBytes,
    storeBytes: store.bytes,
    storeGlyphs: store.entries,
  };
}

// One. `memoryUsage().heapBytes` on a CJK-dense theme, measured after a
// Tokyo z14 render, is what forces this:
//
//     1 theme resident   82MB   (36MB of it the glyph bank)
//     2 themes          136MB   ← already past the 128MB isolate ceiling
//     3 themes          182MB
//
// and wasm linear memory is a high-water mark — evicting a state lets the
// allocator reuse the space but never returns it, so a second theme can
// only be prevented, not recovered from. Retaining one renderer still
// keeps the warm-isolate win that matters (its glyph bank); the cost of
// this cap is a rebuild when a single isolate is asked to serve two
// themes, which only the side-by-side comparison view does.
const MAX_STATES = 1;

// Cap concurrent renders per isolate. `renderTile` is a synchronous WASM
// call, so extra concurrency buys no render parallelism — it only overlaps
// the surrounding I/O while every in-flight request keeps its MVT buffers,
// glyph PBFs, and PNG output alive. Past ~6 concurrent renders that extra
// resident memory pushes the isolate into the ceiling and the renderer
// starts returning bogus (ptr, len) pairs, which surface as
// `RangeError: Invalid array buffer length` from the wasm-bindgen glue
// (HTTP 500 → MapLibre falls back to the parent zoom → serial retry waves).
const MAX_CONCURRENT_RENDERS = 4;

/** Per-fontstack ceiling ezu trims the glyph bank to after each render. */
const GLYPH_BUDGET_BYTES = 4 * 1024 * 1024;

/** Give up waiting and render anyway rather than sit here forever — a
 *  slow tile is recoverable, a request that never answers is not. */
const PERMIT_WAIT_BUDGET_MS = 20_000;
const PERMIT_POLL_MS = 10;

let activePermits = 0;

async function acquireRenderPermit(): Promise<void> {
  // Polling, not a queue of resolvers: a promise that only another
  // request's execution context can settle is not something workerd
  // lets us await. It sees a request with no pending I/O of its own and
  // cancels it ("your Worker's code had hung and would never generate a
  // response"). `setTimeout` is real I/O, so the waiter stays alive.
  const deadline = Date.now() + PERMIT_WAIT_BUDGET_MS;
  while (activePermits >= MAX_CONCURRENT_RENDERS && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, PERMIT_POLL_MS));
  }
  // No `await` between the check above and the increment, so the pair is
  // atomic on this single-threaded isolate — waiters can't overshoot.
  activePermits++;
}

function releaseRenderPermit(): void {
  activePermits--;
}

/** Evict least-recently-used renderer states until at most `MAX_STATES`
 *  remain. Skips anything with a render in flight and the theme being
 *  served right now. */
function evictStates(keep: string): void {
  while (states.size > MAX_STATES) {
    let victim: [string, EzuState] | null = null;
    for (const entry of states) {
      if (entry[0] === keep || entry[1].inFlight > 0) continue;
      if (!victim || entry[1].lastUsed < victim[1].lastUsed) victim = entry;
    }
    if (!victim) return; // everything else is busy — try again next tile
    console.log(`ezu: evict ${victim[0]} (states=${states.size})`);
    dropState(victim[0], victim[1]);
  }
}

function ensureState(theme: string): EzuState {
  let st = states.get(theme);
  if (st) {
    st.lastUsed = ++useCounter;
    return st;
  }
  const recipe = RECIPES[theme];
  if (!recipe) throw new Error(`no ezu recipe for theme ${theme}`);
  console.log(`ezu: init ${theme} (simd: ${simdEnabled()})`);
  const renderer = new Renderer(JSON.stringify(recipe));
  // Per-fontstack ceiling on the glyph bank. Safe to set low only because
  // `ensureGlyphs` re-binds the tile's subset every render out of the
  // worker-side store — anything ezu trims costs a rebuild, not a refetch.
  // Comfortably above one tile's worth (~1.2MB across all three stacks),
  // so consecutive tiles over the same city still reuse what is loaded.
  renderer.setGlyphBudget(GLYPH_BUDGET_BYTES);
  const sources =
    (recipe as { sources?: Record<string, Record<string, unknown>> }).sources ?? {};
  let mvtSource = "";
  const glyphStacks = new Map<string, string>();
  const glyphFontstacks = new Map<string, string>();
  let sprite: EzuState["sprite"] = null;
  for (const [name, decl] of Object.entries(sources)) {
    if (decl.type === "mvt") mvtSource = name;
    else if (decl.type === "glyphs") {
      const fontstack = String(decl.fontstack ?? "");
      glyphStacks.set(name, encodeURIComponent(fontstack));
      glyphFontstacks.set(name, fontstack);
    } else if (decl.type === "sprite") {
      sprite = { name, image: String(decl.image), index: String(decl.index) };
    }
  }
  if (!mvtSource) throw new Error(`recipe ${theme} has no mvt source`);
  const neighborOffsets = (
    renderer.requestedNeighborOffsets(mvtSource) as [number, number][]
  ).filter(([dx, dy]) => dx !== 0 || dy !== 0);
  st = {
    renderer,
    mvtSource,
    neighborOffsets,
    glyphStacks,
    sprite,
    spriteReady: null,
    glyphFontstacks,
    absentGlyphs: new Set(),
    lock: Promise.resolve(),
    inFlight: 0,
    lastUsed: ++useCounter,
    disposed: false,
  };
  states.set(theme, st);
  evictStates(theme);
  return st;
}

/** Errors that mean the renderer instance itself can't be trusted again.
 *
 *  `OutOfMemory` is ezu's own clean signal. The other two are what a
 *  failed heap growth actually looks like from here: the WASM allocator
 *  gives up without raising `OutOfMemory`, so the caller sees either a
 *  trap (`WebAssembly.RuntimeError`) or the wasm-bindgen glue choking on
 *  the out-of-range `(ptr, len)` it was handed (`RangeError`). Leaving
 *  the state cached after either one keeps a suspect renderer — and its
 *  whole glyph bank — resident for every later tile on this isolate. */
function isRendererFatal(e: unknown): boolean {
  const name = (e as { name?: string } | null)?.name;
  return name === "OutOfMemory" || name === "RangeError" || name === "RuntimeError";
}

/** A poisoned renderer instance can't be reused — drop the whole state
 *  so the next request rebuilds from scratch.
 *
 *  Eviction from `states` is immediate; `free()` waits until the last
 *  render holding this state finishes. Freeing under a concurrent render
 *  would pull the WASM instance out from under a `bindSource` that is
 *  still to come after its `await`. */
function dropState(theme: string, st: EzuState): void {
  if (states.get(theme) === st) states.delete(theme);
  st.disposed = true;
  if (st.inFlight === 0) freeState(st);
}

function freeState(st: EzuState): void {
  try {
    st.renderer.free();
  } catch {
    // best-effort — the instance is already poisoned
  }
}

async function fetchMvt(
  env: Env,
  z: number,
  x: number,
  y: number,
): Promise<Uint8Array | null> {
  const n = 2 ** z;
  if (y < 0 || y >= n) return null;
  // Wrap x across the antimeridian so labels stay seam-consistent there.
  const wx = ((x % n) + n) % n;
  const res = await handleVectorTile({ z, x: wx, y }, env);
  if (res.status !== 200) return null;
  const buf = new Uint8Array(await res.arrayBuffer());
  return buf.length ? buf : null;
}

async function ensureSprite(st: EzuState): Promise<void> {
  if (!st.sprite) return;
  st.spriteReady ??= (async () => {
    const [atlas, index] = await Promise.all([
      fetch(st.sprite!.image).then((r) => {
        if (!r.ok) throw new Error(`sprite atlas: HTTP ${r.status}`);
        return r.arrayBuffer();
      }),
      fetch(st.sprite!.index).then((r) => {
        if (!r.ok) throw new Error(`sprite index: HTTP ${r.status}`);
        return r.text();
      }),
    ]);
    st.renderer.bindSource(st.sprite!.name, new Uint8Array(atlas), { index });
  })();
  try {
    await st.spriteReady;
  } catch (e) {
    st.spriteReady = null; // allow a retry on the next tile
    throw e;
  }
}

/** Put exactly the glyphs this tile draws in front of the renderer.
 *
 *  `neededCodepoints()` names them one by one. Anything the store is
 *  missing is fetched as the 256-codepoint block that contains it —
 *  blocks are all `/fonts` can serve — but only the wanted glyphs are
 *  kept; the rest of the block is dropped on the floor. The subset is
 *  then rebuilt and bound on every tile rather than accumulating in the
 *  renderer, which is what lets `setGlyphBudget` hold the bank down.
 *
 *  Runs inside the state lock (awaits mid-sequence while tile sources
 *  are bound). */
async function ensureGlyphs(
  request: Request,
  env: Env,
  ctx: ExecutionContext,
  st: EzuState,
): Promise<void> {
  const needed = st.renderer.neededCodepoints() as Record<string, number[]>;

  // Which blocks have to be fetched before the subset can be assembled.
  const blocks: { source: string; stackEnc: string; start: number }[] = [];
  for (const [source, cps] of Object.entries(needed)) {
    const stackEnc = st.glyphStacks.get(source);
    if (!stackEnc) continue;
    const starts = new Set<number>();
    for (const cp of cps) {
      if (hasGlyph(source, cp) || st.absentGlyphs.has(`${source}:${cp}`)) continue;
      starts.add(Math.floor(cp / 256) * 256);
    }
    for (const start of starts) blocks.push({ source, stackEnc, start });
  }

  if (blocks.length) {
    const origin = new URL(request.url).origin;
    const wantedBySource = new Map<string, Set<number>>();
    for (const [source, cps] of Object.entries(needed)) {
      wantedBySource.set(source, new Set(cps));
    }
    const fetched = await Promise.all(
      blocks.map(async (b) => {
        const file = `${b.start}-${b.start + 255}.pbf`;
        // Internal call, not a self-fetch: a worker fetching its own
        // route trips Cloudflare's recursion guard.
        const synth = new Request(`${origin}/fonts/${b.stackEnc}/${file}`);
        const res = await handleFont(synth, env, ctx, b.stackEnc, file);
        if (res.status !== 200) return { ...b, bytes: null };
        return { ...b, bytes: new Uint8Array(await res.arrayBuffer()) };
      }),
    );
    for (const f of fetched) {
      if (!f.bytes) continue;
      try {
        ingestGlyphPbf(f.source, f.bytes, wantedBySource.get(f.source) ?? new Set());
      } catch (e) {
        console.warn(`ezu: glyph parse ${f.source} ${f.start}: ${String(e)}`);
      }
    }
    // A codepoint the mirror has no glyph for would otherwise refetch its
    // block on every tile that mentions it.
    for (const [source, cps] of Object.entries(needed)) {
      for (const cp of cps) {
        if (!hasGlyph(source, cp)) st.absentGlyphs.add(`${source}:${cp}`);
      }
    }
  }

  for (const [source, cps] of Object.entries(needed)) {
    const fontstack = st.glyphFontstacks.get(source);
    if (!fontstack) continue;
    const subset = buildSubsetPbf(source, fontstack, cps);
    if (!subset) continue;
    try {
      st.renderer.bindSource(source, subset.bytes);
    } catch (e) {
      console.warn(`ezu: glyph bind ${source}: ${String(e)}`);
    }
  }
}

/** Output encodings the ezu route serves. WebP is the default: measured
 *  against the same tile, its encode is free next to an uncompressed
 *  `rgba` render (179ms vs 190ms) where the default PNG deflate costs
 *  30-48ms, and it is ~17% smaller on the wire than that PNG. */
export type EzuFormat = "png" | "webp";

/** Render one tile with ezu. Returns the encoded image bytes. */
export async function renderEzuTile(
  request: Request,
  env: Env,
  ctx: ExecutionContext,
  theme: string,
  coords: { z: number; x: number; y: number },
  format: EzuFormat,
): Promise<Uint8Array | null> {
  // Taken before the first buffer is allocated, not just around the WASM
  // call: what has to stay bounded is how much tile data is resident at
  // once, and a request queued here holds nothing.
  await acquireRenderPermit();
  try {
    return await renderEzuTileInner(request, env, ctx, theme, coords, format);
  } finally {
    rendersServed++;
    releaseRenderPermit();
  }
}

async function renderEzuTileInner(
  request: Request,
  env: Env,
  ctx: ExecutionContext,
  theme: string,
  coords: { z: number; x: number; y: number },
  format: EzuFormat,
): Promise<Uint8Array | null> {
  const st = ensureState(theme);
  st.inFlight++;
  try {
    return await renderWithState(request, env, ctx, theme, st, coords, format);
  } finally {
    st.inFlight--;
    if (st.disposed && st.inFlight === 0) freeState(st);
  }
}

async function renderWithState(
  request: Request,
  env: Env,
  ctx: ExecutionContext,
  theme: string,
  st: EzuState,
  coords: { z: number; x: number; y: number },
  format: EzuFormat,
): Promise<Uint8Array | null> {
  await ensureSprite(st);

  const offsets: [number, number][] = [[0, 0], ...st.neighborOffsets];
  const mvts = await Promise.all(
    offsets.map(async ([dx, dy]) => ({
      dx,
      dy,
      bytes: await fetchMvt(env, coords.z, coords.x + dx, coords.y + dy),
    })),
  );

  const run = st.lock.then(async () => {
    st.renderer.clearSources();
    for (const m of mvts) {
      if (!m.bytes) continue;
      st.renderer.bindSource(
        st.mvtSource,
        m.bytes,
        m.dx || m.dy ? { coord: [m.dx, m.dy] } : undefined,
      );
    }
    await ensureGlyphs(request, env, ctx, st);
    const encoded = st.renderer.renderTile(coords.z, coords.x, coords.y, { format });
    const mu = st.renderer.memoryUsage() as { heapBytes?: number; glyphBytes?: number };
    lastHeapBytes = mu.heapBytes ?? 0;
    lastGlyphBytes = mu.glyphBytes ?? 0;
    return encoded;
  });
  st.lock = run.then(
    () => undefined,
    () => undefined,
  );
  try {
    return await run;
  } catch (e) {
    if (isRendererFatal(e)) {
      console.warn(`ezu: dropping ${theme} after ${String(e)}`);
      dropState(theme, st);
    }
    throw e;
  }
}
