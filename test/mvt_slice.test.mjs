import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import { gzipSync } from "node:zlib";

import { buildArchive } from "./fake-s3.mjs";
import { loadSrc } from "./load-src.mjs";

const { sliceLayers, MvtSliceError } = await loadSrc("mvt_slice");
const { archiveTileStream, archiveVersion, openArchive, STORED_TILE_MAX_BYTES } =
  await loadSrc("archive");

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
const text = (s) => [...new TextEncoder().encode(s)];

/** One MVT layer message, with `version` written before `name` when asked,
 *  the way tippecanoe writes it. */
function layer(name, { versionFirst = false, kind = "water" } = {}) {
  const version = field(15, 0, varint(2));
  const named = field(1, 2, text(name));
  const feature = field(2, 2, [...field(3, 0, varint(3)), ...field(4, 2, [9, 50, 34, 18, 0, 0])]);
  const body = [
    ...(versionFirst ? [...version, ...named] : [...named, ...version]),
    ...feature,
    ...field(3, 2, text("kind")),
    ...field(4, 2, field(1, 2, text(kind))),
    ...field(5, 0, varint(4096)),
  ];
  return field(3, 2, body);
}

const tile = (...layers) => Uint8Array.from(layers.flat());

function chunked(bytes, size, onCancel) {
  let at = 0;
  return new ReadableStream(
    {
      pull(c) {
        if (at >= bytes.length) return c.close();
        c.enqueue(bytes.slice(at, (at += size)));
      },
      cancel: onCancel,
    },
    { highWaterMark: 0 },
  );
}

/** Every top-level field of a tile, as its bytes, with the layer name for
 *  layers: a full decode to compare a slice against. */
function decodeTile(bytes) {
  let p = 0;
  const read = (limit) => {
    let v = 0;
    for (let s = 0; ; s += 7) {
      assert.ok(p < limit, "varint inside bounds");
      const b = bytes[p++];
      v += (b & 0x7f) * 2 ** s;
      if (!(b & 0x80)) return v;
    }
  };
  const fields = [];
  while (p < bytes.length) {
    const start = p;
    const tag = read(bytes.length);
    assert.equal(tag & 7, 2, "top-level fields are length-delimited");
    const len = read(bytes.length);
    const body = p;
    p += len;
    let name = null;
    if (tag >>> 3 === 3) {
      let q = body;
      const readIn = () => {
        const save = p;
        p = q;
        const v = read(body + len);
        q = p;
        p = save;
        return v;
      };
      while (q < body + len && name === null) {
        const t = readIn();
        const w = t & 7;
        if (w === 0) readIn();
        else if (w === 2) {
          const l = readIn();
          if (t >>> 3 === 1) name = new TextDecoder().decode(bytes.subarray(q, q + l));
          q += l;
        } else q += w === 1 ? 8 : 4;
      }
    }
    fields.push({ name, bytes: bytes.subarray(start, p) });
  }
  return fields;
}

const concat = (parts) => {
  const out = new Uint8Array(parts.reduce((n, b) => n + b.length, 0));
  let at = 0;
  for (const b of parts) {
    out.set(b, at);
    at += b.length;
  }
  return out;
};

const expectedSlice = (bytes, keep) =>
  concat(decodeTile(bytes).filter((f) => f.name === null || keep.has(f.name)).map((f) => f.bytes));

test("a slice keeps exactly the named layers, whatever size the stream's chunks are", async () => {
  const bytes = tile(
    layer("water"),
    layer("bathymetry", { versionFirst: true, kind: "deep" }),
    layer("land", { kind: "rock" }),
  );
  const keep = new Set(["bathymetry", "land"]);
  const expected = tile(layer("bathymetry", { versionFirst: true, kind: "deep" }), layer("land", { kind: "rock" }));
  for (let size = 1; size <= bytes.length; size++) {
    assert.deepEqual(await sliceLayers(chunked(bytes, size), keep, 1 << 20), expected, `chunk size ${size}`);
  }
});

test("keeping every layer returns the tile, and keeping none returns null", async () => {
  const bytes = tile(layer("water"), layer("land"));
  assert.deepEqual(await sliceLayers(chunked(bytes, 7), null, 1 << 20), bytes);
  assert.equal(await sliceLayers(chunked(bytes, 7), new Set(["roads"]), 1 << 20), null);
  assert.equal(await sliceLayers(chunked(bytes, 7), new Set(), 1 << 20), null);
});

test("a malformed tile throws a slice error", async () => {
  const bytes = tile(layer("water"), layer("land"));
  const boundary = layer("water").length;
  for (let cut = 1; cut < bytes.length; cut++) {
    if (cut === boundary) continue;
    await assert.rejects(
      sliceLayers(chunked(bytes.subarray(0, cut), 5), new Set(["land"]), 1 << 20),
      MvtSliceError,
      `cut at ${cut} of ${bytes.length}`,
    );
  }
  const group = Uint8Array.from([...layer("water"), ...varint((7 << 3) | 3)]);
  await assert.rejects(sliceLayers(chunked(group, 4), new Set(["water"]), 1 << 20), /wire type 3/);
  const nameless = Uint8Array.from(field(3, 2, [...field(15, 0, varint(2)), ...field(5, 0, varint(4096))]));
  await assert.rejects(sliceLayers(chunked(nameless, 4), new Set(["water"]), 1 << 20), /layer without a name/);
});

test("passing the limit throws and cancels the stream", async () => {
  const bytes = tile(layer("water"), layer("land"));
  let cancelled = false;
  await assert.rejects(
    sliceLayers(chunked(bytes, 3, () => (cancelled = true)), null, bytes.length - 1),
    /limit/,
  );
  assert.ok(cancelled, "stream cancelled");
});

test("on a real Natural Earth tile, each slice equals that layer from a full decode", async () => {
  const bytes = new Uint8Array(await readFile(new URL("fixtures/naturalearth_physical_3_7_3.mvt", import.meta.url)));
  const names = decodeTile(bytes).map((f) => f.name);
  assert.ok(names.length >= 4, `fixture has ${names.length} layers`);
  const gz = new Uint8Array(gzipSync(bytes));
  for (const name of names) {
    const keep = new Set([name]);
    const viaGzip = chunked(gz, 4096).pipeThrough(new DecompressionStream("gzip"));
    assert.deepEqual(await sliceLayers(viaGzip, keep, 1 << 20), expectedSlice(bytes, keep), name);
  }
  assert.deepEqual(await sliceLayers(chunked(bytes, 1000), new Set(names), 1 << 20), bytes);
});

/** A source over in-memory archive bytes that records each read. */
function memorySource(bytes, etag = '"v1"') {
  const reads = [];
  return {
    reads,
    getKey: () => "memory",
    async getBytes(offset, length) {
      reads.push(length);
      return { data: bytes.slice(offset, offset + length).buffer, etag: etag ?? undefined };
    },
  };
}

const drain = async (stream) => new Uint8Array(await new Response(stream).arrayBuffer());

test("a stored tile streams out decompressed, after one read of its own", async () => {
  const data = tile(layer("water"), layer("land"));
  for (const gzip of [true, false]) {
    const source = memorySource(buildArchive([{ z: 2, x: 1, y: 1, data }], { minZoom: 1, maxZoom: 3, gzip }));
    const archive = openArchive(source);
    assert.deepEqual(new Uint8Array((await archive.getZxy(2, 1, 1)).data), data);
    const readsBefore = source.reads.length;

    assert.deepEqual(await drain(await archiveTileStream(archive, { z: 2, x: 1, y: 1 })), data, `gzip ${gzip}`);
    assert.equal(source.reads.length - readsBefore, 1, "one read added by the stored handle");
    assert.equal(await archiveTileStream(archive, { z: 2, x: 0, y: 0 }), null, "absent tile");
    assert.equal(await archiveTileStream(archive, { z: 4, x: 0, y: 0 }), null, "past the archive's zooms");
  }
});

test("a stored tile over the ceiling is refused before it is read", async () => {
  const big = new Uint8Array(STORED_TILE_MAX_BYTES + 1);
  const source = memorySource(buildArchive([{ z: 0, x: 0, y: 0, data: big }], { maxZoom: 0 }));
  const archive = openArchive(source);
  await archive.getHeader();
  await assert.rejects(archiveTileStream(archive, { z: 0, x: 0, y: 0 }), /passes/);
  assert.ok(source.reads.every((n) => n <= STORED_TILE_MAX_BYTES), "no read over the ceiling");
});

test("an archive's version is its etag as a cache key can carry it", async () => {
  const bytes = buildArchive([{ z: 0, x: 0, y: 0, data: "t" }], { maxZoom: 0 });
  assert.equal(await archiveVersion(openArchive(memorySource(bytes, '"3a5f-12"'))), "3a5f-12");
  await assert.rejects(archiveVersion(openArchive(memorySource(bytes, null))), /has no etag/);
});
