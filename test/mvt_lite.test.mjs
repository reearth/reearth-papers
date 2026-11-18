import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { test } from "node:test";

import { VectorTile } from "@mapbox/vector-tile";
import Pbf from "pbf";

import { loadSrc } from "./load-src.mjs";
import { encodeTile, len, line, point, unknownField, varint } from "./mvt-fixture.mjs";

const { filterTile, liteTile, LITE_RULES, LITE_VERSION } = await loadSrc("mvt_lite");

const decode = (bytes) => new VectorTile(new Pbf(bytes));

/** Everything a renderer reads from each feature. */
function features(tile, name) {
  const layer = tile.layers[name];
  const out = [];
  for (let i = 0; i < layer.length; i++) {
    const f = layer.feature(i);
    out.push({ id: f.id, type: f.type, geometry: f.loadGeometry(), properties: { ...f.properties } });
  }
  return out;
}

const without = (props, keys) => Object.fromEntries(Object.entries(props).filter(([k]) => !keys.includes(k)));

const has = (haystack, needle) => Buffer.from(haystack).includes(Buffer.from(needle));

/** Overture-like: provenance keys, a value shared between a dropped key
 *  and a kept one, a value no tag uses, and an untagged feature. */
const WATER = {
  name: "water",
  extent: 8192,
  keys: ["id", "class", "sources", "subtype", "source_tags", "is_salt"],
  values: ["08b2f", "lake", '[{"dataset":"OpenStreetMap"}]', "water", "{}", true, "unused", 0.5],
  features: [
    { id: 7, type: 3, geometry: line(4, 4), tags: [0, 0, 1, 1, 2, 2, 3, 3, 4, 4, 5, 5] },
    { id: 8, type: 2, geometry: line(9, 2), tags: [0, 3, 1, 3] },
    { type: 1, geometry: point(3, 3) },
  ],
};

const BATHYMETRY_UNTAGGED = {
  name: "bathymetry",
  keys: ["depth"],
  values: [200],
  features: [{ type: 3, geometry: line(1, 1) }, { type: 3, geometry: line(2, 2) }],
};

test("dropped keys are gone and every other part of each feature decodes the same", () => {
  const src = encodeTile([WATER]);
  const out = liteTile(src);

  const before = decode(src).layers.water;
  const after = decode(out).layers.water;
  assert.equal(after.extent, before.extent);
  assert.equal(after.version, before.version);
  const dropped = [...LITE_RULES.dropKeys];
  assert.deepEqual(
    features(decode(out), "water"),
    features(decode(src), "water").map((f) => ({ ...f, properties: without(f.properties, dropped) })),
  );
  // "water" is the value of both the dropped `id` and the kept `subtype`.
  assert.deepEqual(features(decode(out), "water")[1].properties, { class: "water" });
  assert.ok(out.length < src.length);
  assert.ok(!has(out, "OpenStreetMap"), "a value only dropped keys used is gone");
  assert.ok(has(out, "unused"), "a value no tag used is kept");
});

test("an untagged bathymetry layer is omitted; one tagged feature keeps every feature", () => {
  const omitted = decode(liteTile(encodeTile([WATER, BATHYMETRY_UNTAGGED])));
  assert.deepEqual(Object.keys(omitted.layers), ["water"]);

  const oneTagged = {
    ...BATHYMETRY_UNTAGGED,
    features: [...BATHYMETRY_UNTAGGED.features, { type: 3, geometry: line(3, 3), tags: [0, 0] }],
  };
  const src = encodeTile([oneTagged]);
  assert.deepEqual(features(decode(liteTile(src)), "bathymetry"), features(decode(src), "bathymetry"));

  // Only the layers the rules name are dropped for being untagged.
  const land = { ...BATHYMETRY_UNTAGGED, name: "land" };
  assert.deepEqual(Object.keys(decode(liteTile(encodeTile([land, WATER]))).layers), ["land", "water"]);
});

test("untagged features stay, and fields the filter does not know survive", () => {
  const tileField = unknownField(42, "tile-extension");
  const layerField = unknownField(20, "layer-extension");
  const featureField = unknownField(9, "feature-extension");
  const water = {
    ...WATER,
    extra: layerField,
    features: [{ ...WATER.features[0], extra: featureField }, ...WATER.features.slice(1)],
  };
  const out = liteTile(encodeTile([water], tileField));

  assert.equal(decode(out).layers.water.length, 3);
  assert.deepEqual(features(decode(out), "water")[2].properties, {});
  for (const text of ["tile-extension", "layer-extension", "feature-extension"]) {
    assert.ok(has(out, text), `${text} kept`);
  }
});

test("with nothing to drop the input comes back unchanged, and lite is idempotent", () => {
  const src = encodeTile([WATER, BATHYMETRY_UNTAGGED]);
  const none = { dropKeys: new Set(), dropLayersWhenUntagged: new Set() };
  assert.equal(filterTile(src, none), src);

  const once = liteTile(src);
  assert.deepEqual(liteTile(once), once);
});

const malformed = {
  "truncated varint": Uint8Array.from([0x1a, 0x80]),
  "field past its parent": Uint8Array.from([0x1a, 0x05, 0x0a, 0x01]),
  "unknown wire type": Uint8Array.from([0x1b]),
  "unpacked tags": encodeTile([{ name: "water", keys: ["class"], values: ["lake"], features: [] }], len(3, [
    ...len(1, [0x77]),
    ...len(2, [0x10, 0x00]),
  ])),
  "odd tag count": encodeTile([{ ...WATER, features: [{ type: 1, tags: [1, 1, 1] }] }]),
  "key index out of range": encodeTile([{ ...WATER, features: [{ type: 1, tags: [6, 0] }] }]),
  "value index out of range": encodeTile([{ ...WATER, features: [{ type: 1, tags: [1, 8] }] }]),
  "length past the end of the tile": Uint8Array.from([0x1a, ...varint(2 ** 40), 0]),
  "varint longer than ten bytes": Uint8Array.from([0x1a, ...new Array(11).fill(0xff)]),
};

for (const [name, bytes] of Object.entries(malformed)) {
  test(`a tile with ${name} throws RangeError`, () => {
    assert.throws(() => liteTile(bytes), RangeError);
  });
}

// Stored lite tiles and their ETags are keyed on LITE_VERSION, so the
// same input must give the same bytes until the version moves. Record
// the new rules and digest when bumping it.
const PINNED = {
  1: {
    rules: { dropKeys: ["id", "source_tags", "sources"], dropLayersWhenUntagged: ["bathymetry"] },
    digest: "fa4c5481a93f79631b3097ba7ea1fbf46c67a88cc238a94472a1bded131f4559",
  },
};

test("LITE_RULES are pinned to LITE_VERSION", () => {
  const rules = {
    dropKeys: [...LITE_RULES.dropKeys].sort(),
    dropLayersWhenUntagged: [...LITE_RULES.dropLayersWhenUntagged].sort(),
  };
  assert.deepEqual(rules, PINNED[LITE_VERSION]?.rules);
});

test("lite output is pinned to LITE_VERSION", () => {
  const out = liteTile(encodeTile([WATER, BATHYMETRY_UNTAGGED]));
  assert.equal(createHash("sha256").update(out).digest("hex"), PINNED[LITE_VERSION]?.digest);
});

// LITE_REAL_TILES=a.mvt,b.mvt npm test reruns the first and fourth
// cases on saved tiles (for example from /overture_base/6/32/22.mvt).
const realTiles = process.env.LITE_REAL_TILES?.split(",").filter(Boolean) ?? [];
for (const path of realTiles) {
  test(`real tile ${path}: lite decodes the same apart from what it drops`, () => {
    const src = new Uint8Array(readFileSync(path));
    const started = performance.now();
    const out = liteTile(src);
    const ms = performance.now() - started;
    const before = decode(src);
    const after = decode(out);
    const dropped = [...LITE_RULES.dropKeys];
    let count = 0;
    for (const name of Object.keys(before.layers)) {
      const kept = features(before, name).map((f) => ({ ...f, properties: without(f.properties, dropped) }));
      if (!after.layers[name]) {
        assert.ok(LITE_RULES.dropLayersWhenUntagged.has(name), `${name} omitted`);
        assert.ok(kept.every((f) => Object.keys(f.properties).length === 0), `${name} had no kept property`);
        continue;
      }
      assert.deepEqual(features(after, name), kept, name);
      count += kept.length;
    }
    assert.deepEqual(liteTile(out), out);
    console.log(`${path}: ${src.length} -> ${out.length} bytes, ${count} features, ${ms.toFixed(1)} ms`);
  });
}
