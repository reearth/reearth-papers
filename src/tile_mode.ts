// Style adjustments for maplibre-native's Tile mode (the renderer
// container). Shared by the mirror worker (which serves the style the
// container actually renders) and the main worker's
// /styles/{theme}/style.json?renderer=1 (a public, token-free view of
// the same adjustments for debugging and gl-js comparison).
//
// Why they exist:
//
// - Tile mode refuses to place a text-variable-anchor label anywhere
//   its collision box would touch a tile border: adjacent tiles can't
//   be trusted to pick the same anchor, so instead of risking a seam
//   it suppresses the label entirely
//   (TilePlacement::canPlaceAtVariableAnchor). With the pois layer's
//   ["left", "right"] anchors that turns a label-width band along all
//   four edges of every 512px tile into a no-place zone. Pinning the
//   anchor restores gl-js-like density: fixed-anchor symbols that
//   cross a border go through Tile mode's border-priority pass and
//   render seam-consistently from the neighbours' tile buffers.
//
// - Tile mode also runs a border-priority placement pass gl-js
//   doesn't have: symbols whose boxes cross a tile border — from any
//   layer — place before every mid-tile symbol, so a border-crossing
//   label from a lower layer can preempt a POI the browser style
//   would show. That's inherent to seam-consistent per-tile
//   rendering, so instead of chasing placement parity, the pois text
//   is made optional: when only the text loses its spot the icon
//   still renders instead of the whole symbol vanishing.
export function tileModeAdjustments<T>(ls: T[]): T[] {
  for (const l of ls) {
    const layer = l as { id?: unknown; layout?: Record<string, unknown> };
    const layout = layer.layout;
    if (!layout) continue;
    if (layout["text-variable-anchor"]) {
      delete layout["text-variable-anchor"];
      layout["text-anchor"] = "left";
    }
    if (layer.id === "pois") {
      layout["text-optional"] = true;
    }
  }
  return ls;
}
