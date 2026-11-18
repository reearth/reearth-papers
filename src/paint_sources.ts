// Which Papers vector tileset each `mvt` source of a style document binds.
//
// A document is data read at runtime, so the URL it gives a source must not
// decide what this worker fetches. A source resolves only when its URL is
// one of the two forms Papers publishes for a tileset, spelled exactly, and
// that tileset is one the host lets a style read. Nothing from the document
// reaches `fetch`: a resolved source is read from the tileset's own archive.

import type { PMTiles } from "pmtiles";

const SOURCE_URL =
  /^https:\/\/papers\.reearth\.land\/([a-z0-9_]+)\/(?:tilejson\.json|\{z\}\/\{x\}\/\{y\}\.mvt)$/;

/** The tileset id a source URL names, or null. Matched on the raw string:
 *  parsing it would percent-encode the template's braces. */
export function tilesetIdOfUrl(url: unknown): string | null {
  return typeof url === "string" ? (SOURCE_URL.exec(url)?.[1] ?? null) : null;
}

/** The vector tilesets a paint style may bind.
 *
 *  Listed by name rather than taken from every registry entry with an
 *  `archive`: a source is bound from the archive's stored tiles, so a
 *  tileset whose route serves something other than those tiles must never
 *  join by accident. The other Overture themes are left off until a style
 *  needs one; their low-zoom tiles are as heavy as `base`'s. */
export const PAINT_SOURCE_IDS: ReadonlySet<string> = new Set([
  "protomaps",
  "overture_base",
  "naturalearth_physical",
  "naturalearth_admin",
  "naturalearth_labels",
  "naturalearth_landuse",
  "naturalearth_transport",
  "naturalearth_bathymetry",
]);

/** The tilesets a style may bind, and their archives. */
export interface PaintSources {
  readable: ReadonlySet<string>;
  archive: (tileset: string) => Promise<PMTiles>;
}

/** An `mvt` source bound from its own tileset's archive. */
export interface ExtraSourcePlan {
  name: string;
  tileset: string;
  /** Layers the document reads from it, sorted, or null for all of them. */
  keep: readonly string[] | null;
  /** The source's declared `min-zoom`. ezu draws nothing from it below. */
  minzoom: number;
}

export interface VectorSourcePlan {
  /** The source bound from the Protomaps archive the way every themed
   *  raster's is, or null when no source takes that role. */
  primary: string | null;
  extras: readonly ExtraSourcePlan[];
  /** Sources whose URL names no tileset in `readable`. `bound` is true for
   *  the one that is the primary all the same. */
  unresolved: readonly { name: string; url: string; bound: boolean }[];
}

/** A key JavaScript moves to the front of an object, in numeric order,
 *  whatever its place in the JSON text. */
function isArrayIndex(key: string): boolean {
  return /^(?:0|[1-9]\d*)$/.test(key) && Number(key) < 2 ** 32 - 1;
}

const plans = new WeakMap<object, Map<ReadonlySet<string>, VectorSourcePlan>>();

/**
 * Plan how the document's `mvt` sources bind.
 *
 * The primary keeps today's rule: the last `mvt` source, bound from the
 * Protomaps archive. When that source names another tileset it binds from
 * its own, and the primary is the last source naming `protomaps`, if any.
 * Which source is last is not trusted when the document has several `mvt`
 * sources and one has an integer-like name, because JSON object order
 * then differs between this worker and the ezu CLI: only a source naming
 * `protomaps` can be the primary.
 */
export function planVectorSources(
  doc: Record<string, unknown>,
  readable: ReadonlySet<string>,
): VectorSourcePlan {
  let byReadable = plans.get(doc);
  const held = byReadable?.get(readable);
  if (held) return held;

  const declared = (doc.sources ?? {}) as Record<string, Record<string, unknown> | null>;
  const mvt = Object.entries(declared)
    .filter(([, d]) => d?.type === "mvt")
    .map(([name, d]) => {
      const id = tilesetIdOfUrl(d!.url);
      const minzoom = d!["min-zoom"];
      return {
        name,
        url: String(d!.url ?? ""),
        tileset: id !== null && readable.has(id) ? id : null,
        minzoom: typeof minzoom === "number" ? minzoom : 0,
      };
    });

  const last = mvt.at(-1);
  const orderKnown = mvt.length <= 1 || !mvt.some((s) => isArrayIndex(s.name));
  const primary =
    (orderKnown && last && (last.tileset === null || last.tileset === "protomaps")
      ? last
      : [...mvt].reverse().find((s) => s.tileset === "protomaps")
    )?.name ?? null;

  const keep = layersRead(doc.nodes, new Set(mvt.map((s) => s.name)));
  const plan: VectorSourcePlan = {
    primary,
    extras: mvt.flatMap((s) =>
      s.tileset === null || s.name === primary
        ? []
        : [{ name: s.name, tileset: s.tileset, keep: keep.get(s.name) ?? null, minzoom: s.minzoom }],
    ),
    unresolved: mvt
      .filter((s) => s.tileset === null)
      .map((s) => ({ name: s.name, url: s.url, bound: s.name === primary })),
  };
  if (!byReadable) plans.set(doc, (byReadable = new Map()));
  byReadable.set(readable, plan);
  return plan;
}

/**
 * The layers each source is read for: every string `layer` beside a
 * `source` naming it, and every string `layer` with no `source` at all.
 * A source named anywhere else in `nodes` maps to nothing, which means
 * every layer, since there is no telling what that use reads.
 */
function layersRead(
  nodes: unknown,
  sources: ReadonlySet<string>,
): Map<string, readonly string[]> {
  const layers = new Map([...sources].map((s) => [s, new Set<string>()]));
  const all = new Set<string>();
  const walk = (v: unknown, key: string | null, parent: Record<string, unknown> | null) => {
    if (typeof v === "string") {
      const isLayerSource = key === "source" && typeof parent?.layer === "string";
      if (sources.has(v) && !isLayerSource) all.add(v);
      return;
    }
    if (Array.isArray(v)) {
      for (const x of v) walk(x, null, null);
      return;
    }
    if (!v || typeof v !== "object") return;
    const o = v as Record<string, unknown>;
    if (typeof o.layer === "string") {
      if (o.source === undefined) for (const set of layers.values()) set.add(o.layer);
      else if (typeof o.source === "string") layers.get(o.source)?.add(o.layer);
    }
    for (const [k, x] of Object.entries(o)) walk(x, k, o);
  };
  walk(nodes, null, null);
  return new Map(
    [...layers].filter(([s]) => !all.has(s)).map(([s, set]) => [s, [...set].sort()]),
  );
}

/** Why a paint tile that reads extra sources could not be rendered now.
 *  The route answers 503, uncached, so the next request tries again. */
export class PaintSourceError extends Error {
  override name = "PaintSourceError";
  readonly stage: "admission" | "read" | "slice" | "version";

  constructor(stage: PaintSourceError["stage"], message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.stage = stage;
  }
}
