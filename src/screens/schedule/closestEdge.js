// Atlassian's `closest-edge` hitbox pattern (@atlaskit/pragmatic-drag-and-drop-hitbox),
// reduced to the one axis this grid needs. Given a resolved cell's rect and the
// pointer position inside it, decide which edge the drop attaches to — this is what
// makes "insert above block 4" distinguishable from "replace block 4" without a
// modifier key.
//
// Pure: the caller supplies the rect. This module reads no DOM.

// Tie-break: a point exactly on the midline resolves to 'bottom'.
//
// Why: the rule is the half-open interval [top, mid) -> 'top', [mid, bottom] -> 'bottom'.
// One strict `<` comparison covers every point in the rect with no equality special
// case, so there is no coordinate that lands in both halves or in neither. 'bottom'
// (rather than 'top') is the arbitrary-but-fixed side; what matters is that it is
// stated and tested, because an implicit tie-break becomes a bug report later.
export function closestEdge(rect, point) {
  const midline = rect.top + (rect.bottom - rect.top) / 2
  return point.y < midline ? 'top' : 'bottom'
}
