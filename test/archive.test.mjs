import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import { test } from "node:test";

import { buildArchive } from "./fake-s3.mjs";
import { loadSrc } from "./load-src.mjs";

test("an archive whose first header read fails reads its header on the next request", async () => {
  const { openArchive } = await loadSrc("archive");
  const bytes = buildArchive([{ z: 0, x: 0, y: 0, data: "tile" }]);
  let failNext = true;
  const source = {
    getKey: () => "flaky",
    async getBytes(offset, length) {
      if (failNext) {
        failNext = false;
        throw new Error("Bad response code: 503");
      }
      return { data: bytes.slice(offset, offset + length).buffer, etag: '"e1"' };
    },
  };
  const archive = openArchive(source);

  await assert.rejects(archive.getHeader(), /Bad response code: 503/);
  const header = await archive.getHeader();
  assert.equal(header.maxZoom, 1);
});

test("no module under src/ builds a PMTiles handle except archive.ts", async () => {
  const srcDir = new URL("../src/", import.meta.url);
  const offenders = [];
  for (const name of await readdir(srcDir, { recursive: true })) {
    if (!name.endsWith(".ts") || name === "archive.ts") continue;
    if ((await readFile(new URL(name, srcDir), "utf8")).includes("new PMTiles(")) {
      offenders.push(name);
    }
  }
  assert.deepEqual(offenders, [], "build archive handles with openArchive from src/archive.ts");
});
