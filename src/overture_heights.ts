// Building heights for Overture's z12–13 building tiles.
//
// Overture's tile profile keeps every building attribute except
// `@geometry_source` and `@height_source` to z14 only, so a z12 or z13
// building carries no height. The attributes are recovered from the z14
// tiles underneath: each parent feature takes the values of the z14
// feature whose bounding box overlaps its own best. Footprints are not
// touched; the parent's bytes are rewritten at the protobuf level, with
// geometry copied as it came.
//
// The input is a third party's bytes, so every length is checked against
// the buffer and every count is capped. A parent that does not parse
// yields `null`. A child that does not parse, and anything past a cap, is
// left out; that is the same on every build, so the tile still counts as
// complete. Only a child that could not be fetched leaves it partial.
// Nothing here throws.

/** The z14 attributes each layer gains. */
export const HEIGHT_FIELDS = {
  building: ["height", "num_floors", "min_height", "has_parts", "is_underground"],
  building_part: ["height", "num_floors", "min_height", "is_underground"],
} as const;

/** Bump when a change to the join or the rewrite changes the tiles it makes. */
const ALGO = 1;

/** Names every input to a joined tile except the release, so a cached tile
 *  built under another field list or algorithm is never served. */
export const HEIGHTS_VERSION = `${ALGO}.${fnv1a(JSON.stringify(HEIGHT_FIELDS))}`;

const CHILD_ZOOM = 14;
const MIN_IOU = 0.3;

const LIMITS = {
  tileBytes: 16 * 1024 * 1024,
  featuresPerLayer: 500_000,
  /** Grid cells covered by parent boxes, summed over a layer. */
  indexEntries: 1_000_000,
  /** Estimated heap held by the donor pools and value table of one tile. */
  retainedBytes: 16 * 1024 * 1024,
  /** Parent-donor pairs scored per tile, both layers together. */
  pairs: 400_000,
  /** Longest id or value worth carrying over. */
  valueBytes: 256,
};

/** Rough heap cost of one donor beyond its key's characters: its box,
 *  slot and value indices, its Map entry and its key's string header. */
const DONOR_BYTES = 160;
const VALUE_BYTES = 96;

type LayerName = keyof typeof HEIGHT_FIELDS;
const isLayerName = (name: string): name is LayerName => Object.hasOwn(HEIGHT_FIELDS, name);

export type ParentZoom = 12 | 13;

/** A z14 child's offset inside the parent, `0 <= dx, dy < 2^(14 - z)`. */
export interface ChildSlot {
  dx: number;
  dy: number;
}

/** `complete`: every child was read, so the tile may be stored.
 *  `partial`: a child could not be fetched; worth retrying.
 *  `unjoined`: the rewrite failed and `bytes` is the parent as it came. */
export type JoinState = "complete" | "partial" | "unjoined";

export interface Enriched {
  bytes: Uint8Array;
  state: JoinState;
  /** Parent features per layer that gained values. */
  matched: Record<LayerName, number>;
  /** z14 features kept in memory for the join. */
  donors: number;
  /** Parent-donor pairs scored. */
  pairs: number;
}

export interface Enricher {
  readonly slots: readonly ChildSlot[];
  /** Reduce one child to what the join needs. `null` is a child upstream
   *  does not have. Returns false when the child does not parse, which
   *  then counts as empty. */
  ingest(slot: ChildSlot, child: Uint8Array | null): boolean;
  /** A child that could not be fetched. */
  markMissing(slot: ChildSlot): void;
  finish(): Enriched;
}

/** `null` when the parent does not parse or has no building layer. */
export function createEnricher(z: ParentZoom, parent: Uint8Array): Enricher | null {
  let scans: LayerScan[];
  try {
    scans = scanTile(parent);
  } catch {
    return null;
  }
  const parents = new Map<LayerName, ParentIndex>();
  for (const scan of scans) {
    if (!isLayerName(scan.name) || parents.has(scan.name)) continue;
    try {
      parents.set(scan.name, ParentIndex.of(parent, scan));
    } catch {
      return null;
    }
  }
  if (parents.size === 0) return null;

  const n = 1 << (CHILD_ZOOM - z);
  const slots: ChildSlot[] = [];
  for (let dy = 0; dy < n; dy++) for (let dx = 0; dx < n; dx++) slots.push({ dx, dy });

  const table = new ValueTable();
  const pools = new Map<LayerName, DonorPool>();
  for (const name of parents.keys()) pools.set(name, new DonorPool(HEIGHT_FIELDS[name].length));
  const seen = new Set<number>();
  let retained = 0;
  let missing = false;
  let result: Enriched | null = null;

  const slotIndex = (s: ChildSlot): number | null =>
    Number.isInteger(s.dx) && Number.isInteger(s.dy) && s.dx >= 0 && s.dy >= 0 && s.dx < n && s.dy < n
      ? s.dy * n + s.dx
      : null;

  return {
    slots,
    ingest(slot, child) {
      const i = slotIndex(slot);
      if (i === null || seen.has(i) || result) return false;
      seen.add(i);
      if (child === null) return true;
      let found: Found[];
      try {
        found = scanChild(child, slot, i, n, parents);
      } catch {
        return false;
      }
      for (const d of found) {
        const pool = pools.get(d.layer)!;
        const at = pool.find(d.key);
        if (at === undefined) {
          const cost = DONOR_BYTES + d.key.length + table.costOf(child, d.spans);
          if (retained + cost > LIMITS.retainedBytes) continue;
          retained += cost;
          pool.add(d.key, d.box, table.intern(child, d.spans), d.from);
        } else {
          const cost = d.from < pool.from[at] ? table.costOf(child, d.spans) : Infinity;
          const replace = retained + cost <= LIMITS.retainedBytes;
          if (replace) retained += cost;
          pool.merge(at, d.box, replace ? table.intern(child, d.spans) : null, d.from);
        }
      }
      return true;
    },
    markMissing(slot) {
      const i = slotIndex(slot);
      if (i !== null) seen.add(i);
      missing = true;
    },
    finish() {
      if (result) return result;
      const matched = { building: 0, building_part: 0 } satisfies Record<LayerName, number>;
      const matches = new Map<LayerScan, Map<number, Int32Array>>();
      const budget = { pairs: LIMITS.pairs, scored: 0 };
      let donors = 0;
      for (const scan of scans) {
        if (!isLayerName(scan.name)) continue;
        const index = parents.get(scan.name)!;
        if (index.scan !== scan) continue;
        const pool = pools.get(scan.name)!;
        donors += pool.size;
        const m = assign(index, pool, budget);
        matched[scan.name] = m.size;
        if (m.size > 0) matches.set(scan, m);
      }
      const complete = !missing && seen.size === n * n;
      let bytes = parent;
      let state: JoinState = complete ? "complete" : "partial";
      try {
        if (matches.size > 0) bytes = rewriteTile(parent, scans, matches, table);
      } catch {
        bytes = parent;
        state = "unjoined";
        matched.building = 0;
        matched.building_part = 0;
      }
      result = { bytes, state, matched, donors, pairs: budget.scored };
      return result;
    },
  };
}

// -- reading ------------------------------------------------------------------

class ParseError extends Error {}

function fail(): never {
  throw new ParseError();
}

class Reader {
  readonly buf: Uint8Array;
  pos: number;
  readonly end: number;

  constructor(buf: Uint8Array, pos: number, end: number) {
    this.buf = buf;
    this.pos = pos;
    this.end = end;
  }

  varint(): number {
    let value = 0;
    let scale = 1;
    for (let i = 0; i < 10; i++) {
      if (this.pos >= this.end) fail();
      const b = this.buf[this.pos++];
      value += (b & 0x7f) * scale;
      if (b < 0x80) return value;
      scale *= 128;
    }
    return fail();
  }

  /** The next field's tag, as [field number, wire type]. */
  tag(): [number, number] {
    const t = this.varint();
    const field = Math.floor(t / 8);
    if (field === 0) fail();
    return [field, t % 8];
  }

  /** Steps over a length-delimited payload and returns its [start, end). */
  span(): [number, number] {
    const len = this.varint();
    if (len > this.end - this.pos) fail();
    const start = this.pos;
    this.pos += len;
    return [start, this.pos];
  }

  skip(wire: number): void {
    if (wire === 0) this.varint();
    else if (wire === 2) this.span();
    else if (wire === 1) this.advance(8);
    else if (wire === 5) this.advance(4);
    else fail();
  }

  private advance(n: number): void {
    if (n > this.end - this.pos) fail();
    this.pos += n;
  }
}

interface LayerScan {
  name: string;
  extent: number;
  /** The layer message's [start, end) and the field's own start. */
  fieldStart: number;
  start: number;
  end: number;
  keys: string[];
  /** Flat [start, end) pairs of each Value message. */
  values: number[];
  /** Flat [start, end) pairs of each Feature message. */
  features: number[];
}

function scanTile(buf: Uint8Array): LayerScan[] {
  if (buf.length > LIMITS.tileBytes) fail();
  const r = new Reader(buf, 0, buf.length);
  const layers: LayerScan[] = [];
  while (r.pos < r.end) {
    const fieldStart = r.pos;
    const [field, wire] = r.tag();
    if (field === 3 && wire === 2) {
      const [start, end] = r.span();
      layers.push(scanLayer(buf, fieldStart, start, end));
    } else {
      r.skip(wire);
    }
  }
  return layers;
}

function scanLayer(buf: Uint8Array, fieldStart: number, start: number, end: number): LayerScan {
  const r = new Reader(buf, start, end);
  const layer: LayerScan = { name: "", extent: 4096, fieldStart, start, end, keys: [], values: [], features: [] };
  while (r.pos < r.end) {
    const [field, wire] = r.tag();
    if (wire === 2 && (field === 1 || field === 2 || field === 3 || field === 4)) {
      const [s, e] = r.span();
      if (field === 1) layer.name = byteString(buf, s, e);
      else if (field === 3) layer.keys.push(byteString(buf, s, e));
      else (field === 2 ? layer.features : layer.values).push(s, e);
    } else if (field === 5 && wire === 0) {
      layer.extent = r.varint();
    } else {
      r.skip(wire);
    }
  }
  if (layer.extent < 1 || layer.extent > 1 << 20) fail();
  if (layer.features.length / 2 > LIMITS.featuresPerLayer) fail();
  return layer;
}

/** A feature's tag pairs and the bounding box of its geometry. */
function scanFeature(layer: LayerScan, buf: Uint8Array, start: number, end: number): { tags: number[]; box: Box | null } {
  const r = new Reader(buf, start, end);
  const tags: number[] = [];
  let box: Box | null = null;
  while (r.pos < r.end) {
    const [field, wire] = r.tag();
    if (field === 2 && wire === 2) {
      const [s, e] = r.span();
      const p = new Reader(buf, s, e);
      while (p.pos < p.end) tags.push(p.varint());
    } else if (field === 2 && wire === 0) {
      tags.push(r.varint());
    } else if (field === 4 && wire === 2) {
      const [s, e] = r.span();
      box = geometryBox(new Reader(buf, s, e));
    } else {
      r.skip(wire);
    }
  }
  if (tags.length % 2 !== 0) fail();
  const nk = layer.keys.length;
  const nv = layer.values.length / 2;
  for (let i = 0; i < tags.length; i += 2) if (tags[i] >= nk || tags[i + 1] >= nv) fail();
  return { tags, box };
}

interface Box {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

function geometryBox(r: Reader): Box | null {
  let x = 0;
  let y = 0;
  let box: Box | null = null;
  while (r.pos < r.end) {
    const cmd = r.varint();
    const id = cmd % 8;
    const count = Math.floor(cmd / 8);
    if (id === 7) continue;
    if (id !== 1 && id !== 2) fail();
    if (count * 2 > r.end - r.pos) fail();
    for (let i = 0; i < count; i++) {
      x += zigzag(r.varint());
      y += zigzag(r.varint());
      if (!box) box = { x0: x, y0: y, x1: x, y1: y };
      else {
        if (x < box.x0) box.x0 = x;
        if (x > box.x1) box.x1 = x;
        if (y < box.y0) box.y0 = y;
        if (y > box.y1) box.y1 = y;
      }
    }
  }
  return box;
}

const zigzag = (n: number): number => (n % 2 === 1 ? -(n + 1) / 2 : n / 2);

/** One flat string per call: a string built by `+=` is a rope of one
 *  node per character, and donor keys are held for the whole join. */
function byteString(buf: Uint8Array, start: number, end: number): string {
  let s = "";
  for (let i = start; i < end; i += 4096) {
    s += String.fromCharCode.apply(null, buf.subarray(i, Math.min(end, i + 4096)) as unknown as number[]);
  }
  return s;
}

// -- the join -----------------------------------------------------------------

const clip = (b: Box, extent: number): Box => ({
  x0: Math.max(0, b.x0),
  y0: Math.max(0, b.y0),
  x1: Math.min(extent, b.x1),
  y1: Math.min(extent, b.y1),
});

const area = (b: Box): number => Math.max(0, b.x1 - b.x0) * Math.max(0, b.y1 - b.y0);

function iou(a: Box, b: Box): number {
  const inter = area({
    x0: Math.max(a.x0, b.x0),
    y0: Math.max(a.y0, b.y0),
    x1: Math.min(a.x1, b.x1),
    y1: Math.min(a.y1, b.y1),
  });
  const u = area(a) + area(b) - inter;
  return u > 0 ? inter / u : 0;
}

const GRID = 64;

/** One parent layer's clipped feature boxes on a uniform grid. */
class ParentIndex {
  private readonly cells: number[][] = Array.from({ length: GRID * GRID }, () => []);
  private readonly stamp: Int32Array;
  private visit = 0;
  readonly scan: LayerScan;
  readonly boxes: (Box | null)[];

  private constructor(scan: LayerScan, boxes: (Box | null)[]) {
    this.scan = scan;
    this.boxes = boxes;
    this.stamp = new Int32Array(boxes.length);
    let entries = 0;
    boxes.forEach((b, i) => {
      if (!b) return;
      this.forCells(b, (c) => {
        if (++entries > LIMITS.indexEntries) fail();
        this.cells[c].push(i);
      });
    });
  }

  static of(buf: Uint8Array, scan: LayerScan): ParentIndex {
    const boxes: (Box | null)[] = [];
    for (let i = 0; i < scan.features.length; i += 2) {
      const { box } = scanFeature(scan, buf, scan.features[i], scan.features[i + 1]);
      const b = box && clip(box, scan.extent);
      boxes.push(b && area(b) > 0 ? b : null);
    }
    return new ParentIndex(scan, boxes);
  }

  get extent(): number {
    return this.scan.extent;
  }

  /** Each parent whose box shares positive area with `b`, once. */
  candidates(b: Box, each: (i: number, box: Box) => boolean | void): void {
    const v = ++this.visit;
    let stop = false;
    this.forCells(b, (c) => {
      if (stop) return;
      for (const i of this.cells[c]) {
        if (this.stamp[i] === v) continue;
        this.stamp[i] = v;
        const p = this.boxes[i]!;
        if (p.x0 < b.x1 && b.x0 < p.x1 && p.y0 < b.y1 && b.y0 < p.y1 && each(i, p) === true) {
          stop = true;
          return;
        }
      }
    });
  }

  overlapsAny(b: Box): boolean {
    let hit = false;
    this.candidates(b, () => (hit = true));
    return hit;
  }

  private forCells(b: Box, each: (cell: number) => void): void {
    const size = this.scan.extent / GRID;
    const cell = (v: number) => Math.min(GRID - 1, Math.max(0, Math.floor(v / size)));
    const cx0 = cell(b.x0);
    const cx1 = cell(b.x1);
    const cy0 = cell(b.y0);
    const cy1 = cell(b.y1);
    for (let cy = cy0; cy <= cy1; cy++) for (let cx = cx0; cx <= cx1; cx++) each(cy * GRID + cx);
  }
}

/** Every distinct raw Value message a tile's donors carry, stored once. */
class ValueTable {
  private readonly ids = new Map<string, number>();
  readonly raw: Uint8Array[] = [];

  /** Heap that interning `spans` would add. */
  costOf(buf: Uint8Array, spans: readonly number[]): number {
    let cost = 0;
    for (let j = 0; j < spans.length; j += 2) {
      if (spans[j] >= 0 && !this.ids.has(byteString(buf, spans[j], spans[j + 1]))) {
        cost += VALUE_BYTES + 2 * (spans[j + 1] - spans[j]);
      }
    }
    return cost;
  }

  /** One id per [start, end) pair in `spans`, -1 where the start is. */
  intern(buf: Uint8Array, spans: readonly number[]): number[] {
    const out: number[] = [];
    for (let j = 0; j < spans.length; j += 2) {
      if (spans[j] < 0) {
        out.push(-1);
        continue;
      }
      const s = byteString(buf, spans[j], spans[j + 1]);
      let id = this.ids.get(s);
      if (id === undefined) {
        id = this.raw.length;
        this.ids.set(s, id);
        this.raw.push(buf.slice(spans[j], spans[j + 1]));
      }
      out.push(id);
    }
    return out;
  }
}

/** One layer's z14 features as the join sees them, each merged across the
 *  children it spans, in columns rather than one object per donor. */
class DonorPool {
  private readonly ids = new Map<string, number>();
  /** The GERS id, or a key unique to the piece when it has none. */
  readonly keys: string[] = [];
  /** x0, y0, x1, y1 per donor, in parent-grid units. */
  boxes = new Float64Array(4 * 64);
  /** `width` value-table ids per donor, aligned to `HEIGHT_FIELDS`, -1 for none. */
  values: Int32Array;
  /** Slot of the piece `values` came from, so the lowest slot wins
   *  whatever order children arrive in. */
  from = new Int32Array(64);
  readonly width: number;

  constructor(width: number) {
    this.width = width;
    this.values = new Int32Array(width * 64);
  }

  get size(): number {
    return this.keys.length;
  }

  find(key: string): number | undefined {
    return this.ids.get(key);
  }

  box(d: number): Box {
    const b = this.boxes;
    return { x0: b[4 * d], y0: b[4 * d + 1], x1: b[4 * d + 2], y1: b[4 * d + 3] };
  }

  valuesOf(d: number): Int32Array {
    return this.values.subarray(d * this.width, (d + 1) * this.width);
  }

  add(key: string, box: Box, values: number[], from: number): void {
    const d = this.keys.length;
    if (d === this.from.length) {
      this.boxes = grow(this.boxes, 8 * d);
      this.values = grow(this.values, 2 * d * this.width);
      this.from = grow(this.from, 2 * d);
    }
    this.keys.push(key);
    this.ids.set(key, d);
    this.from[d] = from;
    this.boxes.set([box.x0, box.y0, box.x1, box.y1], 4 * d);
    this.values.set(values, d * this.width);
  }

  merge(d: number, box: Box, values: number[] | null, from: number): void {
    const b = this.boxes;
    b[4 * d] = Math.min(b[4 * d], box.x0);
    b[4 * d + 1] = Math.min(b[4 * d + 1], box.y0);
    b[4 * d + 2] = Math.max(b[4 * d + 2], box.x1);
    b[4 * d + 3] = Math.max(b[4 * d + 3], box.y1);
    if (values) {
      this.values.set(values, d * this.width);
      this.from[d] = from;
    }
  }
}

function grow<T extends Float64Array | Int32Array>(a: T, length: number): T {
  const next = new (a.constructor as new (n: number) => T)(length);
  next.set(a);
  return next;
}

/** A z14 feature read from one child, before it joins a pool. */
interface Found {
  layer: LayerName;
  key: string;
  box: Box;
  /** [start, end) of each field's Value message in the child, -1 for none. */
  spans: number[];
  from: number;
}

/** MVT Value fields 1-7 (string, float, double, int64, uint64, sint64,
 *  bool) and the wire type each must have. */
const VALUE_WIRE = [-1, 2, 5, 1, 0, 0, 0, 0];

/** A Value message is exactly one known field, filling the message. */
function isValue(buf: Uint8Array, start: number, end: number): boolean {
  try {
    const r = new Reader(buf, start, end);
    const [field, wire] = r.tag();
    if (field > 7 || VALUE_WIRE[field] !== wire) return false;
    r.skip(wire);
    return r.pos === end;
  } catch {
    return false;
  }
}

/** Keeps a z14 feature only if it could matter: its box overlaps a parent
 *  box, or it touches its tile's edge and so may be one piece of a
 *  building that continues into another child. A feature inside one child
 *  that overlaps no parent can never score above zero. */
function scanChild(
  buf: Uint8Array,
  slot: ChildSlot,
  from: number,
  n: number,
  parents: Map<LayerName, ParentIndex>,
): Found[] {
  const found: Found[] = [];
  for (const layer of scanTile(buf)) {
    if (!isLayerName(layer.name)) continue;
    const index = parents.get(layer.name);
    if (!index) continue;
    const ext = layer.extent;
    const toParent = index.extent / (ext * n);
    const idKey = layer.keys.indexOf("id");
    const fieldKeys = HEIGHT_FIELDS[layer.name].map((f) => layer.keys.indexOf(f));
    const valid = new Map<number, boolean>();
    for (let i = 0; i < layer.features.length; i += 2) {
      const { tags, box } = scanFeature(layer, buf, layer.features[i], layer.features[i + 1]);
      if (!box) continue;
      const pb: Box = {
        x0: (slot.dx * ext + box.x0) * toParent,
        y0: (slot.dy * ext + box.y0) * toParent,
        x1: (slot.dx * ext + box.x1) * toParent,
        y1: (slot.dy * ext + box.y1) * toParent,
      };
      const touchesEdge = box.x0 <= 0 || box.y0 <= 0 || box.x1 >= ext || box.y1 >= ext;
      if (!touchesEdge && !index.overlapsAny(pb)) continue;
      const spans: number[] = [];
      const value = (key: number): void => {
        for (let t = 0; key >= 0 && t < tags.length; t += 2) {
          if (tags[t] !== key) continue;
          const v = tags[t + 1];
          const s = layer.values[2 * v];
          const e = layer.values[2 * v + 1];
          let ok = valid.get(v);
          if (ok === undefined) valid.set(v, (ok = e - s <= LIMITS.valueBytes && isValue(buf, s, e)));
          if (ok) {
            spans.push(s, e);
            return;
          }
          break;
        }
        spans.push(-1, -1);
      };
      value(idKey);
      const [idStart, idEnd] = spans.splice(0, 2);
      for (const k of fieldKeys) value(k);
      found.push({
        layer: layer.name,
        key: idStart >= 0 ? byteString(buf, idStart, idEnd) : `\0${from}:${i / 2}`,
        box: pb,
        spans,
        from,
      });
    }
  }
  return found;
}

/** Greedy one-to-one by descending IoU, ties broken by parent then donor
 *  key so the result does not depend on the order children arrived in.
 *  Scoring stops once `budget` is spent, and the pairs scored by then are
 *  assigned. Returns each matched parent's value-table ids. */
function assign(
  index: ParentIndex,
  pool: DonorPool,
  budget: { pairs: number; scored: number },
): Map<number, Int32Array> {
  const score: number[] = [];
  const parentOf: number[] = [];
  const donorOf: number[] = [];
  for (let d = 0; d < pool.size && budget.scored < budget.pairs; d++) {
    const db = clip(pool.box(d), index.extent);
    if (area(db) <= 0) continue;
    index.candidates(db, (parent, pbox) => {
      if (++budget.scored > budget.pairs) return true;
      const s = iou(pbox, db);
      if (s > MIN_IOU) {
        score.push(s);
        parentOf.push(parent);
        donorOf.push(d);
      }
    });
  }
  budget.scored = Math.min(budget.scored, budget.pairs);
  const order = Array.from(score, (_, i) => i);
  order.sort((a, b) => {
    const ka = pool.keys[donorOf[a]];
    const kb = pool.keys[donorOf[b]];
    return score[b] - score[a] || parentOf[a] - parentOf[b] || (ka < kb ? -1 : ka > kb ? 1 : 0);
  });
  const out = new Map<number, Int32Array>();
  const used = new Set<number>();
  for (const i of order) {
    const parent = parentOf[i];
    const d = donorOf[i];
    if (out.has(parent) || used.has(d)) continue;
    out.set(parent, pool.valuesOf(d));
    used.add(d);
  }
  return out;
}

// -- writing ------------------------------------------------------------------

class Writer {
  private buf = new Uint8Array(1 << 16);
  pos = 0;

  private room(n: number): void {
    if (this.pos + n <= this.buf.length) return;
    let size = this.buf.length * 2;
    while (size < this.pos + n) size *= 2;
    const next = new Uint8Array(size);
    next.set(this.buf.subarray(0, this.pos));
    this.buf = next;
  }

  varint(v: number): void {
    this.room(10);
    while (v >= 0x80) {
      this.buf[this.pos++] = (v % 0x80) | 0x80;
      v = Math.floor(v / 0x80);
    }
    this.buf[this.pos++] = v;
  }

  bytes(src: Uint8Array, start = 0, end = src.length): void {
    this.room(end - start);
    this.buf.set(src.subarray(start, end), this.pos);
    this.pos += end - start;
  }

  /** A length-delimited field. */
  field(field: number, src: Uint8Array, start = 0, end = src.length): void {
    this.varint(field * 8 + 2);
    this.varint(end - start);
    this.bytes(src, start, end);
  }

  finish(): Uint8Array {
    return this.buf.slice(0, this.pos);
  }
}

/** Layers with no match, and every field outside a layer, are copied as
 *  they came. In a matched layer, new keys and values go after the existing
 *  ones so no index moves, and only matched features are re-emitted. */
function rewriteTile(
  buf: Uint8Array,
  scans: LayerScan[],
  matches: Map<LayerScan, Map<number, Int32Array>>,
  table: ValueTable,
): Uint8Array {
  const out = new Writer();
  let pos = 0;
  for (const scan of scans) {
    const m = matches.get(scan);
    if (!m) continue;
    out.bytes(buf, pos, scan.fieldStart);
    const body = rewriteLayer(buf, scan, m, table);
    out.field(3, body);
    pos = scan.end;
  }
  out.bytes(buf, pos, buf.length);
  return out.finish();
}

function rewriteLayer(buf: Uint8Array, scan: LayerScan, matches: Map<number, Int32Array>, table: ValueTable): Uint8Array {
  const fields = HEIGHT_FIELDS[scan.name as LayerName];
  const keys = new Map(scan.keys.map((k, i) => [k, i]));
  const newKeys: string[] = [];
  const keyIndex = (k: string): number => {
    let i = keys.get(k);
    if (i === undefined) {
      i = scan.keys.length + newKeys.length;
      keys.set(k, i);
      newKeys.push(k);
    }
    return i;
  };
  const values = new Map<string, number>();
  for (let v = 0; v < scan.values.length; v += 2) {
    const s = byteString(buf, scan.values[v], scan.values[v + 1]);
    if (!values.has(s)) values.set(s, v / 2);
  }
  const newValues: Uint8Array[] = [];
  const valueIndex = (raw: Uint8Array): number => {
    const s = byteString(raw, 0, raw.length);
    let i = values.get(s);
    if (i === undefined) {
      i = scan.values.length / 2 + newValues.length;
      values.set(s, i);
      newValues.push(raw);
    }
    return i;
  };

  const replaced = new Map<number, Uint8Array>();
  for (const [f, ids] of matches) {
    const start = scan.features[2 * f];
    const end = scan.features[2 * f + 1];
    const { tags } = scanFeature(scan, buf, start, end);
    const has = new Set<string>();
    for (let t = 0; t < tags.length; t += 2) has.add(scan.keys[tags[t]]);
    const extra: number[] = [];
    fields.forEach((name, j) => {
      if (ids[j] >= 0 && !has.has(name)) extra.push(keyIndex(name), valueIndex(table.raw[ids[j]]));
    });
    if (extra.length > 0) replaced.set(f, rewriteFeature(buf, start, end, tags.concat(extra)));
  }

  const out = new Writer();
  const r = new Reader(buf, scan.start, scan.end);
  let feature = 0;
  while (r.pos < r.end) {
    const at = r.pos;
    const [field, wire] = r.tag();
    r.skip(wire);
    const body = field === 2 && wire === 2 ? replaced.get(feature++) : undefined;
    if (body) out.field(2, body);
    else out.bytes(buf, at, r.pos);
  }
  for (const k of newKeys) out.field(3, Uint8Array.from(k, (c) => c.charCodeAt(0)));
  for (const v of newValues) out.field(4, v);
  return out.finish();
}

/** Every field but the tags is copied byte for byte; the tags go last as
 *  one packed field. */
function rewriteFeature(buf: Uint8Array, start: number, end: number, tags: number[]): Uint8Array {
  const out = new Writer();
  const r = new Reader(buf, start, end);
  while (r.pos < r.end) {
    const at = r.pos;
    const [field, wire] = r.tag();
    r.skip(wire);
    if (field !== 2) out.bytes(buf, at, r.pos);
  }
  const packed = new Writer();
  for (const t of tags) packed.varint(t);
  out.field(2, packed.finish());
  return out.finish();
}

function fnv1a(s: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(16).padStart(8, "0");
}
