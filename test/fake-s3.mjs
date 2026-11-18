import { zxyToTileId } from "pmtiles";

const HEADER_BYTES = 127;

function varints(values) {
  const out = [];
  for (let v of values) {
    while (v >= 0x80) {
      out.push((v & 0x7f) | 0x80);
      v = Math.floor(v / 0x80);
    }
    out.push(v);
  }
  return out;
}

/** A PMTiles v3 archive with no compression, holding `tiles`
 *  (`{ z, x, y, data }`, `data` a string or bytes), declaring the zoom range, and
 *  carrying `metadata` as its JSON metadata when given. */
export function buildArchive(tiles, { minZoom = 0, maxZoom = 1, metadata } = {}) {
  const entries = tiles
    .map((t) => ({ id: zxyToTileId(t.z, t.x, t.y), bytes: typeof t.data === "string" ? new TextEncoder().encode(t.data) : t.data }))
    .sort((a, b) => a.id - b.id);
  let offset = 0;
  const placed = entries.map((e) => {
    const p = { ...e, offset };
    offset += e.bytes.length;
    return p;
  });
  let last = 0;
  const dir = Uint8Array.from(
    varints([
      placed.length,
      ...placed.map((e) => {
        const delta = e.id - last;
        last = e.id;
        return delta;
      }),
      ...placed.map(() => 1),
      ...placed.map((e) => e.bytes.length),
      ...placed.map((e) => e.offset + 1),
    ]),
  );
  const json = new TextEncoder().encode(metadata === undefined ? "" : JSON.stringify(metadata));
  const jsonOffset = HEADER_BYTES + dir.length;
  const dataOffset = jsonOffset + json.length;
  const buf = new Uint8Array(dataOffset + offset);
  const dv = new DataView(buf.buffer);
  buf.set(new TextEncoder().encode("PMTiles"), 0);
  buf[7] = 3;
  const u64 = (at, n) => dv.setBigUint64(at, BigInt(n), true);
  u64(8, HEADER_BYTES);
  u64(16, dir.length);
  u64(24, jsonOffset);
  u64(32, json.length);
  u64(40, dataOffset);
  u64(48, 0);
  u64(56, dataOffset);
  u64(64, offset);
  u64(72, placed.length);
  u64(80, placed.length);
  u64(88, placed.length);
  buf[96] = 1; // clustered
  buf[97] = 1; // internal compression: none
  buf[98] = 1; // tile compression: none
  buf[99] = 1; // tile type: mvt
  buf[100] = minZoom;
  buf[101] = maxZoom;
  buf.set(dir, HEADER_BYTES);
  buf.set(json, jsonOffset);
  for (const e of placed) buf.set(e.bytes, dataOffset + e.offset);
  return buf;
}

const CACHE_MODES_WORKERS_ACCEPTS = new Set([undefined, "no-store", "no-cache"]);

/** A stand-in for the public Overture S3 bucket, installed as `fetch`.
 *
 *  It answers bucket listings and range reads the way S3 does, and, like
 *  workerd, throws a `TypeError` for a `cache` mode Workers does not
 *  support. Objects are keyed by path, as in `tiles/<release>/<theme>.pmtiles`. */
export function fakeS3() {
  const objects = new Map();
  let failuresLeft = 0;
  let failStatus = 503;
  let listingRejects = false;

  const s3 = {
    rangeReads: 0,
    put(key, bytes, etag) {
      objects.set(key, { bytes, etag });
    },
    /** Answer the next `count` object reads with `status`. */
    failReads(count = Infinity, status = 503) {
      failuresLeft = count;
      failStatus = status;
    },
    recover() {
      failuresLeft = 0;
      listingRejects = false;
    },
    rejectListing() {
      listingRejects = true;
    },
    async fetch(input, init = {}) {
      if (!CACHE_MODES_WORKERS_ACCEPTS.has(init.cache)) {
        throw new TypeError(`Unsupported cache mode: ${init.cache}`);
      }
      const url = new URL(String(input));
      if (url.searchParams.get("list-type") === "2") {
        if (listingRejects) throw new TypeError("Network connection lost.");
        const prefix = url.searchParams.get("prefix") ?? "";
        const releases = new Set();
        for (const key of objects.keys()) {
          if (key.startsWith(prefix)) releases.add(key.slice(prefix.length).split("/")[0]);
        }
        const xml = [...releases]
          .map((r) => `<CommonPrefixes><Prefix>${prefix}${r}/</Prefix></CommonPrefixes>`)
          .join("");
        return new Response(`<ListBucketResult>${xml}</ListBucketResult>`, { status: 200 });
      }

      s3.rangeReads += 1;
      if (failuresLeft > 0) {
        failuresLeft -= 1;
        return new Response("SlowDown", { status: failStatus });
      }
      const obj = objects.get(url.pathname.slice(1));
      if (!obj) return new Response("NoSuchKey", { status: 404 });
      const range = new Headers(init.headers).get("range");
      const [, from, to] = range.match(/^bytes=(\d+)-(\d+)$/);
      const size = obj.bytes.length;
      if (Number(from) >= size) {
        return new Response(null, { status: 416, headers: { "content-range": `bytes */${size}` } });
      }
      const end = Math.min(Number(to), size - 1);
      const body = obj.bytes.slice(Number(from), end + 1);
      return new Response(body, {
        status: 206,
        headers: {
          etag: obj.etag,
          "content-length": String(body.length),
          "content-range": `bytes ${from}-${end}/${size}`,
        },
      });
    },
  };
  return s3;
}

/** A stand-in for an R2 binding. `objects` maps a key to
 *  `{ bytes, etag }` for an archive or `{ json }` for a JSON file. */
export function fakeR2(objects) {
  return {
    async get(key, options) {
      const obj = objects[key];
      if (!obj) return null;
      if ("json" in obj) return { json: async () => obj.json };
      const { offset, length } = options.range;
      const bytes = obj.bytes.slice(offset, offset + length);
      return { httpEtag: obj.etag, arrayBuffer: async () => bytes.buffer };
    },
  };
}
