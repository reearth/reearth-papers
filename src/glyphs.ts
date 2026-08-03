// Per-codepoint glyph store + subset PBF builder for the ezu renderer.
//
// ezu binds SDF glyphs from the same protobuf MapLibre serves, but it
// files each glyph by its own id — a bound message may hold any set of
// codepoints and its `range` string is ignored. That lets us stop
// handing the renderer whole 256-codepoint blocks.
//
// It matters because the blocks are almost empty of anything the tile
// draws. A Tokyo z14 window needs 1,339 distinct glyphs and, fetched as
// blocks, downloads 44,288 slots to get them — 3.0% utilisation, ~38MB
// resident in the renderer's glyph bank against a 128MB isolate.
//
// So: fetch blocks (that is still all the /fonts endpoint can serve),
// but keep only the glyphs a tile actually asked for, and re-emit them
// as a subset message. The blocks are transient; what stays resident is
// the used set, which converges quickly as a viewport pans.
//
//   glyphs   { repeated fontstack stacks = 1 }
//   fontstack{ required string name = 1
//              required string range = 2
//              repeated glyph glyphs = 3 }
//   glyph    { required uint32 id = 1; ... }
//
// Glyph submessages are copied through byte for byte — nothing decodes
// the SDF bitmaps here.

/** Cap on the resident glyph store, isolate-wide. The measured working
 *  set for a CJK-dense viewport is ~1-2MB; this leaves room for a pan
 *  across scripts without letting a long-lived isolate creep back up to
 *  block-sized numbers. */
const STORE_BUDGET_BYTES = 8 * 1024 * 1024;

/** `${source}:${codepoint}` → the glyph's raw protobuf submessage.
 *  Insertion-ordered and re-inserted on use, so iteration order is LRU. */
const store = new Map<string, Uint8Array>();
let storeBytes = 0;

export function glyphStoreStats(): { entries: number; bytes: number } {
  return { entries: store.size, bytes: storeBytes };
}

export function hasGlyph(source: string, cp: number): boolean {
  return store.has(`${source}:${cp}`);
}

function touch(key: string): Uint8Array | undefined {
  const hit = store.get(key);
  if (hit === undefined) return undefined;
  store.delete(key);
  store.set(key, hit);
  return hit;
}

function put(source: string, cp: number, raw: Uint8Array): void {
  const key = `${source}:${cp}`;
  const prev = store.get(key);
  if (prev) storeBytes -= prev.length;
  store.delete(key);
  store.set(key, raw);
  storeBytes += raw.length;
  // Oldest first — a `for…of` over a Map yields insertion order, and
  // `touch` re-inserts, so the front is the least recently used.
  while (storeBytes > STORE_BUDGET_BYTES) {
    const oldest = store.keys().next();
    if (oldest.done) break;
    const victim = store.get(oldest.value);
    store.delete(oldest.value);
    storeBytes -= victim ? victim.length : 0;
  }
}

// --- protobuf ---------------------------------------------------------

function readVarint(buf: Uint8Array, p: number): [number, number] {
  let r = 0;
  let shift = 0;
  for (;;) {
    const b = buf[p++];
    r += (b & 0x7f) * 2 ** shift;
    if (!(b & 0x80)) break;
    shift += 7;
  }
  return [r, p];
}

/** Call `onField(fieldNumber, payload)` for every length-delimited field
 *  at this level; skip the rest. */
function walk(
  buf: Uint8Array,
  onField: (field: number, payload: Uint8Array) => void,
): void {
  let p = 0;
  while (p < buf.length) {
    let tag: number;
    [tag, p] = readVarint(buf, p);
    const field = tag >> 3;
    const wire = tag & 7;
    if (wire === 2) {
      let len: number;
      [len, p] = readVarint(buf, p);
      onField(field, buf.subarray(p, p + len));
      p += len;
    } else if (wire === 0) {
      [, p] = readVarint(buf, p);
    } else if (wire === 5) p += 4;
    else if (wire === 1) p += 8;
    else throw new Error(`glyph pbf: bad wire type ${wire}`);
  }
}

function varintBytes(v: number): number[] {
  const out: number[] = [];
  while (v > 0x7f) {
    out.push((v & 0x7f) | 0x80);
    v = Math.floor(v / 128);
  }
  out.push(v);
  return out;
}

/** Length-delimited field: tag, length, payload. */
function field(no: number, payload: Uint8Array): Uint8Array[] {
  return [
    new Uint8Array(varintBytes((no << 3) | 2)),
    new Uint8Array(varintBytes(payload.length)),
    payload,
  ];
}

function concat(parts: Uint8Array[]): Uint8Array {
  let n = 0;
  for (const p of parts) n += p.length;
  const out = new Uint8Array(n);
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
}

/** A glyph's field 1 is its codepoint. Read just that and leave the rest
 *  of the submessage untouched — it goes back out verbatim. */
function glyphId(glyph: Uint8Array): number | null {
  let p = 0;
  while (p < glyph.length) {
    let tag: number;
    [tag, p] = readVarint(glyph, p);
    const wire = tag & 7;
    if (tag >> 3 === 1 && wire === 0) {
      const [id] = readVarint(glyph, p);
      return id;
    }
    if (wire === 0) [, p] = readVarint(glyph, p);
    else if (wire === 2) {
      let len: number;
      [len, p] = readVarint(glyph, p);
      p += len;
    } else if (wire === 5) p += 4;
    else if (wire === 1) p += 8;
    else return null;
  }
  return null;
}

// --- store + build ----------------------------------------------------

/** Take every glyph in a fetched `{range}.pbf` whose codepoint is in
 *  `wanted` and keep it. The rest of the block is dropped — holding it
 *  is exactly the 38MB this module exists to avoid. */
export function ingestGlyphPbf(
  source: string,
  bytes: Uint8Array,
  wanted: Set<number>,
): number {
  let kept = 0;
  walk(bytes, (topField, stack) => {
    if (topField !== 1) return;
    walk(stack, (stackField, glyph) => {
      if (stackField !== 3) return;
      const id = glyphId(glyph);
      if (id === null || !wanted.has(id)) return;
      put(source, id, glyph);
      kept++;
    });
  });
  return kept;
}

/** Assemble a glyph PBF holding exactly `codepoints` (those the store
 *  has). `range` is free-form — ezu keys off each glyph's own id. */
export function buildSubsetPbf(
  source: string,
  fontstack: string,
  codepoints: Iterable<number>,
): { bytes: Uint8Array; glyphs: number } | null {
  const name = new TextEncoder().encode(fontstack);
  const range = new TextEncoder().encode("0-65535");
  const parts: Uint8Array[] = [...field(1, name), ...field(2, range)];
  let glyphs = 0;
  for (const cp of codepoints) {
    const raw = touch(`${source}:${cp}`);
    if (!raw) continue;
    parts.push(...field(3, raw));
    glyphs++;
  }
  if (!glyphs) return null;
  return { bytes: concat(field(1, concat(parts))), glyphs };
}
