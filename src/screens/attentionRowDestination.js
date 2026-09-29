// T237 — resolves an attention row (RootsHomeScreen.jsx / buildAttentionList's
// { name, why, domainTag, sourceKind } shape) to the screen it should
// navigate to when clicked. Pure, no React — split out so it can be unit
// tested directly rather than only through a rendered row's click handler.
//
// Reconciliation rows all converge on the same fileless reconciliation door
// (docs/work/tickets/T237-attention-rows-open-the-reconciliation-flow.md).
// Structure rows carry no childKey (attentionList.js's buildStructureIssues
// only ever stamps a domainTag), so they always resolve through rootMapNav's
// domain-level DOMAIN_SCREEN fallback — which can legitimately return null
// for a domain with no edit screen; callers must render that row inert
// rather than navigate to nothing.
import { screenForNode } from '../components/reconciliation/rootMapNav.js'

export function screenForAttentionRow(row) {
  if (row.sourceKind === 'reconciliation') return 'reconciliation'
  return screenForNode(row.domainTag)
}

// T306 — WHICH subject a row is about. The camper id travels inside the row id
// (attentionList.js builds `unattributed-camper:<camperId>`) because acting on the row
// means attributing that ONE subject rather than opening a list.
//
// It lives here rather than in RootsHomeScreen.jsx for the reason stated at the top of
// this file — a pure row helper, unit-testable without rendering a row — and because
// react-refresh/only-export-components makes a non-component export from a component
// file a lint ERROR, which is how CI caught it.
//
// Deliberately NOT routed through screenForAttentionRow above: that resolves a row to a
// SCREEN, and an unattributed-camper row is acted on where it stands. Adding a `Campers`
// entry to DOMAIN_SCREEN to make the existing dispatch fit would send the director to a
// list and lose the one thing the row id carries.
export function subjectIdFromRow(row) {
  if (row?.sourceKind !== 'unattributed-camper') return null
  const id = String(row.id ?? '')
  const marker = 'unattributed-camper:'
  return id.startsWith(marker) ? id.slice(marker.length) || null : null
}
