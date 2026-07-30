// Region-priority CJK glyph flavors.
//
// One fontstack holds one glyph per codepoint, so Han-unified
// codepoints render with whichever variant the stack's merge priority
// picked (mirror/fonts/). The base stacks are JP-first; the " SC" /
// " TC" suffixed stacks (same pipeline, different PRIORITY) put
// Simplified / Traditional forms first. The tiles can't tell us which
// variant a feature wants — `script` is just "Han" for Japanese and
// both Chinese variants alike, and there is no per-feature country
// code — but the raster pipeline knows each tile's coordinates, so we
// pick the flavor by where the tile sits.
//
// The boxes are deliberately coarse: the flavor only affects Han
// glyph *variants*, so being "wrong" over Mongolia or Vietnam (no Han
// text to speak of) or Korea (hangul renders identically in every
// flavor) is harmless. The one region that must never fall into the
// SC box is Japan, hence the explicit earlier rules. Rules are
// evaluated in order; the first hit wins.
//
// The boxes encode prevailing local typographic convention — which
// variant of a Han-unified codepoint looks right to readers there —
// and are not statements about territory or status.

export type CjkFlavor = "sc" | "tc";

const CJK_FLAVORS: readonly CjkFlavor[] = ["sc", "tc"];

export function isCjkFlavor(s: string): s is CjkFlavor {
  return (CJK_FLAVORS as readonly string[]).includes(s);
}

// [west, south, east, north] in degrees; flavor undefined = keep the
// JP-first base stacks.
const REGION_RULES: readonly {
  box: [number, number, number, number];
  flavor?: CjkFlavor;
}[] = [
  { box: [119.3, 21.8, 122.1, 25.4], flavor: "tc" }, // Taiwan
  { box: [113.5, 22.1, 114.5, 22.6], flavor: "tc" }, // Hong Kong / Macao
  { box: [103.6, 1.1, 104.1, 1.5], flavor: "sc" }, // Singapore
  { box: [124.0, 33.0, 130.7, 43.0] }, // Korean peninsula → base
  { box: [122.5, 24.0, 146.5, 45.9] }, // Japan → base
  { box: [73.5, 18.0, 134.8, 53.6], flavor: "sc" }, // China mainland
];

/** Flavor for a tile, decided by its center point. Below z6 a tile
 *  spans several of these regions, so stay with the base stacks. */
export function tileCjkFlavor(coords: {
  z: number;
  x: number;
  y: number;
}): CjkFlavor | undefined {
  if (coords.z < 6) return undefined;
  const n = 2 ** coords.z;
  const lon = ((coords.x + 0.5) / n) * 360 - 180;
  const lat =
    (Math.atan(Math.sinh(Math.PI * (1 - (2 * (coords.y + 0.5)) / n))) * 180) /
    Math.PI;
  for (const { box, flavor } of REGION_RULES) {
    const [w, s, e, no] = box;
    if (lon >= w && lon <= e && lat >= s && lat <= no) return flavor;
  }
  return undefined;
}

// The base stacks the stock layers reference. The per-script PGF
// stacks ("Noto Sans Devanagari Regular v1") are left untouched.
const BASE_STACKS = new Set([
  "Noto Sans Regular",
  "Noto Sans Medium",
  "Noto Sans Italic",
]);

/** Deep-rewrite a generated layer tree so every reference to a base
 *  fontstack points at the flavored one ("Noto Sans Regular SC" …).
 *  Fontstack names only ever appear as string literals inside
 *  text-font expressions, and the exact base names collide with
 *  nothing else in the style. */
export function applyCjkFlavor<T>(layers: T, flavor: CjkFlavor): T {
  const suffix = ` ${flavor.toUpperCase()}`;
  const walk = (v: unknown): unknown => {
    if (typeof v === "string") return BASE_STACKS.has(v) ? v + suffix : v;
    if (Array.isArray(v)) return v.map(walk);
    if (v && typeof v === "object") {
      return Object.fromEntries(
        Object.entries(v as Record<string, unknown>).map(([k, x]) => [k, walk(x)]),
      );
    }
    return v;
  };
  return walk(layers) as T;
}
