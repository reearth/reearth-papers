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
import { type CjkFlavor } from "./cjk_flavor.js";
import { handleFont } from "./fonts.js";
import {
  buildSubsetPbf,
  glyphStoreStats,
  hasGlyph,
  ingestGlyphPbf,
  loadStoreSeed,
  serializeStore,
} from "./glyphs.js";
import { handleVectorTile } from "./pmtiles.js";
import { handleSprite, upstreamSpritePath } from "./sprites.js";

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
 *  changes the pixels — 3 was the ezu 0.5.0 paint fix, 4 the CJK flavors,
 *  which re-render every tile over Chinese-script regions. Without a bump
 *  the old renders sit in the cache next to the new ones. */
export const EZU_RECIPE_VERSION = 4;

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
  /** `${fontstack}:${codepoint}` the mirror turned out to have no glyph
   *  for. Without this every tile mentioning one refetches its block. */
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

// Memory is the one thing about this route that has bitten us and the one
// unexplained failure it produced (a `RangeError` out of the wasm-bindgen
// glue under load) is not reproducible — so the ezu route stamps what the
// renderer is holding onto every response. If it recurs, these say whether
// the subset path stopped bounding the bank.
let lastHeapBytes = 0;
let lastGlyphBytes = 0;

export function ezuRenderStats(): {
  heapBytes: number;
  glyphBytes: number;
  storeBytes: number;
  storeGlyphs: number;
} {
  const store = glyphStoreStats();
  return {
    heapBytes: lastHeapBytes,
    glyphBytes: lastGlyphBytes,
    storeBytes: store.bytes,
    storeGlyphs: store.entries,
  };
}

// Renderers retained per isolate. This was 1 while a resident CJK theme
// cost 82MB and a second put the isolate past its 128MB ceiling; binding
// per-codepoint subsets (src/glyphs.ts) took the glyph bank out of that
// number, and `memoryUsage().heapBytes` after a Tokyo z14 render now reads
//
//     1 theme   45MB      4 themes   79MB
//     2 themes  59MB      5 themes   91MB
//     3 themes  67MB
//
// ~12MB per additional theme, because the worker-side glyph store is
// shared across them — the protomaps recipes name the same glyph sources,
// so a second theme adds a renderer, not another copy of the glyphs.
//
// Three leaves ~60MB of headroom and, unlike one, does not throw away a
// warm renderer every time an isolate is asked for a second theme. Wasm
// linear memory is still a high-water mark, so this is a ceiling to stay
// under rather than something eviction can walk back.
const MAX_STATES = 3;

// Cap concurrent renders per isolate. `renderTile` is a synchronous WASM
// call, so this never buys render parallelism — it bounds how much tile
// data is resident at once while their fetches overlap. Four was set when
// that resident cost was the thing tipping isolates over; measured now,
// twelve concurrent renders of a single theme peak at 28MB of heap, so the
// bound can sit above a viewport's tile count instead of splitting one
// into two waves of fetches.
const MAX_CONCURRENT_RENDERS = 8;

/** Per-fontstack ceiling ezu trims the glyph bank to after each render. */
const GLYPH_BUDGET_BYTES = 4 * 1024 * 1024;

// Cold start is the one thing per-codepoint binding did not fix: the first
// tile over an unseen area still pulls whole 256-codepoint blocks, because
// blocks are all `/fonts` can serve. So carry the store across isolates —
// one R2 object holding what previous isolates learned to need, which for
// this traffic converges on a few thousand glyphs. Reading it is one GET
// of ~1MB against up to 38MB of blocks.
//
// It is a cache in every sense: concurrent isolates overwrite each other
// (last write wins, and they are writing near-identical sets), a miss just
// means the blocks get fetched as before, and the key is versioned so a
// format change orphans the old object instead of misreading it.
const GLYPH_SEED_KEY = `cache/ezu-glyphs/v${EZU_RECIPE_VERSION}.pbf`;
/** Don't rewrite the seed for every handful of new glyphs. */
const GLYPH_SEED_REWRITE_RATIO = 1.25;
/** Ceiling on the seed object. Every cold isolate reads it, so it is held
 *  well under the store's own 8MB budget. */
const GLYPH_SEED_MAX_BYTES = 3 * 1024 * 1024;

let seedLoaded: Promise<void> | null = null;
let seedGlyphsAtLastWrite = 0;
let seedWriteInFlight = false;

/** Read the shared seed once per isolate. Failure is not an error: the
 *  block path behind it produces the same glyphs, only slower. */
function ensureGlyphSeed(env: Env): Promise<void> {
  seedLoaded ??= (async () => {
    try {
      const obj = await env.R2.get(GLYPH_SEED_KEY);
      if (!obj) return;
      const loaded = loadStoreSeed(new Uint8Array(await obj.arrayBuffer()));
      seedGlyphsAtLastWrite = glyphStoreStats().entries;
      console.log(`ezu: glyph seed loaded (${loaded} glyphs)`);
    } catch (e) {
      console.warn(`ezu: glyph seed load: ${String(e)}`);
    }
  })();
  return seedLoaded;
}

/** Write the store back once it has grown meaningfully past what the seed
 *  held, so the next cold isolate starts where this one got to. */
function maybeWriteGlyphSeed(env: Env, ctx: ExecutionContext): void {
  const { entries } = glyphStoreStats();
  if (seedWriteInFlight || entries < 64) return;
  if (entries < seedGlyphsAtLastWrite * GLYPH_SEED_REWRITE_RATIO) return;
  seedGlyphsAtLastWrite = entries;
  const bytes = serializeStore(GLYPH_SEED_MAX_BYTES);
  if (!bytes) return;
  // One at a time: a burst of concurrent renders over a new area crosses
  // the growth threshold repeatedly, and each write is the whole store.
  seedWriteInFlight = true;
  ctx.waitUntil(
    env.R2.put(GLYPH_SEED_KEY, bytes, {
      httpMetadata: { contentType: "application/x-protobuf" },
    })
      .catch((e) => console.warn(`ezu: glyph seed write: ${String(e)}`))
      .finally(() => {
        seedWriteInFlight = false;
      }),
  );
}

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

/** The committed recipes are the JP-first flavor. The only thing `?cjk=`
 *  changes in the style it was translated from is which fontstack the
 *  glyph sources name — "Noto Sans Regular" becomes "Noto Sans Regular
 *  SC" / " TC", same layers, same everything else — so the variants are a
 *  string rewrite rather than ten more recipes to bake and bundle. The
 *  suffixed stacks are already in the mirror (mirror/fonts/out). */
function recipeFor(theme: string, flavor: CjkFlavor | null): unknown {
  const recipe = RECIPES[theme];
  if (!recipe || !flavor) return recipe;
  const suffix = flavor === "sc" ? " SC" : " TC";
  const clone = structuredClone(recipe) as {
    sources?: Record<string, Record<string, unknown>>;
  };
  for (const decl of Object.values(clone.sources ?? {})) {
    if (decl.type === "glyphs" && typeof decl.fontstack === "string") {
      decl.fontstack = `${decl.fontstack}${suffix}`;
    }
  }
  return clone;
}

/** Renderers are per theme *and* per CJK flavor: the flavor picks a
 *  different set of Han glyph variants, so they cannot share one. */
function stateKey(theme: string, flavor: CjkFlavor | null): string {
  return flavor ? `${theme}:${flavor}` : theme;
}

function ensureState(theme: string, flavor: CjkFlavor | null): EzuState {
  const key = stateKey(theme, flavor);
  let st = states.get(key);
  if (st) {
    st.lastUsed = ++useCounter;
    return st;
  }
  const recipe = recipeFor(theme, flavor);
  if (!recipe) throw new Error(`no ezu recipe for theme ${theme}`);
  console.log(`ezu: init ${key} (simd: ${simdEnabled()})`);
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
  states.set(key, st);
  evictStates(key);
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

/** Fetch a sprite asset through our own mirror where the recipe points at
 *  Protomaps', so a cold isolate does not wait on GitHub Pages. Anything
 *  we don't mirror is fetched as written. */
async function fetchSpriteAsset(
  request: Request,
  env: Env,
  ctx: ExecutionContext,
  url: string,
): Promise<Response> {
  const path = upstreamSpritePath(url);
  if (!path) return fetch(url);
  // Internal call, not a self-fetch: a worker fetching its own route
  // trips Cloudflare's recursion guard.
  const origin = new URL(request.url).origin;
  const synth = new Request(`${origin}/sprites/${path}`);
  return handleSprite(synth, env, ctx, path);
}

async function ensureSprite(
  request: Request,
  env: Env,
  ctx: ExecutionContext,
  st: EzuState,
): Promise<void> {
  if (!st.sprite) return;
  st.spriteReady ??= (async () => {
    const [atlas, index] = await Promise.all([
      fetchSpriteAsset(request, env, ctx, st.sprite!.image).then((r) => {
        if (!r.ok) throw new Error(`sprite atlas: HTTP ${r.status}`);
        return r.arrayBuffer();
      }),
      fetchSpriteAsset(request, env, ctx, st.sprite!.index).then((r) => {
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
  if (Object.keys(needed).length) await ensureGlyphSeed(env);

  // The store is keyed by fontstack, not by the recipe's source name: a
  // CJK flavor swaps the fontstack behind the same source, and the SC and
  // JP forms of a Han codepoint are different glyphs that must not share
  // an entry.
  const blocks: { stack: string; stackEnc: string; start: number }[] = [];
  for (const [source, cps] of Object.entries(needed)) {
    const stackEnc = st.glyphStacks.get(source);
    const stack = st.glyphFontstacks.get(source);
    if (!stackEnc || !stack) continue;
    const starts = new Set<number>();
    for (const cp of cps) {
      if (hasGlyph(stack, cp) || st.absentGlyphs.has(`${stack}:${cp}`)) continue;
      starts.add(Math.floor(cp / 256) * 256);
    }
    for (const start of starts) blocks.push({ stack, stackEnc, start });
  }

  if (blocks.length) {
    const origin = new URL(request.url).origin;
    const wantedByStack = new Map<string, Set<number>>();
    for (const [source, cps] of Object.entries(needed)) {
      const stack = st.glyphFontstacks.get(source);
      if (stack) wantedByStack.set(stack, new Set(cps));
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
    // Only blocks that actually arrived and parsed can tell us a glyph is
    // missing. Marking a codepoint absent because its fetch failed would
    // stop this isolate ever asking for it again — the label would render
    // short for the isolate's whole life, and the wrong tile would be
    // cached. A failed block is simply retried by the next tile.
    const settled = new Set<string>();
    for (const f of fetched) {
      if (!f.bytes) continue;
      try {
        ingestGlyphPbf(f.stack, f.bytes, wantedByStack.get(f.stack) ?? new Set());
        settled.add(`${f.stack}:${f.start}`);
      } catch (e) {
        console.warn(`ezu: glyph parse ${f.stack} ${f.start}: ${String(e)}`);
      }
    }
    // A codepoint the mirror genuinely has no glyph for would otherwise
    // refetch its block on every tile that mentions it.
    for (const [source, cps] of Object.entries(needed)) {
      const stack = st.glyphFontstacks.get(source);
      if (!stack) continue;
      for (const cp of cps) {
        const block = `${stack}:${Math.floor(cp / 256) * 256}`;
        if (settled.has(block) && !hasGlyph(stack, cp)) {
          st.absentGlyphs.add(`${stack}:${cp}`);
        }
      }
    }
    maybeWriteGlyphSeed(env, ctx);
  }

  for (const [source, cps] of Object.entries(needed)) {
    const fontstack = st.glyphFontstacks.get(source);
    if (!fontstack) continue;
    const subset = buildSubsetPbf(fontstack, fontstack, cps);
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
  flavor: CjkFlavor | null,
): Promise<Uint8Array | null> {
  // Taken before the first buffer is allocated, not just around the WASM
  // call: what has to stay bounded is how much tile data is resident at
  // once, and a request queued here holds nothing.
  await acquireRenderPermit();
  try {
    return await renderEzuTileInner(request, env, ctx, theme, coords, format, flavor);
  } finally {
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
  flavor: CjkFlavor | null,
): Promise<Uint8Array | null> {
  const st = ensureState(theme, flavor);
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
  await ensureSprite(request, env, ctx, st);

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
    // Everything a post-mortem needs, in one line. ezu raises a named
    // `OutOfMemory` carrying `requestedBytes` when the wasm heap cannot
    // grow, so an error that is *not* that one did not come from a failed
    // allocation — which is exactly the distinction the `RangeError` seen
    // under load in August left unresolved. Pair the name with what the
    // renderer was holding at the time so the next occurrence is decidable
    // instead of inferred.
    const err = e as { name?: string; message?: string; requestedBytes?: number };
    let usage = "unavailable";
    try {
      usage = JSON.stringify(st.renderer.memoryUsage());
    } catch {
      // A poisoned instance may not answer; the name alone is still useful.
    }
    console.warn(
      `ezu: render failed ${theme}/${coords.z}/${coords.x}/${coords.y} ` +
        `name=${err.name ?? "?"} requestedBytes=${err.requestedBytes ?? "-"} ` +
        `inFlight=${activePermits} usage=${usage} msg=${err.message ?? String(e)}`,
    );
    if (isRendererFatal(e)) dropState(theme, st);
    throw e;
  }
}
