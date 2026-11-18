import assert from "node:assert/strict";
import { mock, test } from "node:test";

import { Renderer } from "@reearth/ezu";

import { buildArchive, fakeR2 } from "./fake-s3.mjs";
import { loadSrc } from "./load-src.mjs";

const { openArchive } = await loadSrc("archive");
const { PAINT_SOURCE_IDS } = await loadSrc("paint_sources");

/** ezu.ts holds its own instance of paint_sources.ts, so match by name. */
const isPaintSourceError = (e, stage) => e?.name === "PaintSourceError" && e.stage === stage;

const varint = (n) => {
  const out = [];
  while (n >= 0x80) {
    out.push((n & 0x7f) | 0x80);
    n = Math.floor(n / 0x80);
  }
  out.push(n);
  return out;
};
const field = (num, wire, payload) => [
  ...varint((num << 3) | wire),
  ...(wire === 2 ? varint(payload.length) : []),
  ...payload,
];
const zigzag = (n) => (n << 1) ^ (n >> 31);

/** An MVT layer holding one square polygon from (0,0) to (`size`,`size`)
 *  in tile units of 4096, and `padding` bytes of an unread string value. */
function squareLayer(name, size, padding = 0) {
  const geometry = [9, 0, 0, 26, zigzag(size), 0, 0, zigzag(size), zigzag(-size), 0, 15].flatMap(varint);
  const feature = field(2, 2, [...field(3, 0, [3]), ...field(4, 2, geometry)]);
  const pad = padding ? field(4, 2, field(1, 2, new Array(padding).fill(0x61))) : [];
  return field(3, 2, [
    ...field(15, 0, [2]),
    ...field(1, 2, [...new TextEncoder().encode(name)]),
    ...feature,
    ...pad,
    ...field(5, 0, varint(4096)),
  ]);
}
const tile = (...layers) => Uint8Array.from(layers.flat());

const OVERTURE = "https://papers.reearth.land/overture_base/tilejson.json";
const PROTOMAPS = "https://papers.reearth.land/protomaps/tilejson.json";

function issueDoc({ minzoom } = {}) {
  return {
    name: "two-sources",
    version: "1",
    sources: {
      overture: { type: "mvt", url: OVERTURE, ...(minzoom === undefined ? {} : { "min-zoom": minzoom }) },
      basemap: { type: "mvt", url: PROTOMAPS },
    },
    nodes: {
      bg: { op: "solid", color: "#ff00ff" },
      d0_f: { op: "features", source: "overture", layer: "bathymetry" },
      d0: { op: "fill-solid", features: "@d0_f", fill: "#88ccdd" },
      earth_f: { op: "features", source: "basemap", layer: "earth" },
      earth: { op: "fill-solid", features: "@earth_f", fill: "#ebe6da" },
      out: { op: "stack", layers: ["@bg", "@d0", "@earth"] },
    },
    output: "@out",
  };
}

const AT = { z: 3, x: 2, y: 3 };
const PM_TILE = tile(squareLayer("earth", 1024));
const OV_TILE = tile(squareLayer("water", 4096, 20_000), squareLayer("bathymetry", 3072), squareLayer("land", 2048));

function protomapsEnv() {
  const key = "mirror/protomaps/20261101.pmtiles";
  return {
    MIRROR_PREFIX: "mirror/protomaps",
    R2: fakeR2({
      "mirror/protomaps/latest.json": { json: { date: "20261101", key, size: 1 } },
      [key]: { bytes: buildArchive([{ ...AT, data: PM_TILE }], { maxZoom: 15 }), etag: '"p1"' },
    }),
  };
}

/** A gzipped Overture-like archive in memory, counting tile-sized reads. */
function overtureSources(data = OV_TILE, { hang } = {}) {
  const bytes = buildArchive([{ ...AT, data }], { maxZoom: 13, gzip: true });
  const counter = { reads: 0 };
  const archive = openArchive({
    getKey: () => "overture",
    async getBytes(offset, length) {
      if (offset > 0) {
        counter.reads += 1;
        if (hang) await hang;
      }
      return { data: bytes.slice(offset, offset + length).buffer, etag: '"o1"' };
    },
  });
  return { counter, sources: { readable: PAINT_SOURCE_IDS, archive: async () => archive } };
}

const ctx = { waitUntil() {} };
const request = new Request("https://papers.reearth.land/styles/two/3/2/3.png");

async function render(ezu, doc, sources, key) {
  return Buffer.from(
    await ezu.renderEzuStyleTile(request, protomapsEnv(), ctx, { key, doc, sources }, AT, { format: "png" }),
  );
}

/** The same document rendered with whole tiles bound by hand, the way the
 *  ezu CLI binds every source. */
function renderDirect(doc, binds) {
  const r = new Renderer(JSON.stringify(doc));
  for (const [name, bytes] of binds) r.bindSource(name, bytes, { sourceZoom: AT.z });
  const png = Buffer.from(r.renderTile(AT.z, AT.x, AT.y, { format: "png" }));
  r.free();
  return png;
}

test("an extra source renders the same sliced as bound whole, and differs from unbound", async () => {
  const ezu = await loadSrc("ezu");
  const doc = issueDoc();
  const { counter, sources } = overtureSources();

  const served = await render(ezu, doc, sources, "two");

  assert.equal(counter.reads, 1, "one stored tile read");
  assert.ok(served.equals(renderDirect(doc, [["basemap", PM_TILE], ["overture", OV_TILE]])), "sliced equals whole");
  assert.ok(!served.equals(renderDirect(doc, [["basemap", PM_TILE]])), "differs from the unbound picture");
});

test("below a source's min-zoom nothing is read and the picture is the unbound one", async () => {
  const ezu = await loadSrc("ezu");
  const doc = issueDoc({ minzoom: 4 });
  const { counter, sources } = overtureSources();

  const served = await render(ezu, doc, sources, "gated");

  assert.equal(counter.reads, 0);
  assert.ok(served.equals(renderDirect(doc, [["basemap", PM_TILE]])));
});

test("kept layers over the limit fail the render with a slice error", async () => {
  const ezu = await loadSrc("ezu");
  const big = tile(squareLayer("bathymetry", 3072, 600 * 1024));
  const { sources } = overtureSources(big);

  await assert.rejects(render(ezu, issueDoc(), sources, "big"), (e) => isPaintSourceError(e, "slice"));
});

test("an archive that cannot be read fails the render with a read error", async () => {
  const ezu = await loadSrc("ezu");
  const sources = { readable: PAINT_SOURCE_IDS, archive: async () => Promise.reject(new Error("Bad response code: 503")) };

  await assert.rejects(render(ezu, issueDoc(), sources, "down"), (e) => isPaintSourceError(e, "read"));
});

test("a render that waits 20 s for the extra-source read slot gives up", async () => {
  const ezu = await loadSrc("ezu");
  let release;
  const hang = new Promise((r) => (release = r));
  const held = overtureSources(OV_TILE, { hang });
  const first = render(ezu, issueDoc(), held.sources, "first");
  while (held.counter.reads === 0) await new Promise((r) => setImmediate(r));

  mock.timers.enable({ apis: ["setTimeout", "Date"] });
  try {
    const second = render(ezu, issueDoc(), overtureSources().sources, "second");
    let outcome = null;
    second.then(
      () => (outcome = "rendered"),
      (e) => (outcome = e),
    );
    for (let i = 0; i < 2100 && outcome === null; i++) {
      mock.timers.tick(10);
      await new Promise((r) => setImmediate(r));
    }
    assert.ok(isPaintSourceError(outcome, "admission"), `second render: ${outcome}`);
  } finally {
    mock.timers.reset();
    release();
  }
  await first;
});

test("a source whose URL names no readable tileset is left unbound with one warning", async () => {
  const ezu = await loadSrc("ezu");
  const doc = issueDoc();
  doc.sources.overture.url = "https://papers.reearth.land/overture_base_lite/tilejson.json";
  const { counter, sources } = overtureSources();
  const warnings = [];
  const realWarn = console.warn;
  console.warn = (line) => warnings.push(line);
  try {
    const served = await render(ezu, doc, sources, "lite");
    await render(ezu, doc, sources, "lite");
    assert.ok(served.equals(renderDirect(doc, [["basemap", PM_TILE]])));
  } finally {
    console.warn = realWarn;
  }
  assert.equal(counter.reads, 0);
  assert.deepEqual(warnings, [
    "ezu: lite source overture (https://papers.reearth.land/overture_base_lite/tilejson.json) " +
      "names no Papers vector tileset a style may read; left unbound",
  ]);
});

test("a tile over the slice limit answers 503 again without being read again", async () => {
  const ezu = await loadSrc("ezu");
  const route = await loadSrc("paint_route");
  const doc = issueDoc();
  const big = tile(squareLayer("bathymetry", 3072, 600 * 1024));
  const { counter, sources } = overtureSources(big);
  const style = { name: "over-limit", rev: "r1", attribution: "a", sourceVersion: "" };
  const env = { R2: { get: async () => ({ text: async () => JSON.stringify(doc) }) } };
  const errors = [];
  const realError = console.error;
  console.error = (line) => errors.push(JSON.parse(line));
  const serveTile = () =>
    route.servePaintTile(
      { style, coords: AT, format: "png", params: { values: {}, canonical: "" }, date: "20261101" },
      {
        env,
        sources,
        serve: async (o) => new Response(await o.render()),
        render: (d) => ezu.renderEzuStyleTile(request, protomapsEnv(), ctx, { key: "over-limit", doc: d, sources }, AT, { format: "png" }),
      },
    );
  try {
    const first = await serveTile();
    const readsAfterFirst = counter.reads;
    const second = await serveTile();

    assert.deepEqual([first.status, second.status], [503, 503]);
    assert.equal(readsAfterFirst, 1);
    assert.equal(counter.reads, 1, "the repeat reads nothing");
  } finally {
    console.error = realError;
  }
  assert.deepEqual(errors.map((e) => e.stage), ["slice", "slice"]);
});
