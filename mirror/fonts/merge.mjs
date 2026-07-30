#!/usr/bin/env node
// Merge step of the fonts pipeline (see build.sh for the why).
//
// For every output fontstack, copies the mirrored upstream range files
// verbatim except inside the CJK Unicode blocks, where it composites
// [upstream, ...CJK fonts in priority order] — first font wins per
// codepoint. Upstream stays first so its Noto Sans punctuation and the
// Arabic presentation forms sharing range 65024-65279 survive.
//
// The glyph PBF schema is tiny (fontnik's glyphs.proto), so this
// hand-rolls the few protobuf ops it needs instead of pulling deps:
//   glyphs { repeated fontstack stacks = 1 }
//   fontstack { name = 1; range = 2; repeated glyph glyphs = 3 }
//   glyph { uint32 id = 1; ... }
// Glyph submessages are copied byte-for-byte — only `id` is parsed —
// so SDF bitmaps and sint32 metrics survive untouched.

import { readdirSync, readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { join } from "node:path";

const args = Object.fromEntries(
  process.argv.slice(2).map((a) => {
    const m = a.match(/^--([^=]+)=(.*)$/);
    return m ? [m[1], m[2]] : [a.replace(/^--/, ""), true];
  }),
);
const WORK = args.work ?? "work";
const OUT = args.out ?? "out";
const PRIORITY = (args.priority ?? "JP,SC,TC,KR").split(",");
const SUFFIX = args.suffix ?? "";

// CJK blocks to fill, as [firstRangeStart, lastRangeStart] of the
// 256-codepoint glyph ranges they span.
const GAP_BLOCKS = [
  [4352, 4352], // Hangul Jamo
  [12288, 13056], // CJK punct, kana, bopomofo, compat jamo, enclosed
  [13312, 19712], // CJK Unified Ext A
  [19968, 40704], // CJK Unified Ideographs
  [44032, 55040], // Hangul Syllables
  [63744, 64000], // CJK Compatibility Ideographs
  [65024, 65024], // CJK compat forms (shared with Arabic PF-B — merged)
  [65280, 65280], // Halfwidth & fullwidth forms
];
const gapStarts = new Set();
for (const [a, b] of GAP_BLOCKS) for (let s = a; s <= b; s += 256) gapStarts.add(s);

// Output stack → { upstream dir name, CJK weight (Italic gets upright
// Regular: CJK has no italic and tofu is worse than roman posture) }.
const STACKS = [
  { name: "Noto Sans Regular", weight: "Regular" },
  { name: "Noto Sans Medium", weight: "Medium" },
  { name: "Noto Sans Italic", weight: "Regular" },
];

// ---- minimal protobuf ----------------------------------------------

function readVarint(buf, pos) {
  let r = 0n, s = 0n;
  for (;;) {
    const b = buf[pos.i++];
    r |= BigInt(b & 0x7f) << s;
    if (!(b & 0x80)) return Number(r);
    s += 7n;
  }
}

function* fields(buf, start = 0, end = buf.length) {
  const pos = { i: start };
  while (pos.i < end) {
    const key = readVarint(buf, pos);
    const field = key >> 3, wire = key & 7;
    if (wire === 2) {
      const len = readVarint(buf, pos);
      yield { field, wire, bytes: buf.subarray(pos.i, pos.i + len) };
      pos.i += len;
    } else if (wire === 0) {
      yield { field, wire, value: readVarint(buf, pos) };
    } else if (wire === 5) {
      yield { field, wire }; pos.i += 4;
    } else if (wire === 1) {
      yield { field, wire }; pos.i += 8;
    } else {
      throw new Error(`unsupported wire type ${wire}`);
    }
  }
}

/** All glyph submessages in a glyphs PBF, as { id, raw } — raw is the
 *  unparsed glyph message body, re-emitted verbatim on encode. */
function readGlyphs(buf) {
  const out = [];
  for (const stack of fields(buf)) {
    if (stack.field !== 1 || stack.wire !== 2) continue;
    for (const f of fields(stack.bytes)) {
      if (f.field !== 3 || f.wire !== 2) continue;
      let id = -1;
      for (const g of fields(f.bytes)) {
        if (g.field === 1 && g.wire === 0) { id = g.value; break; }
      }
      if (id >= 0) out.push({ id, raw: f.bytes });
    }
  }
  return out;
}

function varintBytes(n) {
  const out = [];
  do {
    let b = n & 0x7f;
    n >>>= 7;
    if (n) b |= 0x80;
    out.push(b);
  } while (n);
  return out;
}

function lenDelim(field, bytes) {
  return Buffer.concat([
    Buffer.from(varintBytes((field << 3) | 2)),
    Buffer.from(varintBytes(bytes.length)),
    bytes,
  ]);
}

function writeGlyphsPbf(stackName, range, glyphs) {
  const stack = Buffer.concat([
    lenDelim(1, Buffer.from(stackName, "utf8")),
    lenDelim(2, Buffer.from(range, "utf8")),
    ...glyphs.map((g) => lenDelim(3, g.raw)),
  ]);
  return lenDelim(1, stack);
}

// ---- merge ----------------------------------------------------------

function tryRead(path) {
  try {
    const b = readFileSync(path);
    return b.length ? b : null;
  } catch {
    return null;
  }
}

// build_pbf_glyphs names its output dir after the font's internal
// name; each gen/<key> holds exactly one such dir.
function genDir(key) {
  const base = join(WORK, "gen", key);
  const subs = readdirSync(base, { withFileTypes: true }).filter((d) => d.isDirectory());
  if (subs.length !== 1) throw new Error(`${base}: expected exactly one fontstack dir`);
  return join(base, subs[0].name);
}

const totals = {};
for (const { name, weight } of STACKS) {
  const outName = name + SUFFIX;
  const outDir = join(OUT, outName);
  mkdirSync(outDir, { recursive: true });
  const upstreamDir = join(WORK, "upstream", name);
  const cjkDirs = PRIORITY.map((lang) => genDir(`NotoSans${lang}-${weight}`));
  let merged = 0, copied = 0, glyphTotal = 0;

  for (let start = 0; start <= 65280; start += 256) {
    const range = `${start}-${start + 255}`;
    const upstream = tryRead(join(upstreamDir, `${range}.pbf`));
    if (!gapStarts.has(start)) {
      // Outside the CJK blocks upstream is authoritative (Latin,
      // Arabic, PGF…). CJK fonts also carry Latin — merging them here
      // would swap Noto Sans metrics for CJK-font ones.
      writeFileSync(join(outDir, `${range}.pbf`), upstream ?? writeGlyphsPbf(outName, range, []));
      copied++;
      continue;
    }
    const seen = new Set();
    const glyphs = [];
    for (const src of [upstream, ...cjkDirs.map((d) => tryRead(join(d, `${range}.pbf`)))]) {
      if (!src) continue;
      for (const g of readGlyphs(src)) {
        if (g.id < start || g.id > start + 255 || seen.has(g.id)) continue;
        seen.add(g.id);
        glyphs.push(g);
      }
    }
    glyphs.sort((a, b) => a.id - b.id);
    writeFileSync(join(outDir, `${range}.pbf`), writeGlyphsPbf(outName, range, glyphs));
    merged++;
    glyphTotal += glyphs.length;
  }
  totals[outName] = { merged, copied, glyphTotal };
  console.log(`${outName}: ${merged} ranges merged (+${glyphTotal} CJK-block glyphs), ${copied} copied`);
}

// ---- sanity checks --------------------------------------------------
// A silently glyphless output would only surface as tofu on prod
// tiles much later — fail here instead.

const CHECKS = [
  [0x3042, "あ (hiragana)"],
  [0x30a2, "ア (katakana)"],
  [0x6771, "東 (CJK unified)"],
  [0x5317, "北 (CJK unified)"],
  [0xd55c, "한 (hangul)"],
  [0xfeeb, "ﻫ (Arabic PF-B, must survive merge)"],
];
const firstStack = STACKS[0].name + SUFFIX;
let failed = false;
for (const [cp, label] of CHECKS) {
  const start = Math.floor(cp / 256) * 256;
  const buf = tryRead(join(OUT, firstStack, `${start}-${start + 255}.pbf`));
  const ok = buf && readGlyphs(buf).some((g) => g.id === cp);
  console.log(`${ok ? "ok " : "MISSING"} U+${cp.toString(16).toUpperCase()} ${label}`);
  if (!ok) failed = true;
}
if (failed) {
  console.error("sanity checks failed — output is incomplete, not uploading this");
  process.exit(1);
}
