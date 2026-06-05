// Shared RGBA → PNG / WebP encoders for the COG-backed raster
// tilesets. Formerly duplicated per handler — lifted here once the
// third caller arrived, per the original "keep duplicated, refactor on
// the third caller" note.

import encodeWebp, { init as initWebp } from "@jsquash/webp/encode";
// @jsquash's init() accepts a pre-instantiated WebAssembly.Module and
// skips its loader. Without this the encoder would try to fetch the
// .wasm at runtime, which Workers can't satisfy. init() picks SIMD vs
// scalar at runtime via `wasm-feature-detect.simd()`; Workers support
// WASM SIMD, so we must hand it the matching SIMD-built wasm.
// @ts-expect-error — .wasm modules are bundled via wrangler's CompiledWasm rule.
import WEBP_ENC_WASM from "@jsquash/webp/codec/enc/webp_enc_simd.wasm";

// -- PNG ---------------------------------------------------------------------

// Workers' CompressionStream("deflate") emits zlib-wrapped data, which
// is exactly what PNG IDAT needs.
async function zlibDeflate(input: Uint8Array): Promise<Uint8Array> {
  const cs = new CompressionStream("deflate");
  const writer = cs.writable.getWriter();
  void writer.write(input);
  void writer.close();
  return new Uint8Array(await new Response(cs.readable).arrayBuffer());
}

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(buf: Uint8Array, start: number, end: number): number {
  let c = 0xffffffff;
  for (let i = start; i < end; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function pngChunk(type: string, data: Uint8Array): Uint8Array {
  const out = new Uint8Array(8 + data.length + 4);
  const dv = new DataView(out.buffer);
  dv.setUint32(0, data.length);
  for (let i = 0; i < 4; i++) out[4 + i] = type.charCodeAt(i);
  out.set(data, 8);
  dv.setUint32(8 + data.length, crc32(out, 4, 8 + data.length));
  return out;
}

export async function encodePngRGBA(
  rgba: Uint8Array,
  width: number,
  height: number,
): Promise<Uint8Array> {
  const rowSize = width * 4;
  // PNG filter byte 0 ("None") prepended to each scanline.
  const filtered = new Uint8Array(height * (1 + rowSize));
  for (let y = 0; y < height; y++) {
    filtered[y * (1 + rowSize)] = 0;
    filtered.set(rgba.subarray(y * rowSize, (y + 1) * rowSize), y * (1 + rowSize) + 1);
  }
  const idat = await zlibDeflate(filtered);

  const ihdr = new Uint8Array(13);
  const dv = new DataView(ihdr.buffer);
  dv.setUint32(0, width);
  dv.setUint32(4, height);
  ihdr[8] = 8;  // bit depth
  ihdr[9] = 6;  // color type RGBA
  ihdr[10] = 0; // compression
  ihdr[11] = 0; // filter
  ihdr[12] = 0; // interlace

  const signature = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const ihdrChunk = pngChunk("IHDR", ihdr);
  const idatChunk = pngChunk("IDAT", idat);
  const iendChunk = pngChunk("IEND", new Uint8Array(0));

  const total =
    signature.length + ihdrChunk.length + idatChunk.length + iendChunk.length;
  const out = new Uint8Array(total);
  let off = 0;
  for (const part of [signature, ihdrChunk, idatChunk, iendChunk]) {
    out.set(part, off);
    off += part.length;
  }
  return out;
}

// -- WebP --------------------------------------------------------------------

let webpReady: Promise<void> | null = null;
async function ensureWebpReady(): Promise<void> {
  if (!webpReady) {
    webpReady = (async () => {
      await initWebp(WEBP_ENC_WASM as unknown as WebAssembly.Module);
    })();
  }
  await webpReady;
}

export interface WebpOptions {
  // Lossless suits classification rasters with sharp colour boundaries
  // (ESA WorldCover); lossy q≈85 suits photographic sources (Black
  // Marble, Natural Earth) where artefacts are imperceptible and the
  // byte savings are ~10×.
  lossless?: boolean;
  quality?: number;
}

export async function encodeWebpRGBA(
  rgba: Uint8Array,
  width: number,
  height: number,
  options: WebpOptions = {},
): Promise<Uint8Array> {
  await ensureWebpReady();
  const { lossless = false, quality = lossless ? 100 : 85 } = options;
  const ab = await encodeWebp(
    {
      data: new Uint8ClampedArray(rgba.buffer, rgba.byteOffset, rgba.byteLength),
      width,
      height,
      colorSpace: "srgb",
    },
    { lossless: lossless ? 1 : 0, quality, method: 4 },
  );
  return new Uint8Array(ab);
}
