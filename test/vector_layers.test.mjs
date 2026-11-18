import assert from "node:assert/strict";
import { afterEach, beforeEach, test } from "node:test";

import { buildArchive, fakeR2, fakeS3 } from "./fake-s3.mjs";
import { loadSrc } from "./load-src.mjs";

const PLANETILER_METADATA = {
  name: "Protomaps Basemap",
  vector_layers: [
    { id: "earth", fields: { kind: "String" }, minzoom: 0, maxzoom: 15 },
    { id: "roads", fields: { kind: "String", "name:ja": "String", oneway: "Boolean" }, minzoom: 3, maxzoom: 15 },
    { id: "transit", fields: { kind: "String" }, minzoom: 9, maxzoom: 15 },
  ],
};

const TIPPECANOE_METADATA = {
  generator: "tippecanoe v2.53.0",
  vector_layers: [
    { id: "bathymetry", description: "", minzoom: 0, maxzoom: 6, fields: { depth: "Number", scalerank: "Number" } },
  ],
  tilestats: { layerCount: 1, layers: [{ layer: "bathymetry", geometry: "Polygon" }] },
};

const PROTOMAPS_REGISTRY = [
  { id: "earth", description: "Landmass polygons", minzoom: 0, geometry: "polygon" },
  { id: "roads", description: "Roads", minzoom: 0, geometry: "line" },
  { id: "pois", description: "Points of interest", minzoom: 0, geometry: "point" },
];

/** Today's `vector_layers` expression, from before archives were read. */
const withoutFields = (registry, maxzoom) =>
  registry.map((l) => ({
    id: l.id,
    description: l.description,
    minzoom: l.minzoom,
    maxzoom,
    geometry: l.geometry,
    fields: {},
  }));

let warnings;
const realWarn = console.warn;
const realFetch = globalThis.fetch;

beforeEach(() => {
  warnings = [];
  console.warn = (line) => warnings.push(line);
});

afterEach(() => {
  console.warn = realWarn;
  globalThis.fetch = realFetch;
});

/** Collects what the handler hands to `ctx.waitUntil`. */
function waitUntilSpy() {
  const pending = [];
  const waitUntil = (p) => pending.push(p);
  waitUntil.settled = () => Promise.all(pending);
  return waitUntil;
}

function protomapsEnv(metadata) {
  const key = "mirror/protomaps/20261101.pmtiles";
  return {
    MIRROR_PREFIX: "mirror/protomaps",
    R2: fakeR2({
      "mirror/protomaps/latest.json": { json: { date: "20261101", key, size: 1 } },
      [key]: { bytes: buildArchive([], { maxZoom: 15, metadata }), etag: '"p1"' },
    }),
  };
}

test("a Protomaps tileset lists each layer's fields and zooms from its R2 archive", async () => {
  const { protomapsArchive } = await loadSrc("pmtiles");
  const { tilesetVectorLayers } = await loadSrc("vector_layers");
  const def = { id: "protomaps", minzoom: 0, maxzoom: 15, archive: protomapsArchive };

  const { layers, maxAge } = await tilesetVectorLayers(
    def, PROTOMAPS_REGISTRY, protomapsEnv(PLANETILER_METADATA), waitUntilSpy(),
  );

  assert.equal(maxAge, 300);
  assert.deepEqual(layers, [
    { id: "earth", description: "Landmass polygons", minzoom: 0, maxzoom: 15, geometry: "polygon", fields: { kind: "String" } },
    { id: "roads", description: "Roads", minzoom: 3, maxzoom: 15, geometry: "line", fields: { kind: "String", "name:ja": "String", oneway: "Boolean" } },
    { id: "pois", description: "Points of interest", minzoom: 0, maxzoom: 15, geometry: "point", fields: {} },
  ]);
  assert.deepEqual(warnings, []);
});

test("a Natural Earth tileset lists its tippecanoe fields", async () => {
  const { neVectorArchive, NE_VECTOR_TILESETS, kindGeometry } = await loadSrc("naturalearth_vector");
  const { tilesetVectorLayers } = await loadSrc("vector_layers");
  const ne = NE_VECTOR_TILESETS.find((t) => t.id === "naturalearth_bathymetry");
  const env = {
    R2: fakeR2({
      [ne.archiveKey]: { bytes: buildArchive([], { maxZoom: 6, metadata: TIPPECANOE_METADATA }), etag: '"n1"' },
    }),
  };
  const def = { id: ne.id, minzoom: ne.minzoom, maxzoom: ne.maxzoom, archive: async (e) => neVectorArchive(e, ne.archiveKey) };
  const registry = ne.layers.map((l) => ({ id: l.id, description: l.description, minzoom: l.minzoom, geometry: kindGeometry(l.kind) }));

  const { layers } = await tilesetVectorLayers(def, registry, env, waitUntilSpy());

  assert.deepEqual(layers.map((l) => [l.id, l.geometry, l.fields]), [
    ["bathymetry", "polygon", { depth: "Number", scalerank: "Number" }],
  ]);
});

test("an Overture tileset lists the fields of the release its tiles come from", async () => {
  const s3 = fakeS3();
  globalThis.fetch = s3.fetch;
  s3.put("tiles/2026-11-18.0/base.pmtiles", buildArchive([], {
    maxZoom: 13,
    metadata: { vector_layers: [{ id: "bathymetry", fields: { depth: "Number" }, minzoom: 0, maxzoom: 13 }] },
  }), '"o2"');
  s3.put("tiles/2026-10-21.0/base.pmtiles", buildArchive([], {
    maxZoom: 13,
    metadata: { vector_layers: [{ id: "bathymetry", fields: { old: "String" }, minzoom: 0, maxzoom: 13 }] },
  }), '"o1"');
  const { overtureArchive, OVERTURE_TILESETS } = await loadSrc("overture");
  const { tilesetVectorLayers } = await loadSrc("vector_layers");
  const base = OVERTURE_TILESETS.find((t) => t.theme === "base");
  const def = { id: base.id, minzoom: base.minzoom, maxzoom: base.maxzoom, archive: () => overtureArchive("base") };

  const { layers, maxAge } = await tilesetVectorLayers(def, base.layers, {}, waitUntilSpy());

  assert.equal(maxAge, 300);
  assert.deepEqual(layers.find((l) => l.id === "bathymetry").fields, { depth: "Number" });
  assert.deepEqual(layers.find((l) => l.id === "land").fields, {});
  assert.deepEqual(layers.map((l) => l.id), base.layers.map((l) => l.id));
});

test("an archive that cannot be opened answers today's layers, cached 30 s, with one warning", async () => {
  const { protomapsArchive } = await loadSrc("pmtiles");
  const { tilesetVectorLayers } = await loadSrc("vector_layers");
  const def = { id: "protomaps", minzoom: 0, maxzoom: 15, archive: protomapsArchive };
  const env = { MIRROR_PREFIX: "missing", R2: fakeR2({}) };

  const { layers, maxAge } = await tilesetVectorLayers(def, PROTOMAPS_REGISTRY, env, waitUntilSpy());

  assert.equal(maxAge, 30);
  assert.equal(JSON.stringify(layers), JSON.stringify(withoutFields(PROTOMAPS_REGISTRY, 15)));
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /^tilejson: protomaps archive layers unavailable \(.*latest\.json not found/);
});

test("an archive with no metadata, or metadata with no layers, answers no fields", async () => {
  const { protomapsArchive } = await loadSrc("pmtiles");
  const { tilesetVectorLayers } = await loadSrc("vector_layers");
  const def = { id: "protomaps", minzoom: 0, maxzoom: 15, archive: protomapsArchive };

  const unparsable = await tilesetVectorLayers(def, PROTOMAPS_REGISTRY, protomapsEnv(undefined), waitUntilSpy());
  assert.equal(unparsable.maxAge, 30);
  assert.deepEqual(unparsable.layers, withoutFields(PROTOMAPS_REGISTRY, 15));

  const { tilesetVectorLayers: fresh } = await loadSrc("vector_layers");
  const { protomapsArchive: freshArchive } = await loadSrc("pmtiles");
  const empty = await fresh(
    { ...def, archive: freshArchive }, PROTOMAPS_REGISTRY, protomapsEnv({ name: "no layers" }), waitUntilSpy(),
  );
  assert.equal(empty.maxAge, 300);
  assert.deepEqual(empty.layers, withoutFields(PROTOMAPS_REGISTRY, 15));
});

test("a tileset with no archive answers today's layers without opening anything", async () => {
  const { tilesetVectorLayers } = await loadSrc("vector_layers");
  const def = { id: "protomaps", minzoom: 0, maxzoom: 15 };

  const { layers, maxAge } = await tilesetVectorLayers(def, PROTOMAPS_REGISTRY, {}, waitUntilSpy());

  assert.equal(maxAge, 300);
  assert.equal(JSON.stringify(layers), JSON.stringify(withoutFields(PROTOMAPS_REGISTRY, 15)));
});

function countingHandle(answers) {
  const handle = {
    reads: 0,
    async getMetadata() {
      const answer = answers[Math.min(handle.reads, answers.length - 1)];
      handle.reads += 1;
      if (answer instanceof Error) throw answer;
      return answer;
    },
  };
  return handle;
}

test("a warm isolate reads an archive's metadata once", async () => {
  const { tilesetVectorLayers } = await loadSrc("vector_layers");
  const handle = countingHandle([PLANETILER_METADATA]);
  const def = { id: "protomaps", minzoom: 0, maxzoom: 15, archive: async () => handle };

  await tilesetVectorLayers(def, PROTOMAPS_REGISTRY, {}, waitUntilSpy());
  const second = await tilesetVectorLayers(def, PROTOMAPS_REGISTRY, {}, waitUntilSpy());

  assert.equal(handle.reads, 1);
  assert.deepEqual(second.layers[0].fields, { kind: "String" });
});

test("a failed metadata read is not kept: the next request reads again", async () => {
  const { tilesetVectorLayers } = await loadSrc("vector_layers");
  const handle = countingHandle([new Error("Bad response code: 503"), PLANETILER_METADATA]);
  const def = { id: "protomaps", minzoom: 0, maxzoom: 15, archive: async () => handle };

  const failed = await tilesetVectorLayers(def, PROTOMAPS_REGISTRY, {}, waitUntilSpy());
  const next = await tilesetVectorLayers(def, PROTOMAPS_REGISTRY, {}, waitUntilSpy());

  assert.equal(failed.maxAge, 30);
  assert.equal(next.maxAge, 300);
  assert.deepEqual(next.layers[0].fields, { kind: "String" });
  assert.equal(handle.reads, 2);
});

test("a read slower than the budget answers without fields, and still fills the memo", async () => {
  const { tilesetVectorLayers } = await loadSrc("vector_layers");
  const handle = countingHandle([PLANETILER_METADATA]);
  const slow = async () => {
    await new Promise((r) => setTimeout(r, 100));
    return handle;
  };
  const def = { id: "overture_base", minzoom: 0, maxzoom: 15, archive: slow };
  const waitUntil = waitUntilSpy();

  const started = performance.now();
  const timedOut = await tilesetVectorLayers(def, PROTOMAPS_REGISTRY, {}, waitUntil, 20);
  const waited = performance.now() - started;

  assert.equal(timedOut.maxAge, 30);
  assert.deepEqual(timedOut.layers, withoutFields(PROTOMAPS_REGISTRY, 15));
  assert.ok(waited < 90, `answered after ${waited.toFixed(0)} ms, not at the 20 ms budget`);
  assert.match(warnings[0], /^tilejson: overture_base archive layers unavailable \(no answer in 20 ms\)/);

  await waitUntil.settled();
  assert.equal(handle.reads, 1, "the read handed to waitUntil has finished");
  const warm = await tilesetVectorLayers({ ...def, archive: async () => handle }, PROTOMAPS_REGISTRY, {}, waitUntilSpy(), 20);
  assert.equal(warm.maxAge, 300);
  assert.equal(handle.reads, 1);
});

test("archive zooms are clamped into the tileset's, and an empty range keeps the registry's", async () => {
  const { mergeVectorLayers } = await loadSrc("vector_layers");
  const registry = ["wide", "narrow", "inverted", "partial", "absent"].map((id) => ({
    id, description: id, minzoom: 1, geometry: "polygon",
  }));
  const archive = [
    { id: "wide", fields: {}, minzoom: 0, maxzoom: 16 },
    { id: "narrow", fields: {}, minzoom: 5, maxzoom: 9 },
    { id: "inverted", fields: {}, minzoom: 14, maxzoom: 3 },
    { id: "partial", fields: {}, minzoom: 7 },
  ];

  const zooms = mergeVectorLayers(registry, archive, { minzoom: 2, maxzoom: 12 })
    .map((l) => `${l.id} ${l.minzoom}-${l.maxzoom}`);

  assert.deepEqual(zooms, ["wide 2-12", "narrow 5-9", "inverted 1-12", "partial 7-12", "absent 1-12"]);
});

test("metadata off the spec's shape parses without a throw, keeping what is well formed", async () => {
  const { parseArchiveLayers } = await loadSrc("vector_layers");

  for (const bad of [null, {}, "x", { vector_layers: {} }, { vector_layers: "roads" }]) {
    assert.deepEqual(parseArchiveLayers(bad), []);
  }
  assert.deepEqual(
    parseArchiveLayers({
      vector_layers: [
        null,
        { fields: { a: "String" } },
        { id: "", fields: {} },
        { id: "roads", fields: { kind: "String", rank: 3, nested: { t: "x" } }, minzoom: 2.5, maxzoom: "15" },
        { id: "water", fields: ["kind"], minzoom: 0, maxzoom: 15 },
      ],
    }),
    [
      { id: "roads", fields: { kind: "String" }, minzoom: undefined, maxzoom: undefined },
      { id: "water", fields: {}, minzoom: 0, maxzoom: 15 },
    ],
  );
});
