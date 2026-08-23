// Paint styles — ezu-native cartography served as raster tiles, loaded
// from R2 at request time rather than bundled into the worker.
//
// What R2 holds is the output of a publish step: a strict JSON copy of
// each document, the assets it names, and one manifest describing the
// set. This module reads that, and what it serves from it is pixels, a
// TileJSON, and the params schema a UI needs to offer the knobs.
//
// Why the shelf and not `src/ezu_recipes/`: a style published to it
// becomes a tileset with no deploy of this worker. The themed rasters
// are the opposite case — their recipes are translated from cartography
// that lives here, so they are bundled and versioned with the code.
//
// Layout, all under `${PAINT_STYLES_PREFIX}/` (a var, so a staging
// prefix can be pointed at without a code change):
//
//   latest.json                        the manifest — the only mutable object
//   {name}/{rev}/style.json            strict JSON, comments stripped
//   {name}/{rev}/assets/...            brushes (.myb) and images the doc loads
//
// `rev` is a content hash of the document plus its
// assets. Everything downstream keys on it: the renderer state, the
// tile cache, the edge cache. So publishing a changed style orphans
// exactly that style's tiles and leaves every other style's alone — no
// version constant to remember to bump, and no way to serve a tile
// rendered from a document that is no longer the one on the shelf.
//
// The manifest is written last, so a half-uploaded revision is not a
// visible one: readers only ever see `rev`s whose objects are complete.

/** Namespaces paint renders against the renderer that produced them.
 *
 *  A style's `rev` covers the document and its assets, which is
 *  everything the *shelf* can change — but not the thing turning that
 *  document into pixels. A renderer upgrade that draws differently would
 *  otherwise leave the old tiles in place, `immutable` and unreachable,
 *  the way the themed rasters' `ezuRecipeVersion` exists to prevent.
 *
 *  So: bump this when an ezu upgrade moves what a paint style draws. It
 *  is 1 through ezu 0.8.1 — the noise fix there folds coordinates only
 *  past a bound no tile at these zooms reaches, so every tile rendered
 *  before it is still the tile that renderer would draw today. */
export const PAINT_RUNTIME_VERSION = 1;

/** Formats the paint route serves, best first (same rationale as the
 *  themed rasters: WebP encodes for free where PNG's deflate costs
 *  30-48ms, and is smaller on the wire). */
export const PAINT_FORMATS = ["webp", "png"] as const;
export type PaintFormat = (typeof PAINT_FORMATS)[number];

/** One published style, as the manifest describes it.
 *
 *  Everything a client-facing route needs is here, so serving the
 *  catalog, a TileJSON or the params schema is one memoised read of the
 *  manifest — the document itself is fetched only when a tile actually
 *  has to be rendered. These are filled in from `ezu check --json` at
 *  publish time, so they cannot drift from the document they describe. */
export interface PaintStyle {
  /** Route segment and catalog id. */
  name: string;
  /** Content hash of document + assets. Namespaces every cache. */
  rev: string;
  /** Display name. */
  title: string;
  description: string;
  /** Merged attribution of the document and its sources. */
  attribution: string;
  /** `tile-size` the document declares (or ezu's 512 default). */
  tileSize: number;
  /** Deepest zoom this style renders; the route answers 404 above it.
   *
   *  Not a property of the cartography, and — since ezu 0.8.0 reprojects
   *  a DEM from its ancestor the way it always did for vector tiles — no
   *  longer a property of what the style samples either. What sets it
   *  today is a renderer bug: past a zoom that varies by style, the wasm
   *  build panics inside the noise crate, so the shelf advertises a depth
   *  every style survives. Clients stretch the last tile past it.
   *
   *  It travels with the style rather than being a constant here, so
   *  raising it when the renderer is fixed is a republish. */
  maxzoom: number;
  /** JSON Schema for the document's `params` (ezu's own
   *  `Document::params_schema`), or null where it declares none. */
  params: ParamsSchema | null;
  /** Versions of the external data the document reads, as they were at
   *  publish time (e.g. `terrain:5` from the terrain service's TileJSON).
   *  Folded into the tile cache key, because a render is only valid for
   *  the data behind it and these tiles go out `immutable`. It is a
   *  publish-time snapshot: refreshing that upstream means republishing
   *  the shelf, which is also the moment to re-check the styles against
   *  it. */
  sourceVersion: string;
}

/** Params a client asked for, validated against the document's schema. */
export interface ParamSelection {
  /** name → value as text, for `renderTile({ params })`. Only entries
   *  that differ from the document's default are kept, so the common
   *  request renders — and caches — exactly as it did before params
   *  existed. */
  values: Record<string, string>;
  /** Sorted `k=v` join of `values`, or `""` for all-defaults. Goes in
   *  the cache key verbatim rather than hashed: it is short (the names
   *  are declared, the values are numbers, colors and bools), and a key
   *  you can read is a key you can debug. */
  canonical: string;
}

/** The subset of JSON Schema ezu emits for a document's params. */
export interface ParamsSchema {
  type: "object";
  properties: Record<string, ParamProperty>;
  [k: string]: unknown;
}

export interface ParamProperty {
  type: "number" | "string" | "boolean";
  default?: unknown;
  minimum?: number;
  maximum?: number;
  description?: string;
  format?: string;
  pattern?: string;
}

interface Manifest {
  styles: PaintStyle[];
}

const DEFAULT_PREFIX = "styles";

/** How long an isolate trusts the manifest it read.
 *
 *  The mirror pointer next door uses an hour, and for a monthly rebuild
 *  that is right. This one is different: the manifest is also the lever
 *  for a style's advertised depth, and lowering that is something you do
 *  because tiles are failing. An hour of isolates disagreeing — some
 *  serving the old ceiling, some the new — is an hour of a fix being
 *  half-applied, which is what the first attempt at exactly that looked
 *  like.
 *
 *  Ten minutes costs one R2 GET per isolate per ten minutes, which is
 *  nothing beside a render, and bounds how long a publish takes to mean
 *  something everywhere. */
const MANIFEST_TTL_MS = 10 * 60 * 1000;

interface CachedManifest {
  styles: PaintStyle[];
  expires: number;
}

let manifestCache: CachedManifest | null = null;

/** Documents already read, keyed `{name}/{rev}` — immutable by
 *  construction, so an isolate never has to re-read one. Bounded
 *  because a revision that stops being current stops being asked for,
 *  and the entries are tens of kilobytes. */
const documents = new Map<string, Record<string, unknown>>();

function prefix(env: Env): string {
  return env.PAINT_STYLES_PREFIX || DEFAULT_PREFIX;
}

/** Read the manifest, memoised per isolate.
 *
 *  A missing or malformed manifest means "no paint styles", not an
 *  error: this shelf is optional, and the rest of the service must
 *  answer regardless. */
export async function paintStyles(env: Env): Promise<PaintStyle[]> {
  const now = Date.now();
  if (manifestCache && manifestCache.expires > now) return manifestCache.styles;
  let styles: PaintStyle[] = [];
  try {
    const obj = await env.R2.get(`${prefix(env)}/latest.json`);
    if (obj) {
      const parsed = JSON.parse(await obj.text()) as Manifest;
      // Entry by entry: one bad record in a publish should cost that
      // style, not the shelf.
      styles = (parsed.styles ?? []).flatMap((s) => {
        const ok = validate(s);
        if (!ok) console.warn(`paint: skipping malformed entry ${s?.name ?? "?"}`);
        return ok ? [ok] : [];
      });
    }
  } catch (e) {
    console.warn(`paint: manifest read: ${String(e)}`);
  }
  manifestCache = { styles, expires: now + MANIFEST_TTL_MS };
  return styles;
}

export async function paintStyle(env: Env, name: string): Promise<PaintStyle | null> {
  return (await paintStyles(env)).find((s) => s.name === name) ?? null;
}

function validate(s: PaintStyle | undefined): PaintStyle | null {
  if (!s || typeof s.name !== "string" || typeof s.rev !== "string") return null;
  // The name is a path segment on both sides — the public route and the
  // R2 key — so keep it to what both can hold unambiguously.
  if (!/^[a-z][a-z0-9-]*$/.test(s.name)) return null;
  if (!/^[a-z0-9]+$/.test(s.rev)) return null;
  if (!Number.isInteger(s.maxzoom) || s.maxzoom < 0 || s.maxzoom > 24) return null;
  return {
    name: s.name,
    rev: s.rev,
    title: typeof s.title === "string" && s.title ? s.title : s.name,
    description: typeof s.description === "string" ? s.description : "",
    attribution: typeof s.attribution === "string" ? s.attribution : "",
    tileSize: Number.isInteger(s.tileSize) ? s.tileSize : 512,
    maxzoom: s.maxzoom,
    params: s.params && typeof s.params === "object" ? s.params : null,
    sourceVersion: typeof s.sourceVersion === "string" ? s.sourceVersion : "",
  };
}

/** Colour form ezu accepts (its own `params_schema` emits this pattern). */
const COLOR_RE = /^#[0-9a-fA-F]{6}([0-9a-fA-F]{2})?$/;

/** Decimal places a number param is rounded to for the cache key.
 *  Without this a slider dragged through `0.2800001` mints a tile
 *  namespace nobody will ask for twice. Four is finer than any of these
 *  knobs can be seen at. */
const PARAM_DECIMALS = 4;

/** Defensive ceiling on the canonical string, since it lands in an R2
 *  key (1024 bytes) and an edge-cache URL. Declared params cannot reach
 *  it; a manifest that somehow declares hundreds would fail loudly here
 *  rather than by writing an unusable key. */
const CANONICAL_MAX = 512;

/** Read the params a request asks for.
 *
 *  Only declared names are read. Anything else in the query string is
 *  left alone rather than rejected: tile URLs collect cache-busters and
 *  analytics junk in the wild, and a map that goes blank because of a
 *  stray `?_=` is a worse failure than a knob that quietly wasn't a
 *  knob. A *declared* name with a bad value is an error, though — that
 *  one is a client bug worth reporting, and it is what the response
 *  echoes in `x-ezu-params` when it isn't.
 *
 *  Returns a string on rejection, for the caller to put in a 400. */
export function readParams(
  style: PaintStyle,
  search: URLSearchParams,
): ParamSelection | string {
  const props = style.params?.properties ?? {};
  const values: Record<string, string> = {};
  for (const [name, prop] of Object.entries(props)) {
    const raw = search.get(name);
    if (raw === null) continue;
    const norm = normalizeParam(name, prop, raw);
    if (typeof norm !== "string") return norm.error;
    // A value equal to the default is not an override: dropping it keeps
    // one canonical spelling per rendered picture, so `?grain=0.28` and
    // no query at all share a cache entry instead of rendering twice.
    if (norm === canonicalDefault(prop)) continue;
    values[name] = norm;
  }
  const canonical = Object.keys(values)
    .sort()
    .map((k) => `${k}=${values[k]}`)
    .join("&");
  if (canonical.length > CANONICAL_MAX) {
    return `too many params (${canonical.length} chars)`;
  }
  return { values, canonical };
}

/** One value, in the spelling both ezu and the cache key should see.
 *  Returns `{ error }` rather than throwing so the caller can answer
 *  400 with the reason. */
function normalizeParam(
  name: string,
  prop: ParamProperty,
  raw: string,
): string | { error: string } {
  if (prop.type === "boolean") {
    if (raw !== "true" && raw !== "false") {
      return { error: `param \`${name}\`: expected true or false, got \`${raw}\`` };
    }
    return raw;
  }
  if (prop.type === "number") {
    const n = Number(raw);
    if (!Number.isFinite(n)) {
      return { error: `param \`${name}\`: \`${raw}\` is not a number` };
    }
    // Range is refused, not clamped — the same call one zoom deeper
    // would otherwise render a different picture from the same URL, and
    // ezu itself rejects an out-of-range `--param`.
    if (prop.minimum !== undefined && n < prop.minimum) {
      return { error: `param \`${name}\`: ${n} is below min ${prop.minimum}` };
    }
    if (prop.maximum !== undefined && n > prop.maximum) {
      return { error: `param \`${name}\`: ${n} is above max ${prop.maximum}` };
    }
    return String(round(n));
  }
  // string: the only string param ezu declares is a colour.
  if (prop.format === "color" || prop.pattern) {
    if (!COLOR_RE.test(raw)) {
      return { error: `param \`${name}\`: \`${raw}\` is not #rrggbb[aa]` };
    }
    return raw.toLowerCase();
  }
  return raw;
}

function round(n: number): number {
  const f = 10 ** PARAM_DECIMALS;
  return Math.round(n * f) / f;
}

/** The declared default in the same spelling `normalizeParam` produces,
 *  so the two can be compared. */
function canonicalDefault(prop: ParamProperty): string | null {
  const d = prop.default;
  if (typeof d === "number") return String(round(d));
  if (typeof d === "boolean") return String(d);
  if (typeof d === "string") return prop.format === "color" ? d.toLowerCase() : d;
  return null;
}

/** The style document, parsed. Strict JSON by construction: ezu accepts
 *  comments in a document and the publish step blanks them, because this
 *  side has to read the `sources` block itself and a JSONC parser in the
 *  worker would be a second implementation of ezu's. */
export async function paintDocument(
  env: Env,
  style: PaintStyle,
): Promise<Record<string, unknown>> {
  const key = `${style.name}/${style.rev}`;
  const held = documents.get(key);
  if (held) return held;
  const obj = await env.R2.get(`${prefix(env)}/${key}/style.json`);
  if (!obj) throw new Error(`paint: no document for ${key}`);
  const doc = JSON.parse(await obj.text()) as Record<string, unknown>;
  documents.set(key, doc);
  return doc;
}

/** One asset the document loads (`"src": "file:brushes/2B_pencil.myb"`
 *  → `brushes/2B_pencil.myb`). Returns null when it isn't there, which
 *  the renderer reports as a missing brush rather than a failed tile. */
export async function paintAsset(
  env: Env,
  style: PaintStyle,
  path: string,
): Promise<Uint8Array | null> {
  // `file:` paths come from a document we published, but they land in an
  // R2 key, so refuse anything that could climb out of the style's own
  // prefix.
  if (path.includes("..") || path.startsWith("/")) {
    console.warn(`paint: refusing asset path ${path}`);
    return null;
  }
  const obj = await env.R2.get(
    `${prefix(env)}/${style.name}/${style.rev}/assets/${path}`,
  );
  if (!obj) return null;
  return new Uint8Array(await obj.arrayBuffer());
}
