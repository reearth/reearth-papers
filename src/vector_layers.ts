// TileJSON `vector_layers`, read from the archive the tiles come from.
//
// The registry in tilesets.ts says which layers a tileset advertises and
// how the viewer should draw them. What each layer carries is in the
// archive's own metadata: PMTiles v3 requires `vector_layers` there for
// MVT, and both Planetiler and tippecanoe fill in `fields`. Reading it
// keeps the TileJSON in step with whatever archive the tiles are served
// from, across Protomaps rotations and Overture releases.

import type { PMTiles } from "pmtiles";

import type { TilesetDef, VectorLayerInfo } from "./tilesets.js";

export interface ArchiveLayer {
  id: string;
  fields: Record<string, string>;
  minzoom?: number;
  maxzoom?: number;
}

export interface TileJsonVectorLayer extends VectorLayerInfo {
  maxzoom: number;
  fields: Record<string, string>;
}

export type ArchiveHandle = Pick<PMTiles, "getMetadata">;

type ArchiveLayersRead =
  | { status: "read"; layers: readonly ArchiveLayer[] }
  | { status: "failed"; error: unknown }
  | { status: "timed-out" };

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

const zoomOf = (v: unknown): number | undefined =>
  Number.isInteger(v) ? (v as number) : undefined;

/** The layers an archive's metadata lists. Never throws: anything that
 *  is not the shape the spec describes is dropped. */
export function parseArchiveLayers(metadata: unknown): ArchiveLayer[] {
  if (!isRecord(metadata) || !Array.isArray(metadata.vector_layers)) return [];
  const layers: ArchiveLayer[] = [];
  for (const raw of metadata.vector_layers) {
    if (!isRecord(raw) || typeof raw.id !== "string" || raw.id === "") continue;
    const fields: Record<string, string> = {};
    if (isRecord(raw.fields)) {
      for (const [name, type] of Object.entries(raw.fields)) {
        if (typeof type === "string") fields[name] = type;
      }
    }
    layers.push({ id: raw.id, fields, minzoom: zoomOf(raw.minzoom), maxzoom: zoomOf(raw.maxzoom) });
  }
  return layers;
}

/** The registry's layers, in its order and with its descriptions and
 *  geometry hints, carrying the archive's fields. A layer only the
 *  archive lists is left out: the viewer draws every entry, and only a
 *  person can write its description and geometry hint. */
export function mergeVectorLayers(
  registry: readonly VectorLayerInfo[],
  archive: readonly ArchiveLayer[],
  tileset: { minzoom: number; maxzoom: number },
): TileJsonVectorLayer[] {
  const byId = new Map(archive.map((l) => [l.id, l]));
  return registry.map((l) => ({
    id: l.id,
    description: l.description,
    minzoom: l.minzoom,
    maxzoom: tileset.maxzoom,
    // Non-standard hint consumed by the viewer's inspector.
    geometry: l.geometry,
    fields: byId.get(l.id)?.fields ?? {},
  }));
}

// Keyed by the handle, which the openers replace when the archive
// changes, so an entry lives exactly as long as the header cache that
// serves the tiles. Values only: a failed read is retried next time.
const memo = new WeakMap<ArchiveHandle, readonly ArchiveLayer[]>();

export async function readArchiveLayers(pm: ArchiveHandle): Promise<readonly ArchiveLayer[]> {
  const known = memo.get(pm);
  if (known) return known;
  const layers = parseArchiveLayers(await pm.getMetadata());
  memo.set(pm, layers);
  return layers;
}

/** How long a vector TileJSON waits for its archive's layers. A warm
 *  isolate answers from memory; this bounds a cold one, where Overture
 *  pays a bucket listing, a header read and a metadata read. */
export const ARCHIVE_READ_BUDGET_MS = 2000;

/** Open the archive and read its layers, giving up after `budgetMs`.
 *  The read goes to `waitUntil` so one that loses the race still lands
 *  in the memo instead of being cancelled with the request. */
async function readArchiveLayersWithin(
  open: () => Promise<ArchiveHandle>,
  budgetMs: number,
  waitUntil: (promise: Promise<unknown>) => void,
): Promise<ArchiveLayersRead> {
  const read = Promise.resolve().then(open).then(readArchiveLayers);
  waitUntil(read.catch(() => {}));
  let timer: ReturnType<typeof setTimeout> | null = null;
  const timeout = new Promise<ArchiveLayersRead>((resolve) => {
    timer = setTimeout(() => resolve({ status: "timed-out" }), budgetMs);
  });
  try {
    return await Promise.race([
      read.then(
        (layers): ArchiveLayersRead => ({ status: "read", layers }),
        (error: unknown): ArchiveLayersRead => ({ status: "failed", error }),
      ),
      timeout,
    ]);
  } finally {
    clearTimeout(timer);
  }
}

/** A tileset's TileJSON `vector_layers`, and how long the TileJSON may
 *  be cached. When the archive cannot be read in time the answer is the
 *  registry's layers with no fields, as before archives were read, kept
 *  briefly so a later request tries the archive again. */
export async function tilesetVectorLayers(
  def: Pick<TilesetDef, "id" | "minzoom" | "maxzoom" | "archive">,
  registry: readonly VectorLayerInfo[],
  env: Env,
  waitUntil: (promise: Promise<unknown>) => void,
  budgetMs = ARCHIVE_READ_BUDGET_MS,
): Promise<{ layers: TileJsonVectorLayer[]; maxAge: number }> {
  const { archive } = def;
  if (!archive) return { layers: mergeVectorLayers(registry, [], def), maxAge: 300 };
  const read = await readArchiveLayersWithin(() => archive(env), budgetMs, waitUntil);
  if (read.status === "read") {
    return { layers: mergeVectorLayers(registry, read.layers, def), maxAge: 300 };
  }
  const why = read.status === "failed" ? String(read.error) : `no answer in ${budgetMs} ms`;
  console.warn(`tilejson: ${def.id} archive layers unavailable (${why})`);
  return { layers: mergeVectorLayers(registry, [], def), maxAge: 30 };
}
