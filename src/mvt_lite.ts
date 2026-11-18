// Attribute filter for Mapbox Vector Tiles (MVT 2.1), working on the
// encoded protobuf. A feature's tags are pairs of indices into its
// layer's `keys` and `values`, so dropping a key means renumbering the
// survivors and rewriting each feature's packed `tags`. Geometry and
// every other field are copied as bytes and never decoded.
// https://github.com/mapbox/vector-tile-spec/blob/master/2.1/README.md

export interface FilterRules {
  /** Property keys removed from every layer. */
  readonly dropKeys: ReadonlySet<string>;
  /** Layers removed when, after `dropKeys`, none of their features
   *  carries a property. */
  readonly dropLayersWhenUntagged: ReadonlySet<string>;
}

/** What `overture_base_lite` serves: the base theme without the GERS id
 *  and the provenance lists, which are most of its low-zoom bytes. */
export const LITE_RULES: FilterRules = {
  dropKeys: new Set(["id", "sources", "source_tags"]),
  dropLayersWhenUntagged: new Set(["bathymetry"]),
};

/** Bump whenever `liteTile` can return different bytes for the same
 *  input. Stored lite tiles and their ETags are keyed on it. */
export const LITE_VERSION = 1;

export const liteTile = (tile: Uint8Array<ArrayBuffer>): Uint8Array<ArrayBuffer> =>
  filterTile(tile, LITE_RULES);

const TILE_LAYERS = 3;
const LAYER_NAME = 1;
const LAYER_FEATURES = 2;
const LAYER_KEYS = 3;
const LAYER_VALUES = 4;
const FEATURE_TAGS = 2;

const VARINT = 0;
const I64 = 1;
const LEN = 2;
const I32 = 5;

type Rewrite = { kind: "rewrite"; keyMap: Int32Array; valMap: Int32Array; size: number };
type LayerPlan = { kind: "keep" } | { kind: "omit" } | Rewrite;

/** `tile` with `rules` applied. Returns `tile` itself when nothing is
 *  dropped. Throws `RangeError` on bytes that are not a well-formed MVT. */
export function filterTile(
  tile: Uint8Array<ArrayBuffer>,
  rules: FilterRules,
): Uint8Array<ArrayBuffer> {
  const plans: LayerPlan[] = [];
  let size = 0;
  let changed = false;
  for (const f = new Fields(tile, 0, tile.length); f.next(); ) {
    if (f.field !== TILE_LAYERS || f.wire !== LEN) {
      size += f.end - f.start;
      continue;
    }
    const plan = planLayer(tile, f.valueStart, f.end, rules);
    plans.push(plan);
    if (plan.kind === "keep") size += f.end - f.start;
    else if (plan.kind === "rewrite") size += lenFieldSize(TILE_LAYERS, plan.size);
    changed ||= plan.kind !== "keep";
  }
  if (!changed) return tile;

  const out = new Writer(size);
  let next = 0;
  for (const f = new Fields(tile, 0, tile.length); f.next(); ) {
    if (f.field !== TILE_LAYERS || f.wire !== LEN) {
      out.copy(tile, f.start, f.end);
      continue;
    }
    const plan = plans[next++];
    if (plan.kind === "keep") out.copy(tile, f.start, f.end);
    else if (plan.kind === "rewrite") {
      out.header(TILE_LAYERS, LEN);
      out.varint(plan.size);
      writeLayer(out, tile, f.valueStart, f.end, plan);
    }
  }
  if (out.pos !== size) throw new RangeError(`planned ${size} bytes, wrote ${out.pos}`);
  return out.buf;
}

const utf8 = new TextDecoder();

function planLayer(buf: Uint8Array, start: number, end: number, rules: FilterRules): LayerPlan {
  let name = "";
  const dropKey: boolean[] = [];
  let values = 0;
  for (const f = new Fields(buf, start, end); f.next(); ) {
    if (f.wire !== LEN) continue;
    if (f.field === LAYER_NAME) name = utf8.decode(buf.subarray(f.valueStart, f.end));
    else if (f.field === LAYER_KEYS) {
      dropKey.push(rules.dropKeys.has(utf8.decode(buf.subarray(f.valueStart, f.end))));
    } else if (f.field === LAYER_VALUES) values += 1;
  }
  const keys = dropKey.length;

  // A value goes only when every tag that used it went with a dropped
  // key. One no tag ever used stays, so a layer that loses nothing is
  // unchanged byte for byte.
  const refs = new Uint32Array(values);
  const keptRefs = new Uint32Array(values);
  let tagged = false;
  const tags = new Reader(buf);
  for (const feature = new Fields(buf, start, end); feature.next(); ) {
    if (feature.field !== LAYER_FEATURES || feature.wire !== LEN) continue;
    for (const f = new Fields(buf, feature.valueStart, feature.end); f.next(); ) {
      if (f.field !== FEATURE_TAGS) continue;
      if (f.wire !== LEN) throw new RangeError("feature tags are not packed");
      tags.reset(f.valueStart, f.end);
      while (tags.more()) {
        const k = tags.varint();
        if (!tags.more()) throw new RangeError("odd number of tag indices");
        const v = tags.varint();
        if (k >= keys) throw new RangeError(`tag key index ${k} out of range (${keys} keys)`);
        if (v >= values) throw new RangeError(`tag value index ${v} out of range (${values} values)`);
        refs[v] += 1;
        if (!dropKey[k]) {
          keptRefs[v] += 1;
          tagged = true;
        }
      }
    }
  }

  if (!tagged && rules.dropLayersWhenUntagged.has(name)) return { kind: "omit" };
  const keyMap = renumber(keys, (i) => !dropKey[i]);
  const valMap = renumber(values, (i) => refs[i] === 0 || keptRefs[i] > 0);
  if (keyMap.every((n, i) => n === i) && valMap.every((n, i) => n === i)) return { kind: "keep" };

  const plan: Rewrite = { kind: "rewrite", keyMap, valMap, size: 0 };
  plan.size = writeLayer(null, buf, start, end, plan);
  return plan;
}

/** New index for each of `count` entries, or -1 for one that goes. */
function renumber(count: number, keep: (i: number) => boolean): Int32Array {
  const map = new Int32Array(count);
  let next = 0;
  for (let i = 0; i < count; i++) map[i] = keep(i) ? next++ : -1;
  return map;
}

/** Write the rewritten layer body to `out`, or only size it when `out`
 *  is null. Returns the size either way. */
function writeLayer(
  out: Writer | null,
  buf: Uint8Array,
  start: number,
  end: number,
  plan: Rewrite,
): number {
  let size = 0;
  let key = 0;
  let value = 0;
  const tags = new Reader(buf);
  for (const f = new Fields(buf, start, end); f.next(); ) {
    if (f.wire === LEN && f.field === LAYER_FEATURES) {
      size += writeFeature(out, buf, f.valueStart, f.end, plan, tags);
      continue;
    }
    if (f.wire === LEN && f.field === LAYER_KEYS && plan.keyMap[key++] < 0) continue;
    if (f.wire === LEN && f.field === LAYER_VALUES && plan.valMap[value++] < 0) continue;
    out?.copy(buf, f.start, f.end);
    size += f.end - f.start;
  }
  return size;
}

function writeFeature(
  out: Writer | null,
  buf: Uint8Array,
  start: number,
  end: number,
  plan: Rewrite,
  tags: Reader,
): number {
  let body = 0;
  for (const f = new Fields(buf, start, end); f.next(); ) {
    if (f.field !== FEATURE_TAGS) body += f.end - f.start;
    else {
      const payload = tagsPayload(null, tags, f.valueStart, f.end, plan);
      if (payload > 0) body += lenFieldSize(FEATURE_TAGS, payload);
    }
  }
  if (out) {
    out.header(LAYER_FEATURES, LEN);
    out.varint(body);
    for (const f = new Fields(buf, start, end); f.next(); ) {
      if (f.field !== FEATURE_TAGS) {
        out.copy(buf, f.start, f.end);
        continue;
      }
      const payload = tagsPayload(null, tags, f.valueStart, f.end, plan);
      if (payload === 0) continue;
      out.header(FEATURE_TAGS, LEN);
      out.varint(payload);
      tagsPayload(out, tags, f.valueStart, f.end, plan);
    }
  }
  return lenFieldSize(LAYER_FEATURES, body);
}

/** The surviving tag pairs of one packed `tags` field, renumbered:
 *  written to `out` when given, sized either way. Indices were checked
 *  when the layer was planned. */
function tagsPayload(
  out: Writer | null,
  tags: Reader,
  start: number,
  end: number,
  plan: Rewrite,
): number {
  let size = 0;
  tags.reset(start, end);
  while (tags.more()) {
    const k = plan.keyMap[tags.varint()];
    const v = plan.valMap[tags.varint()];
    if (k < 0) continue;
    size += varintSize(k) + varintSize(v);
    out?.varint(k);
    out?.varint(v);
  }
  return size;
}

/** Walks the fields of the message in `buf[start, end)`, checking that
 *  each ends inside it. One instance is reused for every field. */
class Fields {
  field = 0;
  wire = 0;
  /** Offset of the field's key. */
  start = 0;
  /** Offset of the value, past any length prefix. */
  valueStart = 0;
  end = 0;
  private readonly r: Reader;

  constructor(buf: Uint8Array, start: number, end: number) {
    this.r = new Reader(buf);
    this.r.reset(start, end);
  }

  next(): boolean {
    const r = this.r;
    if (!r.more()) return false;
    this.start = r.pos;
    const key = r.varint();
    this.wire = key & 7;
    this.field = Math.floor(key / 8);
    this.valueStart = r.pos;
    switch (this.wire) {
      case VARINT:
        r.varint();
        break;
      case I64:
        r.skip(8);
        break;
      case LEN: {
        const len = r.varint();
        this.valueStart = r.pos;
        r.skip(len);
        break;
      }
      case I32:
        r.skip(4);
        break;
      default:
        throw new RangeError(`unknown wire type ${this.wire} at byte ${this.start}`);
    }
    this.end = r.pos;
    return true;
  }
}

class Reader {
  private readonly buf: Uint8Array;
  pos = 0;
  private end = 0;

  constructor(buf: Uint8Array) {
    this.buf = buf;
  }

  reset(start: number, end: number): void {
    this.pos = start;
    this.end = end;
  }

  more(): boolean {
    return this.pos < this.end;
  }

  /** Varints up to 2^53. The first four bytes take the 32-bit integer
   *  path, which is nearly every index and length in a tile; the rest
   *  use arithmetic so values past 2^31 do not wrap. */
  varint(): number {
    const buf = this.buf;
    let value = 0;
    for (let shift = 0; shift < 28; shift += 7) {
      if (this.pos >= this.end) throw new RangeError("truncated varint");
      const b = buf[this.pos++];
      value |= (b & 0x7f) << shift;
      if (b < 0x80) return value;
    }
    let scale = 2 ** 28;
    for (let i = 4; i < 10; i++) {
      if (this.pos >= this.end) throw new RangeError("truncated varint");
      const b = buf[this.pos++];
      value += (b & 0x7f) * scale;
      if (b < 0x80) return value;
      scale *= 0x80;
    }
    throw new RangeError("varint longer than 10 bytes");
  }

  skip(n: number): void {
    if (n > this.end - this.pos) throw new RangeError("field runs past its message");
    this.pos += n;
  }
}

class Writer {
  readonly buf: Uint8Array<ArrayBuffer>;
  pos = 0;

  constructor(size: number) {
    this.buf = new Uint8Array(size);
  }

  header(field: number, wire: number): void {
    this.varint(field * 8 + wire);
  }

  varint(n: number): void {
    while (n >= 0x80) {
      this.buf[this.pos++] = (n % 0x80) | 0x80;
      n = Math.floor(n / 0x80);
    }
    this.buf[this.pos++] = n;
  }

  copy(src: Uint8Array, start: number, end: number): void {
    if (end - start > 64) {
      this.buf.set(src.subarray(start, end), this.pos);
      this.pos += end - start;
      return;
    }
    // Most fields are a few bytes, where a view per copy costs more than
    // the bytes do.
    const buf = this.buf;
    for (let i = start; i < end; i++) buf[this.pos++] = src[i];
  }
}

function varintSize(n: number): number {
  let size = 1;
  while (n >= 0x80) {
    n = Math.floor(n / 0x80);
    size += 1;
  }
  return size;
}

const lenFieldSize = (field: number, len: number) => varintSize(field * 8 + LEN) + varintSize(len) + len;
