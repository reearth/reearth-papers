// Rewrite a MapLibre style into forms `ezu translate` carries over,
// without changing what MapLibre draws. Used by scripts/ezu-recipes.sh
// between fetching `style.json?renderer=1` and translating it.
//
// - A `line-dasharray` that steps on zoom (`["step", ["zoom"],
//   ["literal", A], z1, ["literal", B], …]`, as the protomaps
//   boundaries do) is not carried over: since ezu 0.13 the translator
//   accepts a constant array only, and draws the line solid otherwise.
//   Each such layer is split into one layer per step, with its zoom range
//   narrowed to that step and a constant dasharray. MapLibre evaluates a
//   dasharray at the tile's integer zoom, and our step stops sit on
//   integer zooms, so every tile draws the same either way.
//
// Usage: node scripts/ezu-style-prep.mjs <in.json> <out.json>
import { readFileSync, writeFileSync } from "node:fs";

const [input, output] = process.argv.slice(2);
if (!input || !output) {
  console.error("usage: ezu-style-prep.mjs <in.json> <out.json>");
  process.exit(2);
}

const style = JSON.parse(readFileSync(input, "utf8"));

/** `["literal", [..]]` or a bare array → the array, else null. */
function constArray(v) {
  if (Array.isArray(v) && v[0] === "literal" && Array.isArray(v[1])) return v[1];
  if (Array.isArray(v) && v.every((n) => typeof n === "number")) return v;
  return null;
}

/** `["step", ["zoom"], out0, z1, out1, …]` with constant outputs →
 *  [{ from, to, value }] (to exclusive, undefined = open), else null. */
function zoomSteps(expr) {
  if (!Array.isArray(expr) || expr[0] !== "step") return null;
  const input = expr[1];
  if (!Array.isArray(input) || input[0] !== "zoom" || input.length !== 1) return null;
  const first = constArray(expr[2]);
  if (!first) return null;
  const steps = [{ from: undefined, value: first }];
  for (let i = 3; i < expr.length; i += 2) {
    const z = expr[i];
    const value = constArray(expr[i + 1]);
    if (typeof z !== "number" || !value) return null;
    steps[steps.length - 1].to = z;
    steps.push({ from: z, value });
  }
  return steps;
}

const layers = [];
let split = 0;
for (const layer of style.layers) {
  const steps = layer.type === "line" ? zoomSteps(layer.paint?.["line-dasharray"]) : null;
  if (!steps) {
    layers.push(layer);
    continue;
  }
  const lo = layer.minzoom ?? 0;
  const hi = layer.maxzoom ?? 24;
  for (const [i, s] of steps.entries()) {
    const min = Math.max(lo, s.from ?? 0);
    const max = Math.min(hi, s.to ?? 24);
    if (min >= max) continue;
    const part = structuredClone(layer);
    part.id = `${layer.id}__z${i}`;
    if (min > 0) part.minzoom = min;
    else delete part.minzoom;
    if (max < 24) part.maxzoom = max;
    else delete part.maxzoom;
    part.paint["line-dasharray"] = s.value;
    layers.push(part);
  }
  split++;
}
style.layers = layers;

writeFileSync(output, JSON.stringify(style));
if (split) console.error(`ezu-style-prep: split ${split} zoom-stepped dasharray layer(s)`);
