// A small MVT 2.1 encoder for test fixtures. It writes exactly the keys,
// values and tags it is given, so a test can build what an encoder
// library would refuse to: shared values, unused values, unknown fields.

export function varint(n) {
  const out = [];
  while (n >= 0x80) {
    out.push((n % 0x80) | 0x80);
    n = Math.floor(n / 0x80);
  }
  out.push(n);
  return out;
}

const zigzag = (n) => (n << 1) ^ (n >> 31);
const utf8 = (s) => [...new TextEncoder().encode(s)];

export const len = (field, bytes) => [...varint(field * 8 + 2), ...varint(bytes.length), ...bytes];
const num = (field, n) => [...varint(field * 8), ...varint(n)];

function value(v) {
  if (typeof v === "string") return len(4, len(1, utf8(v)));
  if (typeof v === "boolean") return len(4, num(7, v ? 1 : 0));
  if (Number.isInteger(v) && v >= 0) return len(4, num(5, v));
  const b = new Uint8Array(8);
  new DataView(b.buffer).setFloat64(0, v, true);
  return len(4, [...varint(3 * 8 + 1), ...b]);
}

/** One point at (x, y). */
export const point = (x, y) => [9, zigzag(x), zigzag(y)];
/** A three-vertex line. */
export const line = (x, y) => [9, zigzag(x), zigzag(y), 18, zigzag(5), zigzag(5), zigzag(3), zigzag(-2)];

/** A feature: `tags` index into its layer's keys and values; `extra`
 *  is raw bytes appended inside the feature message. */
function feature({ id, type = 1, geometry = point(1, 1), tags, extra = [] }) {
  return len(2, [
    ...(id === undefined ? [] : num(1, id)),
    ...(tags && tags.length ? len(2, tags.flatMap(varint)) : []),
    ...num(3, type),
    ...len(4, geometry.flatMap(varint)),
    ...extra,
  ]);
}

function layer({ name, version = 2, extent = 4096, keys = [], values = [], features = [], extra = [] }) {
  return len(3, [
    ...num(15, version),
    ...len(1, utf8(name)),
    ...features.flatMap(feature),
    ...keys.flatMap((k) => len(3, utf8(k))),
    ...values.flatMap(value),
    ...num(5, extent),
    ...extra,
  ]);
}

/** An encoded tile. `extra` is raw bytes appended at tile level. */
export function encodeTile(layers, extra = []) {
  return Uint8Array.from([...layers.flatMap(layer), ...extra]);
}

/** An unknown length-delimited field, to show it survives untouched. */
export const unknownField = (field, text) => len(field, utf8(text));
