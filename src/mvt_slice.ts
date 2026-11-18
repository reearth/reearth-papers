// Cut a vector tile down to the layers a style reads, without decoding it.
//
// An MVT is a protobuf `Tile` whose field 3 repeats one `Layer` message per
// layer, and each layer carries its own keys and values, so whole layer
// messages can be dropped or copied byte for byte and what remains is
// still a valid tile (vector-tile-spec 2.1). The input is a stream so that
// a tile far larger than what is kept never exists in memory at once: an
// Overture `base` tile at z4 decodes to 75 MB, of which a style reading
// `bathymetry` keeps a few hundred kilobytes.

export class MvtSliceError extends Error {
  override name = "MvtSliceError";
}

/** The layers kept from a tile pass the byte limit it was cut with. */
export class MvtLimitError extends MvtSliceError {
  override name = "MvtLimitError";
}

/** How far into a layer its `name` may sit. Encoders put it first or
 *  just after `version`; a layer whose name is further in is not worth
 *  holding the prefix for. */
const NAME_WITHIN_BYTES = 64 * 1024;

const TILE_LAYERS = 3;
const LAYER_NAME = 1;
const WIRE_VARINT = 0;
const WIRE_I64 = 1;
const WIRE_LEN = 2;
const WIRE_I32 = 5;

class Reader {
  #reader: ReadableStreamDefaultReader<Uint8Array>;
  #chunk: Uint8Array = new Uint8Array(0);
  #pos = 0;

  constructor(stream: ReadableStream<Uint8Array>) {
    this.#reader = stream.getReader();
  }

  async #fill(): Promise<boolean> {
    while (this.#pos >= this.#chunk.length) {
      const { value, done } = await this.#reader.read();
      if (done) return false;
      this.#chunk = value;
      this.#pos = 0;
    }
    return true;
  }

  async atEnd(): Promise<boolean> {
    return !(await this.#fill());
  }

  async varint(record?: number[]): Promise<number> {
    let value = 0;
    for (let shift = 0; shift < 64; shift += 7) {
      if (!(await this.#fill())) throw new MvtSliceError("tile ends inside a varint");
      const b = this.#chunk[this.#pos++];
      record?.push(b);
      value += (b & 0x7f) * 2 ** shift;
      if (!(b & 0x80)) return value;
    }
    throw new MvtSliceError("varint longer than 10 bytes");
  }

  /** Pass the next `n` bytes to `sink`, or skip them when there is none. */
  async take(n: number, sink?: (bytes: Uint8Array) => void): Promise<void> {
    while (n > 0) {
      if (!(await this.#fill())) throw new MvtSliceError("tile ends inside a field");
      const k = Math.min(n, this.#chunk.length - this.#pos);
      sink?.(this.#chunk.subarray(this.#pos, this.#pos + k));
      this.#pos += k;
      n -= k;
    }
  }

  cancel(): Promise<void> {
    return this.#reader.cancel().catch(() => undefined);
  }
}

function fixedSize(wire: number): number {
  if (wire === WIRE_I64) return 8;
  if (wire === WIRE_I32) return 4;
  throw new MvtSliceError(`unsupported wire type ${wire}`);
}

/**
 * The tile read from `stream` with only the layers named in `keep`, or every
 * layer when `keep` is null. Null when nothing is kept.
 *
 * Throws `MvtSliceError`, after cancelling the stream, when the tile is
 * malformed, when a layer's name is not within its first 64 KiB, or when
 * what is kept would pass `maxBytes`.
 */
export async function sliceLayers(
  stream: ReadableStream<Uint8Array>,
  keep: ReadonlySet<string> | null,
  maxBytes: number,
): Promise<Uint8Array | null> {
  const r = new Reader(stream);
  const kept: Uint8Array[] = [];
  let keptBytes = 0;
  const emit = (bytes: Uint8Array | readonly number[]): void => {
    keptBytes += bytes.length;
    if (keptBytes > maxBytes) {
      throw new MvtLimitError(`kept layers pass the ${maxBytes}-byte limit`);
    }
    kept.push(Uint8Array.from(bytes));
  };
  const names = new TextDecoder();

  try {
    while (!(await r.atEnd())) {
      const head: number[] = [];
      const tag = await r.varint(head);
      const wire = tag & 7;
      if (wire === WIRE_VARINT) {
        await r.varint(head);
        emit(head);
        continue;
      }
      const size = wire === WIRE_LEN ? await r.varint(head) : fixedSize(wire);
      if (tag >>> 3 !== TILE_LAYERS || wire !== WIRE_LEN || keep === null) {
        emit(head);
        await r.take(size, emit);
        continue;
      }

      // A layer. Read its fields up to `name`, keeping what was read so the
      // layer can still be copied whole once it turns out to be wanted.
      const prefix: number[] = [];
      let name: string | null = null;
      while (name === null && prefix.length < size) {
        const t = await r.varint(prefix);
        const w = t & 7;
        if (w === WIRE_VARINT) {
          await r.varint(prefix);
          continue;
        }
        const n = w === WIRE_LEN ? await r.varint(prefix) : fixedSize(w);
        if (prefix.length + n > size) throw new MvtSliceError("field runs past its layer");
        if (prefix.length + n > NAME_WITHIN_BYTES) {
          throw new MvtSliceError(`layer name not within ${NAME_WITHIN_BYTES} bytes of its start`);
        }
        const start = prefix.length;
        await r.take(n, (bytes) => {
          for (const b of bytes) prefix.push(b);
        });
        if (t >>> 3 === LAYER_NAME && w === WIRE_LEN) {
          name = names.decode(Uint8Array.from(prefix.slice(start)));
        }
      }
      if (prefix.length > size) throw new MvtSliceError("field runs past its layer");
      if (name === null) throw new MvtSliceError("layer without a name");
      if (keep.has(name)) {
        emit(head);
        emit(prefix);
        await r.take(size - prefix.length, emit);
      } else {
        await r.take(size - prefix.length);
      }
    }
  } catch (e) {
    await r.cancel();
    throw e;
  }

  if (keptBytes === 0) return null;
  const out = new Uint8Array(keptBytes);
  let at = 0;
  for (const piece of kept) {
    out.set(piece, at);
    at += piece.length;
  }
  return out;
}
