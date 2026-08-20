// rootMapLayout — root-map port, docs/adr/2026-08-18-rootmap-screen-port.md §8.
//
// PURE config, not logic. Coordinates are hand-placed, copied verbatim from
// the owner-approved prototype (scratchpad/blender/build_composition4.py's
// DOMAINS array) as the starting point. x/y are normalized to the
// illustration ([0,1] on each axis).

// Coordinates land each node on a real root of the 3D-relief backdrop
// (src/assets/reconciliation/root-map-3d.png). Unlike the flat illustration,
// these were NOT eyeballed: each node's normalized position on the source
// illustration was re-projected through the tilted render camera in Blender
// (world_to_camera_view over the displaced root mesh), so every dot sits on
// its root in the new perspective. Normalized [0,1] on each axis; if the
// backdrop is re-rendered at a different camera, re-run that projection.
export const NODE_LAYOUT = {
  Structure: {
    x: 0.3008,
    y: 0.485,
    children: {
      Units: { x: 0.2541, y: 0.5761 },
      Groups: { x: 0.248, y: 0.7364 },
      'Age Divisions': { x: 0.347, y: 0.8169 },
    },
  },
  Scheduling: {
    x: 0.4456,
    y: 0.4807,
    children: {
      Activities: { x: 0.4541, y: 0.5739 },
      'Fixed Events': { x: 0.4256, y: 0.6533 },
    },
  },
  Time: {
    x: 0.5503,
    y: 0.5404,
    children: {
      Days: { x: 0.5488, y: 0.5963 },
      'Time Blocks': { x: 0.5622, y: 0.7347 },
    },
  },
  Facility: {
    x: 0.6456,
    y: 0.5224,
    children: {
      Locations: { x: 0.6258, y: 0.7352 },
    },
  },
  Context: {
    x: 0.8025,
    y: 0.4992,
    children: {},
  },
}

// Deterministic fallback for a child not hand-placed above (a CHILD_OF
// mapping added later, or the 'General' pseudo-child fallback) — an evenly
// spaced position along a short arc below the parent domain node, indexed by
// the child's position in a fixed sort order. No PRNG: unlike the schedule
// engine's seeded layout there is no "many equally-valid placements"
// problem here, just "don't crash and don't overlap the parent exactly".
export function layoutForChild(domainKey, childKey, index = 0) {
  const domain = NODE_LAYOUT[domainKey] ?? { x: 0.5, y: 0.5, children: {} }
  const hand = domain.children?.[childKey]
  if (hand) return hand

  const ARC_RADIUS = 0.10
  const ARC_SPAN = Math.PI / 3 // 60 degrees, fanned below the trunk
  const slot = index % 5
  const angle = Math.PI / 2 - ARC_SPAN / 2 + (slot / 4) * ARC_SPAN
  return {
    x: domain.x + ARC_RADIUS * Math.cos(angle),
    y: domain.y + ARC_RADIUS * Math.sin(angle),
  }
}
