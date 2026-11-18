import assert from "node:assert/strict";
import { test } from "node:test";

import { buildArchive, fakeR2 } from "./fake-s3.mjs";
import { loadSrc } from "./load-src.mjs";

const ARCHIVE_KEY = "mirror/protomaps/20261101.pmtiles";

function mirrorEnv() {
  return {
    MIRROR_PREFIX: "mirror/protomaps",
    R2: fakeR2({
      "mirror/protomaps/latest.json": {
        json: { date: "20261101", key: ARCHIVE_KEY, size: 1 },
      },
      [ARCHIVE_KEY]: {
        bytes: buildArchive([{ z: 0, x: 0, y: 0, data: "protomaps-0/0/0" }], { maxZoom: 1 }),
        etag: '"a1"',
      },
    }),
  };
}

test("a Protomaps tile answers 200 with its bytes, a zoom out of range 404", async () => {
  const { handleVectorTile } = await loadSrc("pmtiles");
  const env = mirrorEnv();

  const tile = await handleVectorTile({ z: 0, x: 0, y: 0 }, env);
  assert.equal(tile.status, 200);
  assert.equal(tile.headers.get("content-type"), "application/vnd.mapbox-vector-tile");
  assert.equal(await tile.text(), "protomaps-0/0/0");

  const deep = await handleVectorTile({ z: 2, x: 0, y: 0 }, env);
  assert.equal(deep.status, 404);
});

test("a Protomaps tile absent from the archive answers 204 with no body", async () => {
  const { handleVectorTile } = await loadSrc("pmtiles");

  const absent = await handleVectorTile({ z: 1, x: 1, y: 1 }, mirrorEnv());
  assert.equal(absent.status, 204);
  assert.equal(absent.body, null);
});
