import assert from "node:assert/strict";
import { test } from "node:test";

import { type ChildSlot, type ParentZoom, createEnricher } from "./overture_heights.ts";

type Val = string | number | boolean;
/** A Value message written as given, valid or not. */
interface RawValue {
  raw: number[];
}
type Ring = [number, number][];
interface FeatureIn {
  props: Record<string, Val | RawValue>;
  ring: Ring;
}
interface LayerIn {
  name: string;
  features: FeatureIn[];
}

const rect = (x0: number, y0: number, x1: number, y1: number): Ring => [
  [x0, y0],
  [x1, y0],
  [x1, y1],
  [x0, y1],
];

// -- a minimal MVT encoder and decoder ---------------------------------------

class Out {
  bytes: number[] = [];
  varint(v: number): this {
    while (v >= 0x80) {
      this.bytes.push((v % 0x80) | 0x80);
      v = Math.floor(v / 0x80);
    }
    this.bytes.push(v);
    return this;
  }
  field(n: number, body: number[]): this {
    this.varint(n * 8 + 2).varint(body.length);
    for (const b of body) this.bytes.push(b);
    return this;
  }
}

const utf8 = (s: string): number[] => [...new TextEncoder().encode(s)];
const zz = (n: number): number => (n < 0 ? -2 * n - 1 : 2 * n);

function encodeValue(v: Val | RawValue): number[] {
  if (typeof v === "object") return v.raw;
  const o = new Out();
  if (typeof v === "string") o.field(1, utf8(v));
  else if (typeof v === "boolean") o.varint(7 * 8).varint(v ? 1 : 0);
  else if (Number.isInteger(v) && v >= 0) o.varint(5 * 8).varint(v);
  else {
    const b = new Uint8Array(8);
    new DataView(b.buffer).setFloat64(0, v, true);
    o.varint(3 * 8 + 1).bytes.push(...b);
  }
  return o.bytes;
}

function encodeTile(layers: LayerIn[]): Uint8Array {
  const tile = new Out();
  for (const layer of layers) {
    const keys: string[] = [];
    const values: (Val | RawValue)[] = [];
    const index = <T>(list: T[], v: T): number => {
      const i = list.indexOf(v);
      return i >= 0 ? i : list.push(v) - 1;
    };
    const l = new Out().varint(15 * 8).varint(2).field(1, utf8(layer.name));
    for (const f of layer.features) {
      const tags = new Out();
      for (const [k, v] of Object.entries(f.props)) tags.varint(index(keys, k)).varint(index(values, v));
      const geom = new Out();
      let x = 0;
      let y = 0;
      f.ring.forEach(([px, py], i) => {
        if (i === 0) geom.varint(1 * 8 + 1);
        if (i === 1) geom.varint((f.ring.length - 1) * 8 + 2);
        geom.varint(zz(px - x)).varint(zz(py - y));
        x = px;
        y = py;
      });
      geom.varint(7 + 8);
      const feat = new Out().field(2, tags.bytes).varint(3 * 8).varint(3).field(4, geom.bytes);
      l.field(2, feat.bytes);
    }
    for (const k of keys) l.field(3, utf8(k));
    for (const v of values) l.field(4, encodeValue(v));
    l.varint(5 * 8).varint(4096);
    tile.field(3, l.bytes);
  }
  return Uint8Array.from(tile.bytes);
}

interface FeatureOut {
  props: Record<string, Val>;
  geometry: number[];
}

function decodeTile(buf: Uint8Array): Map<string, FeatureOut[]> {
  let pos = 0;
  const varint = (): number => {
    let v = 0;
    let s = 1;
    for (;;) {
      const b = buf[pos++];
      if (b === undefined) throw new Error("truncated");
      v += (b & 0x7f) * s;
      if (b < 0x80) return v;
      s *= 128;
    }
  };
  const fields = (end: number, each: (field: number, wire: number, start: number, end: number) => void) => {
    while (pos < end) {
      const t = varint();
      const field = Math.floor(t / 8);
      const wire = t % 8;
      if (wire === 2) {
        const len = varint();
        const s = pos;
        pos += len;
        if (pos > end) throw new Error("overrun");
        const after = pos;
        each(field, wire, s, pos);
        pos = after;
      } else if (wire === 0) {
        const s = pos;
        varint();
        each(field, wire, s, pos);
      } else if (wire === 1) {
        each(field, wire, pos, pos + 8);
        pos += 8;
      } else throw new Error(`wire ${wire}`);
    }
  };
  const text = (s: number, e: number) => new TextDecoder().decode(buf.subarray(s, e));
  const layers = new Map<string, FeatureOut[]>();
  fields(buf.length, (f, _w, ls, le) => {
    if (f !== 3) return;
    pos = ls;
    let name = "";
    const keys: string[] = [];
    const values: Val[] = [];
    const raw: { tags: number[]; geometry: number[] }[] = [];
    fields(le, (lf, _lw, s, e) => {
      if (lf === 1) name = text(s, e);
      else if (lf === 3) keys.push(text(s, e));
      else if (lf === 4) {
        pos = s;
        fields(e, (vf, _vw, vs, ve) => {
          if (vf === 1) values.push(text(vs, ve));
          else if (vf === 3) values.push(new DataView(buf.buffer, buf.byteOffset + vs, 8).getFloat64(0, true));
          else if (vf === 7) values.push(buf[vs] === 1);
          else {
            pos = vs;
            values.push(varint());
          }
        });
      } else if (lf === 2) {
        pos = s;
        const feat = { tags: [] as number[], geometry: [] as number[] };
        fields(e, (ff, _fw, fs, fe) => {
          if (ff === 2) {
            pos = fs;
            while (pos < fe) feat.tags.push(varint());
          } else if (ff === 4) feat.geometry = [...buf.subarray(fs, fe)];
        });
        raw.push(feat);
      }
    });
    layers.set(
      name,
      raw.map((r) => {
        const props: Record<string, Val> = {};
        for (let i = 0; i < r.tags.length; i += 2) props[keys[r.tags[i]]] = values[r.tags[i + 1]];
        return { props, geometry: r.geometry };
      }),
    );
  });
  return layers;
}

// -- helpers -------------------------------------------------------------------

/** Runs the join with `children` keyed by "dx,dy"; every other slot is a
 *  child upstream does not have. */
function enrich(z: ParentZoom, parent: Uint8Array, children: Record<string, Uint8Array>) {
  const e = createEnricher(z, parent);
  assert.ok(e, "parent parses");
  for (const s of e.slots) e.ingest(s, children[`${s.dx},${s.dy}`] ?? null);
  return e.finish();
}

const tall = { id: "08b-tall", height: 42.5, num_floors: 12, min_height: 3.5, has_parts: true, is_underground: false };
const z12Parent = (ring: Ring, props: Record<string, Val> = { "@height_source": "OpenStreetMap" }) =>
  encodeTile([{ name: "building", features: [{ props, ring }] }]);

// -- behaviour -------------------------------------------------------------------

test("a z12 building gains the five fields of the z14 building under it, footprint untouched", () => {
  const parent = z12Parent(rect(100, 100, 200, 200));
  const child = encodeTile([{ name: "building", features: [{ props: tall, ring: rect(400, 400, 800, 800) }] }]);
  const out = enrich(12, parent, { "0,0": child });

  assert.equal(out.state, "complete");
  const [before] = decodeTile(parent).get("building")!;
  const [after] = decodeTile(out.bytes).get("building")!;
  assert.deepEqual(after.props, {
    "@height_source": "OpenStreetMap",
    height: 42.5,
    num_floors: 12,
    min_height: 3.5,
    has_parts: true,
    is_underground: false,
  });
  assert.deepEqual(after.geometry, before.geometry);
});

test("a building part gains its four fields and never has_parts or an id", () => {
  const parent = encodeTile([{ name: "building_part", features: [{ props: {}, ring: rect(100, 100, 200, 200) }] }]);
  const child = encodeTile([
    { name: "building_part", features: [{ props: { ...tall, building_id: "08b-b" }, ring: rect(400, 400, 800, 800) }] },
  ]);
  const [part] = decodeTile(enrich(12, parent, { "0,0": child }).bytes).get("building_part")!;
  assert.deepEqual(part.props, { height: 42.5, num_floors: 12, min_height: 3.5, is_underground: false });
});

test("a tile with nothing to match comes back byte for byte", () => {
  const parent = encodeTile([
    { name: "building", features: [{ props: {}, ring: rect(100, 100, 200, 200) }] },
    { name: "building_part", features: [{ props: {}, ring: rect(300, 300, 400, 400) }] },
  ]);
  const far = encodeTile([{ name: "building", features: [{ props: tall, ring: rect(3000, 3000, 3100, 3100) }] }]);
  const out = enrich(12, parent, { "0,0": far });
  assert.deepEqual(out.bytes, parent);
  assert.equal(out.state, "complete");
});

test("unmatched features and other layers keep their exact bytes", () => {
  const parent = encodeTile([
    { name: "water", features: [{ props: { k: "v" }, ring: rect(100, 100, 200, 200) }] },
    {
      name: "building",
      features: [
        { props: {}, ring: rect(100, 100, 200, 200) },
        { props: { "@height_source": "x" }, ring: rect(500, 500, 600, 600) },
      ],
    },
  ]);
  const child = encodeTile([{ name: "building", features: [{ props: tall, ring: rect(400, 400, 800, 800) }] }]);
  const before = decodeTile(parent);
  const after = decodeTile(enrich(12, parent, { "0,0": child }).bytes);
  assert.deepEqual(after.get("water"), before.get("water"));
  assert.deepEqual(after.get("building")![1], before.get("building")![1]);
  assert.equal(after.get("building")![0].props.height, 42.5);
});

// A z12 building around the corner where four z14 tiles meet: x and y
// 1014..1034, which is 4056..4136 at z14. Each child holds a 40 x 40
// quarter, and a quarter alone scores 0.25.
const cornerParent = () => z12Parent(rect(1014, 1014, 1034, 1034));
const corner = (props: (slot: string) => Record<string, Val>) => ({
  "0,0": encodeTile([{ name: "building", features: [{ props: props("0,0"), ring: rect(4056, 4056, 4096, 4096) }] }]),
  "1,0": encodeTile([{ name: "building", features: [{ props: props("1,0"), ring: rect(0, 4056, 40, 4096) }] }]),
  "0,1": encodeTile([{ name: "building", features: [{ props: props("0,1"), ring: rect(4056, 0, 4096, 40) }] }]),
  "1,1": encodeTile([{ name: "building", features: [{ props: props("1,1"), ring: rect(0, 0, 40, 40) }] }]),
});

test("a building cut by z14 tile edges is joined as one by its id", () => {
  const joined = enrich(12, cornerParent(), corner(() => tall));
  assert.equal(decodeTile(joined.bytes).get("building")![0].props.height, 42.5);

  const apart = enrich(12, cornerParent(), corner((slot) => ({ ...tall, id: slot })));
  assert.equal(decodeTile(apart.bytes).get("building")![0].props.height, undefined);
});

test("each z14 building goes to at most one parent, the one it overlaps best", () => {
  const parent = encodeTile([
    {
      name: "building",
      features: [
        { props: {}, ring: rect(100, 100, 200, 190) },
        { props: {}, ring: rect(100, 100, 200, 200) },
      ],
    },
  ]);
  const child = encodeTile([{ name: "building", features: [{ props: tall, ring: rect(400, 400, 800, 800) }] }]);
  const [near, exact] = decodeTile(enrich(12, parent, { "0,0": child }).bytes).get("building")!;
  assert.equal(exact.props.height, 42.5);
  assert.equal(near.props.height, undefined);
});

test("a parent takes the donor it overlaps best when two compete", () => {
  const parent = z12Parent(rect(100, 100, 200, 200));
  const child = encodeTile([
    {
      name: "building",
      features: [
        { props: { ...tall, id: "a", height: 1 }, ring: rect(400, 400, 720, 800) },
        { props: { ...tall, id: "b", height: 2 }, ring: rect(400, 400, 780, 800) },
      ],
    },
  ]);
  assert.equal(decodeTile(enrich(12, parent, { "0,0": child }).bytes).get("building")![0].props.height, 2);
});

test("an overlap of 0.3 or less is no match", () => {
  // Parent 100 units wide; the donor shares its height and w of its width,
  // so the IoU is w / 100.
  const heightFor = (w: number) => {
    const parent = z12Parent(rect(100, 500, 200, 600));
    const child = encodeTile([{ name: "building", features: [{ props: tall, ring: rect(400, 2000, 400 + 4 * w, 2400) }] }]);
    return decodeTile(enrich(12, parent, { "0,0": child }).bytes).get("building")![0].props.height;
  };
  assert.equal(heightFor(29), undefined);
  assert.equal(heightFor(30), undefined);
  assert.equal(heightFor(31), 42.5);
});

test("z13 tiles read four children at half scale, z12 sixteen at quarter scale", () => {
  const z13 = encodeTile([{ name: "building", features: [{ props: {}, ring: rect(2100, 100, 2300, 300) }] }]);
  const z13Child = encodeTile([{ name: "building", features: [{ props: tall, ring: rect(104, 200, 504, 600) }] }]);
  const e13 = createEnricher(13, z13)!;
  assert.equal(e13.slots.length, 4);
  for (const s of e13.slots) e13.ingest(s, s.dx === 1 && s.dy === 0 ? z13Child : null);
  assert.equal(decodeTile(e13.finish().bytes).get("building")![0].props.height, 42.5);

  const z12 = encodeTile([{ name: "building", features: [{ props: {}, ring: rect(3200, 3200, 3300, 3300) }] }]);
  const z12Child = encodeTile([{ name: "building", features: [{ props: tall, ring: rect(512, 512, 912, 912) }] }]);
  const e12 = createEnricher(12, z12)!;
  assert.equal(e12.slots.length, 16);
  for (const s of e12.slots) e12.ingest(s, s.dx === 3 && s.dy === 3 ? z12Child : null);
  assert.equal(decodeTile(e12.finish().bytes).get("building")![0].props.height, 42.5);

  assert.equal(decodeTile(enrich(12, z12, { "1,1": z12Child }).bytes).get("building")![0].props.height, undefined);
});

test("buildings and building parts are matched within their own layer only", () => {
  const parent = encodeTile([
    { name: "building", features: [{ props: {}, ring: rect(100, 100, 200, 200) }] },
    { name: "building_part", features: [{ props: {}, ring: rect(100, 100, 200, 200) }] },
  ]);
  const child = encodeTile([
    { name: "building_part", features: [{ props: { ...tall, height: 7 }, ring: rect(400, 400, 800, 800) }] },
  ]);
  const out = decodeTile(enrich(12, parent, { "0,0": child }).bytes);
  assert.equal(out.get("building")![0].props.height, undefined);
  assert.equal(out.get("building_part")![0].props.height, 7);
});

test("the result does not depend on the order children arrive in", () => {
  const parent = cornerParent();
  const heights: Record<string, number> = { "0,0": 1, "1,0": 2, "0,1": 3, "1,1": 4 };
  const children: Record<string, Uint8Array> = corner((slot) => ({ ...tall, height: heights[slot] }));
  const run = (order: ChildSlot[]) => {
    const e = createEnricher(12, parent)!;
    for (const s of order) e.ingest(s, children[`${s.dx},${s.dy}`] ?? null);
    const first = e.finish();
    assert.deepEqual(e.finish().bytes, first.bytes);
    return first.bytes;
  };
  const slots = createEnricher(12, parent)!.slots;
  const forward = run([...slots]);
  assert.deepEqual(run([...slots].reverse()), forward);
  assert.equal(decodeTile(forward).get("building")![0].props.height, 1);
});

test("a missing child leaves the tile incomplete but enriched from what arrived", () => {
  const parent = z12Parent(rect(100, 100, 200, 200));
  const child = encodeTile([{ name: "building", features: [{ props: tall, ring: rect(400, 400, 800, 800) }] }]);
  const e = createEnricher(12, parent)!;
  for (const s of e.slots) {
    if (s.dx === 3 && s.dy === 3) e.markMissing(s);
    else e.ingest(s, s.dx === 0 && s.dy === 0 ? child : null);
  }
  const out = e.finish();
  assert.equal(out.state, "partial");
  assert.equal(decodeTile(out.bytes).get("building")![0].props.height, 42.5);

  const partial = createEnricher(12, parent)!;
  partial.ingest({ dx: 0, dy: 0 }, child);
  assert.equal(partial.finish().state, "partial", "children never read");
});

test("a parent that does not parse is refused", () => {
  const parent = encodeTile([
    { name: "building", features: [{ props: { "@height_source": "x" }, ring: rect(100, 100, 200, 200) }] },
  ]);
  for (let n = 0; n < parent.length; n++) {
    assert.equal(createEnricher(12, parent.subarray(0, n)), null, `prefix of ${n} bytes`);
  }
  assert.equal(createEnricher(12, encodeTile([{ name: "water", features: [] }])), null);
});

test("a child that does not parse counts as empty, and the tile is still complete", () => {
  const parent = z12Parent(rect(100, 100, 200, 200));
  const child = encodeTile([{ name: "building", features: [{ props: tall, ring: rect(400, 400, 800, 800) }] }]);
  for (let n = 1; n < child.length; n++) {
    const e = createEnricher(12, parent)!;
    for (const s of e.slots) {
      assert.equal(e.ingest(s, s.dx === 0 && s.dy === 0 ? child.subarray(0, n) : null), !(s.dx === 0 && s.dy === 0));
    }
    const out = e.finish();
    assert.deepEqual(out.bytes, parent, `prefix of ${n} bytes`);
    assert.equal(out.state, "complete");
  }
});

test("a value that is not a well-formed MVT Value is dropped, and the others still join", () => {
  const parent = z12Parent(rect(100, 100, 200, 200));
  const run = (height: RawValue) => {
    const child = encodeTile([
      { name: "building", features: [{ props: { id: "a", height, num_floors: 12 }, ring: rect(400, 400, 800, 800) }] },
    ]);
    return decodeTile(enrich(12, parent, { "0,0": child }).bytes).get("building")![0].props;
  };
  const double = [0x19, 0, 0, 0, 0, 0, 0, 0x45, 0x40];
  assert.equal(run({ raw: double }).height, 42);
  const invalid: Record<string, number[]> = {
    "field 0": [0x07],
    "field 8": [0x40, 0x01],
    "string as a varint": [0x08, 0x01],
    "double as a varint": [0x18, 0x01],
    "bool as fixed32": [0x3d, 0, 0, 0, 0],
    "two fields": [...double, 0x38, 0x01],
    "trailing byte": [...double, 0x00],
    empty: [],
  };
  for (const [name, raw] of Object.entries(invalid)) {
    assert.deepEqual(run({ raw }), { "@height_source": "OpenStreetMap", num_floors: 12 }, name);
  }
});

test("only the building and building_part layers join, whatever the others are called", () => {
  const box = { props: {}, ring: rect(100, 100, 200, 200) };
  const donor = { props: tall, ring: rect(400, 400, 800, 800) };
  const names = ["building", "toString", "constructor", "__proto__", "hasOwnProperty"];
  const parent = encodeTile(names.map((name) => ({ name, features: [box] })));
  const out = enrich(12, parent, { "0,0": encodeTile(names.map((name) => ({ name, features: [donor] }))) });
  assert.deepEqual(out.matched, { building: 1, building_part: 0 });
  const layers = decodeTile(out.bytes);
  for (const name of names.slice(1)) assert.deepEqual(layers.get(name), decodeTile(parent).get(name), name);
});

test("thousands of identical boxes are matched in bounded time", () => {
  const box = rect(0, 0, 1024, 1024);
  const parent = encodeTile([{ name: "building", features: Array.from({ length: 2000 }, () => ({ props: {}, ring: box })) }]);
  const child = encodeTile([
    {
      name: "building",
      features: Array.from({ length: 20_000 }, () => ({ props: { height: 9 }, ring: rect(0, 0, 4096, 4096) })),
    },
  ]);
  const started = performance.now();
  const out = enrich(12, parent, { "0,0": child });
  assert.ok(performance.now() - started < 3000, `took ${performance.now() - started} ms`);
  assert.equal(out.state, "complete");
  assert.ok(out.matched.building > 0, "assigned from the pairs scored before the cap");
});

test("mutated tiles never throw", () => {
  let seed = 7;
  const rand = (n: number) => {
    seed = (Math.imul(seed, 1103515245) + 12345) >>> 0;
    return seed % n;
  };
  const parent = encodeTile([
    {
      name: "building",
      features: [
        { props: { "@height_source": "x" }, ring: rect(100, 100, 200, 200) },
        { props: {}, ring: rect(1000, 100, 1048, 200) },
      ],
    },
    { name: "building_part", features: [{ props: {}, ring: rect(100, 100, 200, 200) }] },
  ]);
  const child = encodeTile([
    {
      name: "building",
      features: [
        { props: tall, ring: rect(400, 400, 800, 800) },
        { props: { ...tall, id: "s" }, ring: rect(4000, 400, 4096, 800) },
      ],
    },
    { name: "building_part", features: [{ props: tall, ring: rect(400, 400, 800, 800) }] },
  ]);
  const mutate = (src: Uint8Array) => {
    const b = src.slice();
    for (let k = 1 + rand(4); k > 0; k--) b[rand(b.length)] = rand(256);
    return b;
  };
  for (let i = 0; i < 2000; i++) {
    const p = i % 2 === 0 ? mutate(parent) : parent;
    const e = createEnricher(12, p);
    if (!e) continue;
    let ok = true;
    for (const s of e.slots) ok = e.ingest(s, s.dx === 0 && s.dy === 0 ? mutate(child) : null) && ok;
    const out = e.finish();
    assert.ok(out.bytes instanceof Uint8Array);
    if (!ok) assert.deepEqual(out.bytes, p);
    assert.equal(out.state, "complete");
  }
});
