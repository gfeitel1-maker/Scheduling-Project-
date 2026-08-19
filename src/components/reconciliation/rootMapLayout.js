// rootMapLayout — root-map port, docs/adr/2026-08-18-rootmap-screen-port.md §8.
//
// PURE config, not logic. Coordinates are hand-placed, copied verbatim from
// the owner-approved prototype (scratchpad/blender/build_composition4.py's
// DOMAINS array) as the starting point. x/y are normalized to the
// illustration ([0,1] on each axis).

// Coordinates snapped onto ACTUAL root pixels of the illustration
// (src/assets/reconciliation/root-map.png). Each x/y was chosen from a detected
// root cluster at that depth (analysis in scratchpad), so every dot sits on a
// real root, not in open cream between them. Normalized [0,1] on each axis.
export const NODE_LAYOUT = {
  Structure: {
    x: 0.28,
    y: 0.46,
    children: {
      Units: { x: 0.234, y: 0.56 },
      Groups: { x: 0.23, y: 0.72 },
      'Age Divisions': { x: 0.338, y: 0.80 },
    },
  },
  Scheduling: {
    x: 0.44,
    y: 0.46,
    children: {
      Activities: { x: 0.451, y: 0.56 },
      'Fixed Events': { x: 0.42, y: 0.64 },
    },
  },
  Time: {
    x: 0.555,
    y: 0.52,
    children: {
      Days: { x: 0.553, y: 0.58 },
      'Time Blocks': { x: 0.566, y: 0.72 },
    },
  },
  Facility: {
    x: 0.66,
    y: 0.50,
    children: {
      Locations: { x: 0.634, y: 0.72 },
    },
  },
  Context: {
    x: 0.83,
    y: 0.48,
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
