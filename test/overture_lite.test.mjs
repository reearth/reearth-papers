import assert from "node:assert/strict";
import { afterEach, beforeEach, test } from "node:test";

import { VectorTile } from "@mapbox/vector-tile";
import Pbf from "pbf";

import { buildArchive, fakeS3 } from "./fake-s3.mjs";
import { loadSrc } from "./load-src.mjs";
import { encodeTile, line } from "./mvt-fixture.mjs";

const NEWEST = "2026-11-18.0";
const ZXY = { z: 0, x: 0, y: 0 };

const TILE = encodeTile([
  {
    name: "water",
    keys: ["id", "class", "sources"],
    values: ["08b2f", "lake", '[{"dataset":"OpenStreetMap"}]'],
    features: [{ id: 1, type: 3, geometry: line(2, 2), tags: [0, 0, 1, 1, 2, 2] }],
  },
]);

let s3;
let errors;
const realFetch = globalThis.fetch;
const realError = console.error;

beforeEach(() => {
  s3 = fakeS3();
  globalThis.fetch = s3.fetch;
  errors = [];
  console.error = (line) => errors.push(JSON.parse(line));
});

afterEach(() => {
  globalThis.fetch = realFetch;
  console.error = realError;
});

/** A new isolate, answering lite requests the way the route does. */
async function isolate() {
  const { handleOvertureLiteTile, handleOvertureTile } = await loadSrc("overture");
  return {
    lite: (c = ZXY) => handleOvertureLiteTile("base", c),
    base: (c = ZXY) => handleOvertureTile("base", c),
  };
}

const properties = (bytes) => {
  const water = new VectorTile(new Pbf(bytes)).layers.water;
  return { ...water.feature(0).properties };
};

test("a lite tile answers the filtered tile with the base headers", async () => {
  s3.put(`tiles/${NEWEST}/base.pmtiles`, buildArchive([{ ...ZXY, data: TILE }]), '"v1"');
  const { lite } = await isolate();

  const res = await lite();
  assert.equal(res.status, 200);
  assert.equal(res.headers.get("content-type"), "application/x-protobuf");
  assert.equal(res.headers.get("vary"), "accept-encoding");
  assert.equal(res.headers.get("cache-control"), "public, max-age=3600, stale-while-revalidate=86400");
  assert.equal(res.headers.get("x-overture-release"), NEWEST);
  assert.deepEqual(properties(new Uint8Array(await res.arrayBuffer())), { class: "lake" });

});

test("a failed lite read answers the logged 503", async () => {
  s3.put(`tiles/${NEWEST}/base.pmtiles`, buildArchive([{ ...ZXY, data: TILE }]), '"v1"');
  const { lite } = await isolate();

  s3.failReads(1);
  const res = await lite();
  assert.equal(res.status, 503);
  assert.equal(res.headers.get("retry-after"), "1");
  assert.equal(res.headers.get("cache-control"), "no-store");
  assert.equal(errors[0].evt, "overture.read_failed");
  assert.equal((await lite()).status, 200);
});

test("a tile the filter cannot parse answers 502, never the unfiltered bytes", async () => {
  s3.put(`tiles/${NEWEST}/base.pmtiles`, buildArchive([{ ...ZXY, data: "not a vector tile" }]), '"v1"');
  const { lite } = await isolate();

  const res = await lite();
  assert.equal(res.status, 502);
  assert.equal(res.headers.get("cache-control"), "no-store");
  assert.doesNotMatch(await res.text(), /not a vector tile/);
  assert.equal(errors.length, 1);
  assert.equal(errors[0].evt, "overture.lite_failed");
  assert.equal(errors[0].release, NEWEST);
});

test("lite answers 204 for an absent tile and 404 out of range, as base does", async () => {
  s3.put(`tiles/${NEWEST}/base.pmtiles`, buildArchive([{ ...ZXY, data: TILE }], { maxZoom: 1 }), '"v1"');
  const { lite, base } = await isolate();

  for (const [c, status] of [[{ z: 1, x: 1, y: 1 }, 204], [{ z: 2, x: 0, y: 0 }, 404]]) {
    assert.equal((await lite(c)).status, status);
    assert.equal((await base(c)).status, status);
  }
});

test("overture_base still answers the archive's bytes with today's headers", async () => {
  s3.put(`tiles/${NEWEST}/base.pmtiles`, buildArchive([{ ...ZXY, data: TILE }]), '"v1"');
  const { base } = await isolate();

  const res = await base();
  assert.deepEqual(new Uint8Array(await res.arrayBuffer()), TILE);
  assert.deepEqual([...res.headers.keys()].sort(), [
    "cache-control",
    "content-type",
    "vary",
    "x-attribution",
    "x-overture-release",
  ]);
});

test("lite TileJSON fields leave out the dropped keys, and base keeps them", async () => {
  s3.put(`tiles/${NEWEST}/base.pmtiles`, buildArchive([], {
    maxZoom: 13,
    metadata: {
      vector_layers: [
        { id: "water", fields: { id: "String", class: "String", sources: "String", source_tags: "String" } },
      ],
    },
  }), '"v1"');
  const { overtureArchive, OVERTURE_TILESETS } = await loadSrc("overture");
  const { LITE_RULES } = await loadSrc("mvt_lite");
  const { tilesetVectorLayers } = await loadSrc("vector_layers");
  const d = OVERTURE_TILESETS.find((t) => t.lite);
  const def = { id: d.id, minzoom: d.minzoom, maxzoom: d.maxzoom, archive: () => overtureArchive(d.theme) };
  const water = async (spec) =>
    (await tilesetVectorLayers(spec, d.layers, {}, () => {})).layers.find((l) => l.id === "water").fields;

  assert.deepEqual(await water({ ...def, tileFilter: LITE_RULES }), { class: "String" });
  assert.deepEqual(Object.keys(await water(def)), ["id", "class", "sources", "source_tags"]);
});
