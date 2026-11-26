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
// yields `null`; a child that does not parse leaves the result incomplete.
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
  /** Kept z14 features per parent tile, both layers together. */
  donors: 200_000,
  /** Longest id or value worth carrying over. */
  valueBytes: 256,
};

type LayerName = keyof typeof HEIGHT_FIELDS;
const isLayerName = (name: string): name is LayerName => name in HEIGHT_FIELDS;

export type ParentZoom = 12 | 13;

/** A z14 child's offset inside the parent, `0 <= dx, dy < 2^(14 - z)`. */
export interface ChildSlot {
  dx: number;
  dy: number;
}

export interface Enriched {
  bytes: Uint8Array;
  /** Every child was read. False when one failed or was marked missing. */
  complete: boolean;
  /** Parent features per layer that gained values. */
  matched: Record<LayerName, number>;
  /** z14 features kept in memory for the join. */
  donors: number;
}

export interface Enricher {
  readonly slots: readonly ChildSlot[];
  /** Reduce one child to what the join needs. `null` is a child upstream
   *  does not have, which is empty rather than missing. Returns false when
   *  the child does not parse. */
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

  const pools = new Map<LayerName, Map<string, Donor>>();
  for (const name of parents.keys()) pools.set(name, new Map());
  const seen = new Set<number>();
  let donors = 0;
  let broken = false;
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
      try {
        const found = scanChild(child, slot, i, n, parents);
        let added = 0;
        for (const d of found) if (!pools.get(d.layer)!.has(d.key)) added++;
        if (donors + added > LIMITS.donors) throw new ParseError();
        for (const d of found) {
          const pool = pools.get(d.layer)!;
          const had = pool.get(d.key);
          if (!had) {
            pool.set(d.key, d);
            donors++;
          } else {
            had.box = union(had.box, d.box);
            if (d.from < had.from) {
              had.values = d.values;
              had.from = d.from;
            }
          }
        }
        return true;
      } catch {
        broken = true;
        return false;
      }
    },
    markMissing(slot) {
      const i = slotIndex(slot);
      if (i !== null) seen.add(i);
      broken = true;
    },
    finish() {
      if (result) return result;
      const matched = { building: 0, building_part: 0 } satisfies Record<LayerName, number>;
      const matches = new Map<LayerScan, Map<number, Donor>>();
      for (const scan of scans) {
        if (!isLayerName(scan.name)) continue;
        const index = parents.get(scan.name)!;
        if (index.scan !== scan) continue;
        const m = assign(index, pools.get(scan.name)!);
        matched[scan.name] = m.size;
        if (m.size > 0) matches.set(scan, m);
      }
      let bytes = parent;
      try {
        if (matches.size > 0) bytes = rewriteTile(parent, scans, matches);
      } catch {
        bytes = parent;
      }
      result = { bytes, complete: !broken && seen.size === n * n, matched, donors };
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

function byteString(buf: Uint8Array, start: number, end: number): string {
  let s = "";
  for (let i = start; i < end; i++) s += String.fromCharCode(buf[i]);
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

const union = (a: Box, b: Box): Box => ({
  x0: Math.min(a.x0, b.x0),
  y0: Math.min(a.y0, b.y0),
  x1: Math.max(a.x1, b.x1),
  y1: Math.max(a.y1, b.y1),
});

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

/** A z14 feature as the join sees it, merged across the children it spans. */
interface Donor {
  layer: LayerName;
  /** The GERS id, or a key unique to this piece when it has none. */
  key: string;
  /** In parent-grid units. */
  box: Box;
  /** Raw Value messages, aligned to `HEIGHT_FIELDS[layer]`. */
  values: (Uint8Array | undefined)[];
  /** Slot of the piece `values` came from, so the lowest slot wins
   *  whatever order children arrive in. */
  from: number;
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
): Donor[] {
  const found: Donor[] = [];
  for (const layer of scanTile(buf)) {
    if (!isLayerName(layer.name)) continue;
    const index = parents.get(layer.name);
    if (!index) continue;
    const ext = layer.extent;
    const toParent = index.extent / (ext * n);
    const idKey = layer.keys.indexOf("id");
    const fieldKeys = HEIGHT_FIELDS[layer.name].map((f) => layer.keys.indexOf(f));
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
      const value = (key: number): Uint8Array | undefined => {
        if (key < 0) return undefined;
        for (let t = 0; t < tags.length; t += 2) {
          if (tags[t] !== key) continue;
          const v = tags[t + 1];
          const s = layer.values[2 * v];
          const e = layer.values[2 * v + 1];
          return e - s <= LIMITS.valueBytes ? buf.slice(s, e) : undefined;
        }
        return undefined;
      };
      const id = value(idKey);
      found.push({
        layer: layer.name,
        key: id ? byteString(id, 0, id.length) : `\0${from}:${i / 2}`,
        box: pb,
        values: fieldKeys.map(value),
        from,
      });
    }
  }
  return found;
}

/** Greedy one-to-one by descending IoU, ties broken by parent then donor
 *  key so the result does not depend on the order children arrived in. */
function assign(index: ParentIndex, pool: Map<string, Donor>): Map<number, Donor> {
  const pairs: { score: number; parent: number; donor: Donor }[] = [];
  for (const donor of pool.values()) {
    const db = clip(donor.box, index.extent);
    if (area(db) <= 0) continue;
    index.candidates(db, (parent, pbox) => {
      const score = iou(pbox, db);
      if (score > MIN_IOU) pairs.push({ score, parent, donor });
    });
  }
  pairs.sort(
    (a, b) =>
      b.score - a.score ||
      a.parent - b.parent ||
      (a.donor.key < b.donor.key ? -1 : a.donor.key > b.donor.key ? 1 : 0),
  );
  const out = new Map<number, Donor>();
  const used = new Set<Donor>();
  for (const { parent, donor } of pairs) {
    if (out.has(parent) || used.has(donor)) continue;
    out.set(parent, donor);
    used.add(donor);
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
function rewriteTile(buf: Uint8Array, scans: LayerScan[], matches: Map<LayerScan, Map<number, Donor>>): Uint8Array {
  const out = new Writer();
  let pos = 0;
  for (const scan of scans) {
    const m = matches.get(scan);
    if (!m) continue;
    out.bytes(buf, pos, scan.fieldStart);
    const body = rewriteLayer(buf, scan, m);
    out.field(3, body);
    pos = scan.end;
  }
  out.bytes(buf, pos, buf.length);
  return out.finish();
}

function rewriteLayer(buf: Uint8Array, scan: LayerScan, matches: Map<number, Donor>): Uint8Array {
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
  for (const [f, donor] of matches) {
    const start = scan.features[2 * f];
    const end = scan.features[2 * f + 1];
    const { tags } = scanFeature(scan, buf, start, end);
    const has = new Set<string>();
    for (let t = 0; t < tags.length; t += 2) has.add(scan.keys[tags[t]]);
    const extra: number[] = [];
    fields.forEach((name, j) => {
      const raw = donor.values[j];
      if (raw && !has.has(name)) extra.push(keyIndex(name), valueIndex(raw));
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
