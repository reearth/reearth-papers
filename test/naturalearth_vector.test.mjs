import assert from "node:assert/strict";
import { test } from "node:test";

import { buildArchive, fakeR2 } from "./fake-s3.mjs";
import { loadSrc } from "./load-src.mjs";

test("a Natural Earth archive rebuilt under its key is read afresh by a warm isolate", async () => {
  const { handleNeVectorTile, NE_VECTOR_TILESETS } = await loadSrc("naturalearth_vector");
  const key = NE_VECTOR_TILESETS.find((t) => t.id === "naturalearth_bathymetry").archiveKey;
  const objects = {
    [key]: {
      bytes: buildArchive([
        { z: 0, x: 0, y: 0, data: "old world" },
        { z: 1, x: 0, y: 0, data: "old quarter" },
      ]),
      etag: '"build-1"',
    },
  };
  const env = { R2: fakeR2(objects) };
  const tile = async (z, x, y) => (await handleNeVectorTile(key, { z, x, y }, env)).text();

  assert.equal(await tile(1, 0, 0), "old quarter");

  objects[key] = {
    bytes: buildArchive([
      { z: 0, x: 0, y: 0, data: "the rebuilt world tile" },
      { z: 1, x: 0, y: 0, data: "the rebuilt quarter" },
    ]),
    etag: '"build-2"',
  };

  assert.equal(await tile(1, 0, 0), "the rebuilt quarter");
  assert.equal(await tile(0, 0, 0), "the rebuilt world tile");
});
