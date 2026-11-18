import assert from "node:assert/strict";
import { afterEach, beforeEach, test } from "node:test";

import { VectorTile } from "@mapbox/vector-tile";
import Pbf from "pbf";

import { buildArchive, fakeS3 } from "./fake-s3.mjs";
import { loadSrc } from "./load-src.mjs";
import { encodeTile, line } from "./mvt-fixture.mjs";

const NEWEST = "2026-11-18.0";
const ORIGIN = "https://papers.example";
const ZXY = { z: 0, x: 0, y: 0 };

const TILE = encodeTile([
  {
    name: "water",
    keys: ["id", "class", "sources"],
    values: ["08b2f", "lake", '[{"dataset":"OpenStreetMap"}]'],
    features: [{ id: 1, type: 3, geometry: line(2, 2), tags: [0, 0, 1, 1, 2, 2] }],
  },
]);

/** A stand-in for `caches.default`. Like the Cache API it keys on the
 *  request URL and ignores the key's headers; it keeps what was put so
 *  a test can read the stored response back. */
function fakeCache() {
  const stored = new Map();
  return {
    stored,
    matches: 0,
    async match(request) {
      this.matches += 1;
      const entry = stored.get(new Request(request).url);
      return entry && new Response(entry.body, { headers: entry.headers });
    },
    async put(request, response) {
      const body = new Uint8Array(await response.arrayBuffer());
      stored.set(new Request(request).url, { body, headers: new Headers(response.headers) });
    },
  };
}

let s3;
let cache;
let errors;
let pending;
const realFetch = globalThis.fetch;
const realCaches = globalThis.caches;
const realError = console.error;

beforeEach(() => {
  s3 = fakeS3();
  globalThis.fetch = s3.fetch;
  cache = fakeCache();
  globalThis.caches = { default: cache };
  errors = [];
  console.error = (line) => errors.push(JSON.parse(line));
  pending = [];
});

afterEach(() => {
  globalThis.fetch = realFetch;
  globalThis.caches = realCaches;
  console.error = realError;
});

const ctx = { waitUntil: (p) => pending.push(p) };

/** A new isolate, answering lite requests the way the route does. */
async function isolate() {
  const { handleOvertureLiteTile, handleOvertureTile } = await loadSrc("overture");
  return {
    lite: async (c = ZXY, headers = {}) => {
      const req = new Request(`${ORIGIN}/overture_base_lite/${c.z}/${c.x}/${c.y}.mvt`, { headers });
      const res = await handleOvertureLiteTile(req, ctx, "base", c);
      await Promise.all(pending);
      return res;
    },
    base: (c = ZXY) => handleOvertureTile("base", c),
  };
}

const properties = (bytes) => {
  const water = new VectorTile(new Pbf(bytes)).layers.water;
  return { ...water.feature(0).properties };
};

const ETAG = `W/"lite1-${NEWEST}"`;

test("a lite miss answers the filtered tile and stores it under the release it read", async () => {
  s3.put(`tiles/${NEWEST}/base.pmtiles`, buildArchive([{ ...ZXY, data: TILE }]), '"v1"');
  const { lite } = await isolate();

  const res = await lite();
  assert.equal(res.status, 200);
  assert.equal(res.headers.get("x-cache"), "miss");
  assert.equal(res.headers.get("etag"), ETAG);
  assert.equal(res.headers.get("content-type"), "application/x-protobuf");
  assert.equal(res.headers.get("vary"), "accept-encoding");
  assert.equal(res.headers.get("cache-control"), "public, max-age=3600, stale-while-revalidate=86400");
  assert.equal(res.headers.get("x-overture-release"), NEWEST);
  assert.deepEqual(properties(new Uint8Array(await res.arrayBuffer())), { class: "lake" });

  assert.deepEqual([...cache.stored.keys()], [`${ORIGIN}/__lite/1/${NEWEST}/base/0/0/0.mvt`]);
  const [entry] = cache.stored.values();
  assert.equal(entry.headers.get("cache-control"), "public, max-age=2592000");
  assert.equal(entry.headers.get("vary"), null, "stored without Vary");
  assert.equal(entry.headers.get("etag"), ETAG);
});

test("a repeat lite request is served from the cache with the client's TTL and no S3 read", async () => {
  s3.put(`tiles/${NEWEST}/base.pmtiles`, buildArchive([{ ...ZXY, data: TILE }]), '"v1"');
  const { lite } = await isolate();
  const first = new Uint8Array(await (await lite()).arrayBuffer());
  const reads = s3.rangeReads;

  const res = await lite(ZXY, { "accept-encoding": "br, gzip" });
  assert.equal(res.status, 200);
  assert.equal(res.headers.get("x-cache"), "edge-hit");
  assert.equal(res.headers.get("cache-control"), "public, max-age=3600, stale-while-revalidate=86400");
  assert.equal(res.headers.get("vary"), "accept-encoding");
  assert.equal(res.headers.get("etag"), ETAG);
  assert.deepEqual(new Uint8Array(await res.arrayBuffer()), first);
  assert.equal(s3.rangeReads, reads);
});

test("a lite request with the current ETag answers 304 without reading the tile", async () => {
  s3.put(`tiles/${NEWEST}/base.pmtiles`, buildArchive([{ ...ZXY, data: TILE }]), '"v1"');
  const { lite } = await isolate();
  await lite();
  const reads = s3.rangeReads;
  const matches = cache.matches;

  for (const tag of [ETAG, ETAG.slice(2), `"other", ${ETAG}`]) {
    const res = await lite(ZXY, { "if-none-match": tag });
    assert.equal(res.status, 304, tag);
    assert.equal(res.headers.get("etag"), ETAG);
  }
  assert.equal((await lite(ZXY, { "if-none-match": 'W/"lite1-2026-10-21.0"' })).status, 200);
  assert.equal(s3.rangeReads, reads);
  assert.equal(cache.matches, matches + 1);
});

test("a failed lite read answers the logged 503 and stores nothing", async () => {
  s3.put(`tiles/${NEWEST}/base.pmtiles`, buildArchive([{ ...ZXY, data: TILE }]), '"v1"');
  const { lite } = await isolate();

  s3.failReads(1);
  const res = await lite();
  assert.equal(res.status, 503);
  assert.equal(res.headers.get("retry-after"), "1");
  assert.equal(res.headers.get("cache-control"), "no-store");
  assert.equal(errors[0].evt, "overture.read_failed");
  assert.equal(cache.stored.size, 0);
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
  assert.equal(cache.stored.size, 0);
});

test("lite answers 204 for an absent tile and 404 out of range, as base does", async () => {
  s3.put(`tiles/${NEWEST}/base.pmtiles`, buildArchive([{ ...ZXY, data: TILE }], { maxZoom: 1 }), '"v1"');
  const { lite, base } = await isolate();

  for (const [c, status] of [[{ z: 1, x: 1, y: 1 }, 204], [{ z: 2, x: 0, y: 0 }, 404]]) {
    assert.equal((await lite(c)).status, status);
    assert.equal((await base(c)).status, status);
  }
  assert.equal(cache.stored.size, 0);
});

test("overture_base still answers the archive's bytes with today's headers, and no cache", async () => {
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
  assert.equal(cache.matches, 0);
  assert.equal(cache.stored.size, 0);
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
  const { overtureArchive, overtureLiteFields, OVERTURE_TILESETS } = await loadSrc("overture");
  const { tilesetVectorLayers } = await loadSrc("vector_layers");
  const d = OVERTURE_TILESETS.find((t) => t.lite);
  const def = { id: d.id, minzoom: d.minzoom, maxzoom: d.maxzoom, archive: () => overtureArchive(d.theme) };
  const water = async (spec) =>
    (await tilesetVectorLayers(spec, d.layers, {}, () => {})).layers.find((l) => l.id === "water").fields;

  assert.deepEqual(await water({ ...def, ...overtureLiteFields(d) }), { class: "String" });
  assert.deepEqual(Object.keys(await water(def)), ["id", "class", "sources", "source_tags"]);
});

test("the lite registry entry serves the filtered tile", async () => {
  s3.put(`tiles/${NEWEST}/base.pmtiles`, buildArchive([{ ...ZXY, data: TILE }]), '"v1"');
  const { overtureLiteFields, OVERTURE_TILESETS } = await loadSrc("overture");
  const spec = overtureLiteFields(OVERTURE_TILESETS.find((t) => t.lite));
  assert.equal(spec.id, "overture_base_lite");

  const res = await spec.handleTile(new Request(`${ORIGIN}/${spec.id}/0/0/0.mvt`), {}, ctx, ZXY, "mvt");
  await Promise.all(pending);
  assert.equal(res.status, 200);
  assert.deepEqual(properties(new Uint8Array(await res.arrayBuffer())), { class: "lake" });
});
