import assert from "node:assert/strict";
import { afterEach, beforeEach, test } from "node:test";

import { buildArchive, fakeS3 } from "./fake-s3.mjs";
import { loadSrc } from "./load-src.mjs";

const NEWEST = "2026-11-18.0";
const PREVIOUS = "2026-10-21.0";

const archiveV1 = buildArchive([{ z: 0, x: 0, y: 0, data: "base-v1" }], { maxZoom: 1 });
const archiveV2 = buildArchive([{ z: 0, x: 0, y: 0, data: "base-v2, rebuilt" }], { maxZoom: 1 });

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

/** A new isolate: fresh module state, nothing cached. */
async function isolate() {
  const { handleOvertureTile } = await loadSrc("overture");
  return (z, x, y) => handleOvertureTile("base", { z, x, y });
}

function assertRetryable(res) {
  assert.equal(res.status, 503);
  assert.equal(res.headers.get("retry-after"), "1");
  assert.equal(res.headers.get("cache-control"), "no-store");
}

test("a tile answers 200 with its headers, an absent tile 204, a zoom out of range 404", async () => {
  s3.put(`tiles/${NEWEST}/base.pmtiles`, archiveV1, '"v1"');
  s3.put(`tiles/${PREVIOUS}/base.pmtiles`, archiveV1, '"old"');
  const tile = await isolate();

  const hit = await tile(0, 0, 0);
  assert.equal(hit.status, 200);
  assert.equal(await hit.text(), "base-v1");
  assert.equal(hit.headers.get("content-type"), "application/vnd.mapbox-vector-tile");
  assert.equal(hit.headers.get("cache-control"), "public, max-age=3600, stale-while-revalidate=86400");
  assert.equal(hit.headers.get("x-overture-release"), NEWEST);
  assert.match(hit.headers.get("x-attribution"), /Overture/);

  const absent = await tile(1, 1, 1);
  assert.equal(absent.status, 204);
  assert.equal(absent.body, null);

  assert.equal((await tile(2, 0, 0)).status, 404);
  assert.deepEqual(errors, []);
});

test("an archive replaced in place is read again, not failed for the life of the isolate", async () => {
  s3.put(`tiles/${NEWEST}/base.pmtiles`, archiveV1, '"v1"');
  const tile = await isolate();
  assert.equal(await (await tile(0, 0, 0)).text(), "base-v1");

  s3.put(`tiles/${NEWEST}/base.pmtiles`, archiveV2, '"v2"');
  for (let i = 0; i < 3; i++) {
    const res = await tile(0, 0, 0);
    assert.equal(res.status, 200);
    assert.equal(await res.text(), "base-v2, rebuilt");
  }
  assert.deepEqual(errors, []);
});

test("one failed header read answers a logged 503, and the next request 200", async () => {
  s3.put(`tiles/${NEWEST}/base.pmtiles`, archiveV1, '"v1"');
  const tile = await isolate();

  s3.failReads(1);
  assertRetryable(await tile(5, 28, 12));
  assert.deepEqual(errors, [
    {
      evt: "overture.read_failed",
      stage: "header",
      theme: "base",
      release: NEWEST,
      z: 5,
      x: 28,
      y: 12,
      error: "Error: Bad response code: 503",
    },
  ]);

  const res = await tile(0, 0, 0);
  assert.equal(res.status, 200);
  assert.equal(await res.text(), "base-v1");
});

test("an S3 outage answers 503 for its length, and 200 once S3 recovers", async () => {
  s3.put(`tiles/${NEWEST}/base.pmtiles`, archiveV1, '"v1"');
  const tile = await isolate();

  s3.failReads();
  assertRetryable(await tile(0, 0, 0));
  assertRetryable(await tile(0, 0, 0));
  s3.recover();
  assert.equal((await tile(0, 0, 0)).status, 200);
  assert.equal(errors.length, 2);
});

test("a failed tile read after the header is logged at the tile stage", async () => {
  s3.put(`tiles/${NEWEST}/base.pmtiles`, archiveV1, '"v1"');
  const tile = await isolate();
  assert.equal((await tile(0, 0, 0)).status, 200);

  s3.failReads(1);
  assertRetryable(await tile(0, 0, 0));
  assert.equal(errors.length, 1);
  assert.equal(errors[0].stage, "tile");
  assert.equal(errors[0].release, NEWEST);
  assert.equal((await tile(0, 0, 0)).status, 200);
});

test("a newest release without the theme answers 503 until the archive appears", async () => {
  s3.put(`tiles/${NEWEST}/buildings.pmtiles`, archiveV1, '"b"');
  s3.put(`tiles/${PREVIOUS}/base.pmtiles`, archiveV1, '"old"');
  const tile = await isolate();

  assertRetryable(await tile(0, 0, 0));
  assert.equal(errors[0].stage, "header");
  assert.equal(errors[0].release, NEWEST);
  assert.equal(errors[0].error, "Error: Bad response code: 404");

  s3.put(`tiles/${NEWEST}/base.pmtiles`, archiveV2, '"v2"');
  const res = await tile(0, 0, 0);
  assert.equal(res.status, 200);
  assert.equal(res.headers.get("x-overture-release"), NEWEST);
  assert.equal(await res.text(), "base-v2, rebuilt");
});

test("a bucket listing that rejects on a cold isolate falls back to the pinned release", async () => {
  const { OVERTURE_RELEASE } = await loadSrc("overture");
  s3.put(`tiles/${OVERTURE_RELEASE}/base.pmtiles`, archiveV1, '"pinned"');
  s3.rejectListing();
  const tile = await isolate();

  const res = await tile(0, 0, 0);
  assert.equal(res.status, 200);
  assert.equal(res.headers.get("x-overture-release"), OVERTURE_RELEASE);
  assert.deepEqual(errors, []);
});
