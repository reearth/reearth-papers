#!/usr/bin/env node
// Refresh what src/overture.ts says about the Overture release.
//
// The worker no longer pins a release — it lists the bucket and serves
// the newest (see currentRelease in src/overture.ts), because Overture
// keeps a rolling window there and deletes what falls out of it. What
// the file still carries is the *metadata*: each theme's zoom range and
// each layer's id and minzoom, compiled in because the catalog and the
// TileJSON have to describe the tiles before anyone asks for one.
//
// Those numbers move between releases — Overture dropped `building`'s
// minzoom from 6 to 4 in `2026-08-19.0` — so this reads the new
// archives and writes the current ones back. Nothing breaks while it
// goes unrun; the catalog just describes the tiles slightly wrong.
//
//   node scripts/overture-release.mjs            report what the live archives say
//   node scripts/overture-release.mjs --bump     write it into src/overture.ts
//   node scripts/overture-release.mjs --json     machine-readable report on stdout

import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

import { FetchSource, PMTiles } from "pmtiles";

const BUCKET = "https://overturemaps-extras-us-west-2.s3.us-west-2.amazonaws.com";
const PREFIX = "tiles/";
const SOURCE = join(dirname(fileURLToPath(import.meta.url)), "..", "src", "overture.ts");

const args = new Set(process.argv.slice(2));
const BUMP = args.has("--bump");
const JSON_OUT = args.has("--json");

// Only stdout carries the report in --json mode; progress goes to stderr
// so a caller can pipe one without the other.
const say = (...m) => (JSON_OUT ? console.error(...m) : console.log(...m));

/** Releases still in the bucket, oldest first.
 *
 *  Names are `YYYY-MM-DD.N`, so a plain string sort is chronological
 *  until N reaches double digits — compare the date and the number
 *  separately rather than betting that it never will. */
async function listReleases() {
  const url = `${BUCKET}/?list-type=2&delimiter=/&prefix=${encodeURIComponent(PREFIX)}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`bucket listing failed: ${res.status} ${res.statusText}`);
  const xml = await res.text();
  const names = [...xml.matchAll(/<Prefix>tiles\/([^<\/]+)\/<\/Prefix>/g)].map((m) => m[1]);
  const key = (r) => {
    const [date, n] = r.split(".");
    return [date, Number(n ?? 0)];
  };
  return names.sort((a, b) => {
    const [da, na] = key(a);
    const [db, nb] = key(b);
    return da === db ? na - nb : da < db ? -1 : 1;
  });
}

/** The `theme` values src/overture.ts serves, in file order. */
function readThemes(src) {
  return [...src.matchAll(/^\s*theme: "([^"]+)",$/gm)].map((m) => m[1]);
}

function readPin(src) {
  const m = src.match(/^export const OVERTURE_RELEASE = "([^"]+)";$/m);
  if (!m) throw new Error("could not find OVERTURE_RELEASE in src/overture.ts");
  return m[1];
}

/** Header zooms + per-layer minzooms of one theme archive, read over
 *  HTTP Range exactly the way the worker reads it. */
async function readArchive(release, theme) {
  const url = `${BUCKET}/${PREFIX}${release}/${theme}.pmtiles`;
  const pm = new PMTiles(new FetchSource(url));
  const header = await pm.getHeader();
  const meta = await pm.getMetadata();
  const layers = (meta?.vector_layers ?? []).map((l) => ({
    id: l.id,
    minzoom: l.minzoom ?? 0,
    maxzoom: l.maxzoom ?? header.maxZoom,
  }));
  layers.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  return { theme, minzoom: header.minZoom, maxzoom: header.maxZoom, layers };
}

// -- rewriting src/overture.ts ---------------------------------------------

/** The slice of `src` holding one theme's tileset literal: from its
 *  `theme:` line to the end of its `layers: [ … ]` array. Everything
 *  this script edits lives inside that slice, which keeps the edits
 *  away from the identically-named fields of every other entry. */
function themeBlock(src, theme) {
  const at = src.indexOf(`theme: "${theme}",`);
  if (at < 0) throw new Error(`no tileset entry with theme "${theme}"`);
  const layersAt = src.indexOf("layers: [", at);
  if (layersAt < 0) throw new Error(`no layers array after theme "${theme}"`);
  let depth = 0;
  let i = src.indexOf("[", layersAt);
  for (; i < src.length; i++) {
    if (src[i] === "[") depth++;
    else if (src[i] === "]" && --depth === 0) break;
  }
  return { start: at, headEnd: layersAt, end: i + 1 };
}

/** Set `field: <number>` inside a slice, once. */
function setNumber(text, field, value) {
  const re = new RegExp(`(\\b${field}: )(-?\\d+)`);
  if (!re.test(text)) return { text, changed: false };
  let changed = false;
  const out = text.replace(re, (_, head, old) => {
    changed = String(value) !== old;
    return `${head}${value}`;
  });
  return { text: out, changed };
}

/** Rewrite the pin, each theme's `maxzoom`, and each declared layer's
 *  `minzoom`. Layer *membership* is never rewritten: a layer that
 *  appeared or vanished upstream needs a description and a geometry
 *  hint, which only a person can write. Those are reported instead. */
function applyBump(src, release, archives) {
  let out = src.replace(
    /^(export const OVERTURE_RELEASE = ")[^"]+(";)$/m,
    `$1${release}$2`,
  );
  const notes = [];

  for (const a of archives) {
    const b = themeBlock(out, a.theme);
    const head = out.slice(b.start, b.headEnd);
    const layers = out.slice(b.headEnd, b.end);

    const zoomed = setNumber(head, "maxzoom", a.maxzoom);
    if (zoomed.changed) notes.push(`${a.theme}: maxzoom → ${a.maxzoom}`);

    let body = layers;
    for (const l of a.layers) {
      // Anchor on the layer's own `id`, then move to the `minzoom` that
      // closes the same object literal.
      const at = body.indexOf(`id: "${l.id}"`);
      if (at < 0) continue;
      const close = body.indexOf("}", at);
      const obj = body.slice(at, close);
      const set = setNumber(obj, "minzoom", l.minzoom);
      if (set.changed) notes.push(`${a.theme}.${l.id}: minzoom → ${l.minzoom}`);
      body = body.slice(0, at) + set.text + body.slice(close);
    }

    out = out.slice(0, b.start) + zoomed.text + body + out.slice(b.end);
  }
  return { text: out, notes };
}

/** Layers the archive has and the file doesn't, and the reverse. */
function layerDrift(src, archives) {
  const drift = [];
  for (const a of archives) {
    const b = themeBlock(src, a.theme);
    const body = src.slice(b.headEnd, b.end);
    const declared = [...body.matchAll(/id: "([^"]+)"/g)].map((m) => m[1]);
    for (const l of a.layers) {
      if (!declared.includes(l.id)) drift.push(`${a.theme}: new layer "${l.id}" (minzoom ${l.minzoom})`);
    }
    for (const id of declared) {
      if (!a.layers.some((l) => l.id === id)) drift.push(`${a.theme}: layer "${id}" is gone upstream`);
    }
  }
  return drift;
}

// -- main -------------------------------------------------------------------

const src = readFileSync(SOURCE, "utf8");
const pinned = readPin(src);
const themes = readThemes(src);
const available = await listReleases();
const newest = available[available.length - 1];
const pinAlive = available.includes(pinned);

say(`metadata from: ${pinned}${pinAlive ? "" : "  (no longer in the bucket)"}`);
say(`available:     ${available.join(", ") || "(none)"}`);
say(`serving:       ${newest ?? "(none)"}`);

const report = { pinned, available, newest, pinAlive, themes, bumped: false, notes: [], drift: [] };

if (!newest) {
  console.error("No releases found under tiles/ — the bucket layout may have changed.");
  process.exitCode = 1;
} else if (newest === pinned) {
  say("up to date.");
} else {
  say(`\nreading ${newest} archive metadata…`);
  const archives = [];
  for (const theme of themes) {
    try {
      const a = await readArchive(newest, theme);
      say(`  ${theme}: z${a.minzoom}–${a.maxzoom}, layers ${a.layers.map((l) => `${l.id}@${l.minzoom}`).join(" ")}`);
      archives.push(a);
    } catch (e) {
      console.error(`  ${theme}: FAILED — ${String(e)}`);
      process.exitCode = 1;
    }
  }
  report.archives = archives;

  if (archives.length === themes.length) {
    report.drift = layerDrift(src, archives);
    if (BUMP) {
      const { text, notes } = applyBump(src, newest, archives);
      report.notes = notes;
      if (text !== src) {
        writeFileSync(SOURCE, text);
        report.bumped = true;
        say(`\nbumped ${pinned} → ${newest}`);
        for (const n of notes) say(`  ${n}`);
      }
    }
    for (const d of report.drift) say(`  drift: ${d}`);
  } else {
    console.error("Not every theme archive could be read — not bumping.");
  }
}

if (!pinAlive) {
  say(
    `\nNote: ${pinned} is no longer in the bucket. The routes are unaffected — ` +
      `the worker resolves the newest release at runtime — but the zoom metadata ` +
      `in src/overture.ts was read from a release nobody can check any more.`,
  );
}

if (JSON_OUT) console.log(JSON.stringify(report, null, 2));
