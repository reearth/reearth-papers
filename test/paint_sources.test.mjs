import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import { afterEach, beforeEach, test } from "node:test";

import { buildArchive } from "./fake-s3.mjs";
import { loadSrc } from "./load-src.mjs";

const { tilesetIdOfUrl, planVectorSources, PAINT_SOURCE_IDS } = await loadSrc("paint_sources");

const URL_OF = {
  protomaps: "https://papers.reearth.land/protomaps/tilejson.json",
  protomapsXyz: "https://papers.reearth.land/protomaps/{z}/{x}/{y}.mvt",
  overture: "https://papers.reearth.land/overture_base/tilejson.json",
  foreign: "https://tiles.example.com/v/{z}/{x}/{y}.mvt",
  typo: "https://papers.reearth.land/overture-base/tilejson.json",
};

const docOf = (sources, nodes = {}) => ({
  name: "t",
  version: "1",
  sources: Object.fromEntries(Object.entries(sources).map(([n, url]) => [n, { type: "mvt", url }])),
  nodes,
  output: "@out",
});

let warnings;
const realWarn = console.warn;
beforeEach(() => {
  warnings = [];
  console.warn = (line) => warnings.push(line);
});
afterEach(() => {
  console.warn = realWarn;
});

test("a source URL names a tileset only in the two forms Papers publishes", () => {
  const table = [
    [URL_OF.protomaps, "protomaps"],
    [URL_OF.protomapsXyz, "protomaps"],
    ["https://papers.reearth.land/naturalearth_bathymetry/tilejson.json", "naturalearth_bathymetry"],
    ["https://papers.reearth.land/protomaps/%7Bz%7D/%7Bx%7D/%7By%7D.mvt", null],
    ["http://papers.reearth.land/protomaps/tilejson.json", null],
    ["https://papers.reearth.land.example.com/protomaps/tilejson.json", null],
    ["https://evil.example/https://papers.reearth.land/protomaps/tilejson.json", null],
    ["https://papers.reearth.land/protomaps/tilejson.json?x=1", null],
    ["https://papers.reearth.land/../protomaps/tilejson.json", null],
    ["https://papers.reearth.land/protomaps.pmtiles", null],
    [URL_OF.typo, null],
    [42, null],
    [undefined, null],
  ];
  for (const [url, id] of table) assert.equal(tilesetIdOfUrl(url), id, String(url));
});

test("the allowlist names the Protomaps, Overture base and Natural Earth vector tilesets only", async () => {
  const { NE_VECTOR_TILESETS } = await loadSrc("naturalearth_vector");
  const { OVERTURE_TILESETS } = await loadSrc("overture");
  const known = new Set(["protomaps", ...NE_VECTOR_TILESETS.map((t) => t.id), ...OVERTURE_TILESETS.map((t) => t.id)]);
  for (const id of PAINT_SOURCE_IDS) assert.ok(known.has(id), `${id} is a registered vector tileset`);
  assert.deepEqual(
    [...PAINT_SOURCE_IDS].sort(),
    ["protomaps", "overture_base", ...NE_VECTOR_TILESETS.map((t) => t.id)].sort(),
  );
  assert.ok(!PAINT_SOURCE_IDS.has("overture_base_lite"));
});

test("every bundled recipe plans to its one Protomaps source and nothing else", async () => {
  const dir = new URL("../src/ezu_recipes/", import.meta.url);
  const names = (await readdir(dir)).filter((n) => n.endsWith(".json"));
  assert.equal(names.length, 7);
  for (const name of names) {
    const doc = JSON.parse(await readFile(new URL(name, dir), "utf8"));
    assert.deepEqual(planVectorSources(doc, PAINT_SOURCE_IDS), { primary: "v", extras: [], unresolved: [] }, name);
  }
});

test("the issue's document binds both sources in either order", () => {
  const nodes = {
    bg: { op: "solid", color: "#ff00ff" },
    d0_f: { op: "features", source: "overture", layer: "bathymetry", "filter-expr": [">=", ["get", "depth"], 0] },
    d0: { op: "fill-solid", features: "@d0_f", fill: "#88ccdd" },
    earth_f: { op: "features", source: "basemap", layer: "earth" },
    earth: { op: "fill-solid", features: "@earth_f", fill: "#ebe6da" },
    out: { op: "stack", layers: ["@bg", "@d0", "@earth"] },
  };
  const expected = {
    primary: "basemap",
    extras: [{ name: "overture", tileset: "overture_base", keep: ["bathymetry"], minzoom: 0 }],
    unresolved: [],
  };
  const a = docOf({ overture: URL_OF.overture, basemap: URL_OF.protomaps }, nodes);
  const b = docOf({ basemap: URL_OF.protomaps, overture: URL_OF.overture }, nodes);
  assert.deepEqual(planVectorSources(a, PAINT_SOURCE_IDS), expected);
  assert.deepEqual(planVectorSources(b, PAINT_SOURCE_IDS), expected);
});

test("a URL outside the allowlist is never bound from an archive", () => {
  const doc = docOf({
    lite: "https://papers.reearth.land/overture_base_lite/tilejson.json",
    buildings: "https://papers.reearth.land/overture_buildings/tilejson.json",
    foreign: URL_OF.foreign,
    basemap: URL_OF.protomaps,
  });
  const plan = planVectorSources(doc, PAINT_SOURCE_IDS);
  assert.equal(plan.primary, "basemap");
  assert.deepEqual(plan.extras, []);
  assert.deepEqual(plan.unresolved.map((u) => [u.name, u.bound]), [["lite", false], ["buildings", false], ["foreign", false]]);
});

test("the last source still gets Protomaps when its URL names no tileset, as today", () => {
  const plan = planVectorSources(docOf({ overture: URL_OF.overture, basemap: URL_OF.foreign }), PAINT_SOURCE_IDS);
  assert.equal(plan.primary, "basemap");
  assert.deepEqual(plan.unresolved, [{ name: "basemap", url: URL_OF.foreign, bound: true }]);
  assert.deepEqual(plan.extras.map((e) => e.name), ["overture"]);
});

test("with an integer-like source name, which source is last is not trusted", () => {
  // JSON.parse puts "10" before "a" whatever the file says; the ezu CLI keeps file order.
  const doc = JSON.parse(
    `{"sources":{"a":{"type":"mvt","url":"${URL_OF.overture}"},"10":{"type":"mvt","url":"${URL_OF.foreign}"}},"nodes":{}}`,
  );
  assert.deepEqual(Object.keys(doc.sources), ["10", "a"]);
  const plan = planVectorSources(doc, PAINT_SOURCE_IDS);
  assert.equal(plan.primary, null);
  assert.deepEqual(plan.unresolved, [{ name: "10", url: URL_OF.foreign, bound: false }]);
  assert.deepEqual(plan.extras.map((e) => e.name), ["a"]);

  const named = planVectorSources(docOf({ 7: URL_OF.protomaps, a: URL_OF.overture }), PAINT_SOURCE_IDS);
  assert.equal(named.primary, "7");
  assert.deepEqual(named.extras.map((e) => e.name), ["a"]);
});

test("extras are empty exactly when every source binds as it does today", () => {
  const kinds = Object.keys(URL_OF);
  let docs = 0;
  const visit = (prefix) => {
    if (prefix.length) {
      const sources = Object.fromEntries(prefix.map((k, i) => [`s${i}`, URL_OF[k]]));
      const plan = planVectorSources(docOf(sources), PAINT_SOURCE_IDS);
      const last = `s${prefix.length - 1}`;
      const today = plan.primary === last && plan.extras.length === 0;
      assert.equal(plan.extras.length === 0, today, prefix.join(","));
      docs += 1;
    }
    if (prefix.length < 3) for (const k of kinds) visit([...prefix, k]);
  };
  visit([]);
  assert.equal(docs, 155);
});

test("an extra source keeps the layers its nodes name, or all of them when used otherwise", () => {
  const plan = (nodes) =>
    planVectorSources(docOf({ ov: URL_OF.overture, basemap: URL_OF.protomaps }, nodes), PAINT_SOURCE_IDS).extras[0].keep;
  assert.deepEqual(plan({ a: { op: "features", source: "ov", layer: "water" }, b: { op: "features", source: "ov", layer: "land" } }), ["land", "water"]);
  assert.deepEqual(plan({ a: { op: "features", layer: "earth" } }), ["earth"]);
  assert.deepEqual(plan({ a: { op: "features", source: "basemap", layer: "earth" } }), []);
  assert.equal(plan({ a: { op: "raster-thing", source: "ov" } }), null);
  assert.equal(plan({ a: { op: "features", source: "ov", layer: ["get", "l"] } }), null);
});

test("an extra source's declared min-zoom is carried into its plan", () => {
  const doc = docOf({ ov: URL_OF.overture, basemap: URL_OF.protomaps });
  doc.sources.ov["min-zoom"] = 3;
  assert.equal(planVectorSources(doc, PAINT_SOURCE_IDS).extras[0].minzoom, 3);
});

/** An R2 stand-in for the paint shelf: documents by key. */
function shelf(objects) {
  return { R2: { get: async (key) => (key in objects ? { text: async () => JSON.stringify(objects[key]) } : null) } };
}

const memoryArchive = async (etag) => {
  const { openArchive } = await loadSrc("archive");
  const bytes = buildArchive([{ z: 0, x: 0, y: 0, data: "t" }], { maxZoom: 0 });
  return openArchive({ getKey: () => etag, getBytes: async (o, l) => ({ data: bytes.slice(o, o + l).buffer, etag }) });
};

test("only a style that binds extra sources gains their versions in its cache key", async () => {
  const { paintSourceVersion, paintEpochSource } = await loadSrc("paint_styles");
  const style = (name, sourceVersion) => ({ name, rev: "r1", sourceVersion });
  const archives = { overture_base: await memoryArchive('"o-77"'), naturalearth_bathymetry: await memoryArchive('"n1"') };
  const sources = { readable: PAINT_SOURCE_IDS, archive: async (id) => archives[id] };
  const env = shelf({
    "styles/plain/r1/style.json": docOf({ basemap: URL_OF.protomaps }),
    "styles/two/r1/style.json": docOf({ ov: URL_OF.overture, ne: "https://papers.reearth.land/naturalearth_bathymetry/tilejson.json", basemap: URL_OF.protomaps }),
    "styles/bare/r1/style.json": docOf({ ov: URL_OF.overture, basemap: URL_OF.protomaps }),
  });

  assert.equal(await paintSourceVersion(env, style("plain", "terrain:5"), sources), "terrain:5");
  assert.equal(await paintSourceVersion(env, style("plain", ""), sources), "");
  assert.equal(
    await paintSourceVersion(env, style("two", "terrain:5"), sources),
    "terrain:5+naturalearth_bathymetry@n1+overture_base@o-77",
  );
  assert.equal(await paintSourceVersion(env, style("bare", ""), sources), "-+overture_base@o-77");
  assert.equal(paintEpochSource("20261101", ""), "20261101/-");
  assert.equal(paintEpochSource("20261101", "-+overture_base@o-77"), "20261101/-+overture_base@o-77");
  assert.deepEqual(warnings, []);
});

test("a style document that cannot be read keys on the manifest's source version", async () => {
  const { paintSourceVersion } = await loadSrc("paint_styles");
  const sources = { readable: PAINT_SOURCE_IDS, archive: () => assert.fail("no archive read") };
  const version = await paintSourceVersion(shelf({}), { name: "gone", rev: "r1", sourceVersion: "terrain:5" }, sources);
  assert.equal(version, "terrain:5");
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /^paint: gone source version from the manifest: .*no document for gone\/r1/);
});
