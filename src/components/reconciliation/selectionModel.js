// T95 — the selection model for the import-review screen's tiles and root
// nodes, extracted as a pure module so the multi-select rule is testable
// without React and cannot drift between RootMap (which draws the active
// state) and RootMapPanel (which lists what is in scope).
//
// ADR 2026-08-18-rootmap-screen-port.md §5 narrowed the pre-Roots multi-select
// chip row to a single-select union. Owner reversal, 2026-09-12: "happy to see
// 2 or more at a time". This restores multi-select for TILES only.
//
// Tiles vs nodes are deliberately different gestures:
//   - a TILE is a lens over a state ("show me Changed"), and lenses ADD:
//     selecting Changed + Needs attention shows the union of both.
//   - a NODE is a drill-down into one domain/child. Drilling into two places
//     at once is not a meaningful request, so node selection stays single and
//     REPLACES whatever was selected.
//
// The invariant the audit cared about is preserved: filtering is a lens, never
// a second inbox. Widening the lens changes what you SEE, never what is
// pending — counts and the apply tray read from the report, not from here.
//
// Shape:
//   { type: 'none' }                                   — the quiet default
//   { type: 'tile', states: ['changed', ...] }         — one or more lenses
//   { type: 'node', domainKey, childKey? }             — one drill-down
//
// `states` preserves click order so a multi-tile heading reads back in the
// order the director picked, rather than in some internal canonical order.

export const NO_SELECTION = { type: 'none' }

/** Every tile state currently selected, in click order. [] for none/node. */
export function tileStates(selection) {
  if (!selection || selection.type !== 'tile') return []
  return selection.states ?? []
}

/** Is this specific tile state part of the current selection? */
export function isTileSelected(selection, state) {
  return tileStates(selection).includes(state)
}

/** Is the current selection a node drill-down? */
export function isNodeSelection(selection) {
  return Boolean(selection) && selection.type === 'node'
}

/**
 * Toggle one tile state.
 *
 * From a node selection this REPLACES (a lens and a drill-down are not
 * combined into an intersection — that would be a second model). Removing the
 * last selected tile returns to NO_SELECTION rather than an empty tile
 * selection, so "nothing selected" has exactly one representation and the
 * default quiet view cannot be reached by two different states.
 */
export function toggleTile(selection, state) {
  const current = isNodeSelection(selection) ? [] : tileStates(selection)
  const next = current.includes(state)
    ? current.filter((s) => s !== state)
    : [...current, state]
  if (next.length === 0) return NO_SELECTION
  return { type: 'tile', states: next }
}
