// ezu shadow renderer — the same themed cartography as the
// maplibre-native container, rendered entirely inside this worker
// (pure-CPU WASM, no container round-trip). Served at
// /styles/{theme}/ezu/{z}/{x}/{y}.png for side-by-side comparison
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
// keeps labels from splitting at tile seams), the sprite, and exactly
// the glyph ranges `neededGlyphRanges()` reports. Glyphs and the
// sprite land in a persistent bank on the renderer, so warm isolates
// skip those fetches entirely.
import { Renderer } from "@reearth/ezu";

import darkRecipe from "./ezu_recipes/dark.json";
import lightRecipe from "./ezu_recipes/light.json";
import { handleFont } from "./fonts.js";
import { handleVectorTile } from "./pmtiles.js";

const RECIPES: Record<string, unknown> = {
  light: lightRecipe,
  dark: darkRecipe,
};

/** Themes the shadow route serves. Widen alongside scripts/ezu-recipes.sh. */
export const EZU_THEMES = new Set(Object.keys(RECIPES));

/** Bump when the committed recipes are regenerated — namespaces the
 *  ezu tile cache alongside STYLE_VERSION. */
export const EZU_RECIPE_VERSION = 2;

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
  /** `${source}:${rangeStart}` already in the renderer's glyph bank. */
  boundRanges: Set<string>;
  /** Serialises bind → glyph-fetch → render sequences: the glyph fetch
   *  awaits mid-sequence, and a concurrent request clearing sources on
   *  the shared renderer there would corrupt the render. */
  lock: Promise<void>;
}

const states = new Map<string, EzuState>();

function ensureState(theme: string): EzuState {
  let st = states.get(theme);
  if (st) return st;
  const recipe = RECIPES[theme];
  if (!recipe) throw new Error(`no ezu recipe for theme ${theme}`);
  const renderer = new Renderer(JSON.stringify(recipe));
  const sources =
    (recipe as { sources?: Record<string, Record<string, unknown>> }).sources ?? {};
  let mvtSource = "";
  const glyphStacks = new Map<string, string>();
  let sprite: EzuState["sprite"] = null;
  for (const [name, decl] of Object.entries(sources)) {
    if (decl.type === "mvt") mvtSource = name;
    else if (decl.type === "glyphs") {
      glyphStacks.set(name, encodeURIComponent(String(decl.fontstack ?? "")));
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
    boundRanges: new Set(),
    lock: Promise.resolve(),
  };
  states.set(theme, st);
  return st;
}

/** An OutOfMemory renderer instance can't be reused — drop the whole
 *  state so the next request rebuilds from scratch. */
function dropState(theme: string, st: EzuState): void {
  states.delete(theme);
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

/** Fetch + bind every glyph range `neededGlyphRanges()` reports that
 *  isn't in the bank yet. Runs inside the state lock (awaits mid-
 *  sequence while tile sources are bound). */
async function ensureGlyphs(
  request: Request,
  env: Env,
  ctx: ExecutionContext,
  st: EzuState,
): Promise<void> {
  const needed = st.renderer.neededGlyphRanges() as Record<string, number[]>;
  const wanted: { source: string; stackEnc: string; start: number }[] = [];
  for (const [source, starts] of Object.entries(needed)) {
    const stackEnc = st.glyphStacks.get(source);
    if (!stackEnc) continue;
    for (const start of starts) {
      if (!st.boundRanges.has(`${source}:${start}`)) {
        wanted.push({ source, stackEnc, start });
      }
    }
  }
  if (!wanted.length) return;

  const origin = new URL(request.url).origin;
  const fetched = await Promise.all(
    wanted.map(async (w) => {
      const file = `${w.start}-${w.start + 255}.pbf`;
      // Internal call, not a self-fetch: a worker fetching its own
      // route trips Cloudflare's recursion guard.
      const synth = new Request(`${origin}/fonts/${w.stackEnc}/${file}`);
      const res = await handleFont(synth, env, ctx, w.stackEnc, file);
      if (res.status !== 200) return { ...w, bytes: null };
      return { ...w, bytes: new Uint8Array(await res.arrayBuffer()) };
    }),
  );
  // The bank is persistent; mark even the misses so known-absent
  // ranges aren't refetched on every tile.
  for (const f of fetched) {
    if (f.bytes) {
      try {
        st.renderer.bindSource(f.source, f.bytes);
      } catch (e) {
        console.warn(`ezu: glyph bind ${f.source} ${f.start}: ${String(e)}`);
      }
    }
    st.boundRanges.add(`${f.source}:${f.start}`);
  }
}

/** Render one tile with ezu. Returns encoded PNG bytes. */
export async function renderEzuTile(
  request: Request,
  env: Env,
  ctx: ExecutionContext,
  theme: string,
  coords: { z: number; x: number; y: number },
): Promise<Uint8Array | null> {
  const st = ensureState(theme);
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
    return st.renderer.renderTile(coords.z, coords.x, coords.y, { format: "png" });
  });
  st.lock = run.then(
    () => undefined,
    () => undefined,
  );
  try {
    return await run;
  } catch (e) {
    if ((e as { name?: string }).name === "OutOfMemory") {
      dropState(theme, st);
    }
    throw e;
  }
}
