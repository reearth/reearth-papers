import assert from "node:assert/strict";
import { afterEach, beforeEach, test } from "node:test";

import { buildArchive } from "./fake-s3.mjs";
import { loadSrc } from "./load-src.mjs";

const { openArchive } = await loadSrc("archive");
const { PAINT_SOURCE_IDS } = await loadSrc("paint_sources");

const DATE = "20261101";
const AT = { z: 3, x: 2, y: 3 };
const OVERTURE = "https://papers.reearth.land/overture_base/tilejson.json";
const PROTOMAPS = "https://papers.reearth.land/protomaps/tilejson.json";

/** paint_styles.ts keeps documents per isolate by name and rev, and every
 *  test here shares its instance, so each style gets a rev of its own. */
let revs = 0;
function styleOf(name) {
  revs += 1;
  return {
    name,
    rev: `rev${revs}`,
    title: name,
    description: "",
    attribution: "a",
    tileSize: 512,
    maxzoom: 14,
    params: null,
    sourceVersion: "terrain:5",
  };
}

function docOf({ extras }) {
  return {
    name: "d",
    version: "1",
    sources: {
      ...(extras ? { overture: { type: "mvt", url: OVERTURE } } : {}),
      basemap: { type: "mvt", url: PROTOMAPS },
    },
    nodes: {
      ...(extras ? { o: { op: "features", source: "overture", layer: "bathymetry" } } : {}),
      out: { op: "solid", color: "#ffffff" },
    },
    output: "@out",
  };
}

/** An R2 binding holding one style document, whose reads fail while
 *  `failing` is set. */
function envWith(style, doc) {
  const r2 = {
    failing: false,
    async get(key) {
      if (r2.failing) throw new Error("R2 get failed");
      if (key !== `styles/${style.name}/${style.rev}/style.json`) return null;
      return { text: async () => JSON.stringify(doc) };
    },
  };
  return { R2: r2 };
}

/** The Overture archive, as `paintSources` hands it out: under the etag
 *  `etag` names, and failing to open while `failing` is set. */
function overtureSources(data = new Uint8Array([0x1a, 0x00])) {
  const bytes = buildArchive([{ ...AT, data }], { maxZoom: 13, gzip: true });
  const sources = {
    etag: '"o1"',
    failing: false,
    tileReads: 0,
    readable: PAINT_SOURCE_IDS,
    archive: async () => {
      if (sources.failing) throw new Error("Bad response code: 503");
      const etag = sources.etag;
      return openArchive({
        getKey: () => `overture-${etag}`,
        async getBytes(offset, length) {
          if (offset > 0) sources.tileReads += 1;
          return { data: bytes.slice(offset, offset + length).buffer, etag };
        },
      });
    },
  };
  return sources;
}

/** `serveRenderedTile` without its caches: every request renders, and a
 *  rendered tile is recorded as stored when the route would persist it. */
function fakeServe() {
  const seen = { options: [], stored: [] };
  const serve = async (o) => {
    seen.options.push(o);
    const bytes = await o.render();
    if (!bytes) return new Response("no data", { status: 404 });
    if (o.persist) seen.stored.push(o.cacheKey);
    return new Response(bytes, { headers: { "content-type": o.contentType } });
  };
  return { seen, serve };
}

const DEFAULT = { values: {}, canonical: "" };
const PNG = new Uint8Array([1, 2, 3]);

async function serveOne({ style, env, sources, render = async () => PNG }) {
  const route = await loadSrc("paint_route");
  const { seen, serve } = fakeServe();
  const res = await route.servePaintTile(
    { style, coords: AT, format: "png", params: DEFAULT, date: DATE },
    { env, sources, serve, render },
  );
  return { res, seen };
}

let errors;
const realError = console.error;
const realWarn = console.warn;
beforeEach(() => {
  errors = [];
  console.error = (line) => errors.push(JSON.parse(line));
  console.warn = () => {};
});
afterEach(() => {
  console.error = realError;
  console.warn = realWarn;
});

test("a style binding nothing extra keys its tiles and okibi epoch on the manifest's sourceVersion", async () => {
  const style = styleOf("plain");
  const { res, seen } = await serveOne({ style, env: envWith(style, docOf({ extras: false })), sources: overtureSources() });

  assert.equal(res.status, 200);
  const [o] = seen.options;
  assert.equal(o.cacheKey, `cache/paint/plain/${style.rev}/r3/${DATE}/terrain:5/default/3/2/3.png`);
  assert.equal(o.cacheVersion, `${style.rev}-r3-${DATE}-terrain:5`);
  assert.deepEqual(o.demand.epoch, { source: `${DATE}/terrain:5`, algo: "paint-r3", param: style.rev });
  assert.deepEqual(seen.stored, [o.cacheKey]);
});

test("a style binding Overture adds the archive's etag to its key and okibi epoch", async () => {
  const style = styleOf("extra");
  const { res, seen } = await serveOne({ style, env: envWith(style, docOf({ extras: true })), sources: overtureSources() });

  assert.equal(res.status, 200);
  const [o] = seen.options;
  const version = "terrain:5+overture_base@o1";
  assert.equal(o.cacheKey, `cache/paint/extra/${style.rev}/r3/${DATE}/${version}/default/3/2/3.png`);
  assert.equal(o.cacheVersion, `${style.rev}-r3-${DATE}-${version}`);
  assert.deepEqual(o.demand.epoch, { source: `${DATE}/${version}`, algo: "paint-r3", param: style.rev });
  assert.deepEqual(seen.stored, [o.cacheKey]);
});

test("an archive that cannot be opened before the cache lookup answers a logged 503", async () => {
  const style = styleOf("down");
  const sources = overtureSources();
  sources.failing = true;
  const { res, seen } = await serveOne({ style, env: envWith(style, docOf({ extras: true })), sources });

  assert.equal(res.status, 503);
  assert.equal(res.headers.get("cache-control"), "no-store");
  assert.equal(seen.options.length, 0, "the cache is not asked");
  assert.deepEqual(errors.map((e) => [e.evt, e.stage, e.style]), [["paint.source_unavailable", "read", "down"]]);
});

test("an archive that moves during the render answers a logged 503 and stores nothing", async () => {
  const style = styleOf("moved");
  const sources = overtureSources();
  const { res, seen } = await serveOne({
    style,
    env: envWith(style, docOf({ extras: true })),
    sources,
    render: async () => {
      sources.etag = '"o2"';
      return PNG;
    },
  });

  assert.equal(res.status, 503);
  assert.deepEqual(seen.stored, []);
  assert.deepEqual(errors.map((e) => e.stage), ["version"]);
});

test("an archive that cannot be opened after the render answers a logged 503 and stores nothing", async () => {
  const style = styleOf("lost");
  const sources = overtureSources();
  const { res, seen } = await serveOne({
    style,
    env: envWith(style, docOf({ extras: true })),
    sources,
    render: async () => {
      sources.failing = true;
      return PNG;
    },
  });

  assert.equal(res.status, 503);
  assert.deepEqual(seen.stored, []);
  assert.deepEqual(errors.map((e) => e.stage), ["version"]);
  assert.match(errors[0].error, /Bad response code: 503/);
});
