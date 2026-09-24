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
