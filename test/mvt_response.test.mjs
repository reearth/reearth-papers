import assert from "node:assert/strict";
import { afterEach, test } from "node:test";

import { buildArchive, fakeR2, fakeS3 } from "./fake-s3.mjs";
import { loadSrc } from "./load-src.mjs";

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

const ZXY = { z: 0, x: 0, y: 0 };
const archive = (data) => buildArchive([{ ...ZXY, data }], { maxZoom: 1 });

const handlers = {
  async protomaps() {
    const { handleVectorTile } = await loadSrc("pmtiles");
    const key = "mirror/protomaps/20261101.pmtiles";
    const R2 = fakeR2({
      "mirror/protomaps/latest.json": { json: { date: "20261101", key, size: 1 } },
      [key]: { bytes: archive("protomaps-tile"), etag: '"p"' },
    });
    return [await handleVectorTile(ZXY, { MIRROR_PREFIX: "mirror/protomaps", R2 }), "protomaps-tile"];
  },
  async naturalearth() {
    const { handleNeVectorTile } = await loadSrc("naturalearth_vector");
    const key = "naturalearth/physical.pmtiles";
    const R2 = fakeR2({ [key]: { bytes: archive("ne-tile"), etag: '"n"' } });
    return [await handleNeVectorTile(key, ZXY, { R2 }), "ne-tile"];
  },
  async overture() {
    const { handleOvertureTile, OVERTURE_RELEASE } = await loadSrc("overture");
    const s3 = fakeS3();
    s3.put(`tiles/${OVERTURE_RELEASE}/base.pmtiles`, archive("overture-tile"), '"o"');
    globalThis.fetch = s3.fetch;
    return [await handleOvertureTile("base", ZXY), "overture-tile"];
  },
};

for (const [name, serve] of Object.entries(handlers)) {
  test(`the ${name} route labels its tile for the edge to compress and does not encode it`, async () => {
    const [res, body] = await serve();
    assert.equal(res.status, 200);
    assert.equal(res.headers.get("content-type"), "application/x-protobuf");
    assert.equal(res.headers.get("vary"), "accept-encoding");
    assert.equal(res.headers.get("content-encoding"), null);
    assert.equal(await res.text(), body);
  });
}
