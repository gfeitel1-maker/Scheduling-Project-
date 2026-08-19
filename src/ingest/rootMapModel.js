// buildRootMapModel — root-map port, docs/adr/2026-08-18-rootmap-screen-port.md §2.
//
// PURE. No IO/DOM/random. Projects a buildReconciliationReport() output (via
// reportToLanes, so the root map can never disagree with the card list about
// which decisions exist) into the node model RootMap.jsx renders.
//
// Reuses, never reimplements: DOMAINS/domainOf/childOf/computeDomainCounts
// (domainRollup.js) for domain/child membership, reportToLanes for the
// actual decision list, isDecisionResolvedFor for resolved/unresolved.

import { reportToLanes } from './reportToLanes.js'
import { isDecisionResolvedFor } from '../screens/reconciliationTriage.js'
import { DOMAINS, domainOf, childOf } from '../components/reconciliation/domainRollup.js'
import { NODE_LAYOUT, layoutForChild } from '../components/reconciliation/rootMapLayout.js'

// A group of decisions -> one of the four honest states. 'absent' is NEVER
// returned here — it is only ever assigned by the caller for a domain/child
// with zero decisions AND positive evidence of absence (today: the Context
// domain only, per the ADR's documented state-space reduction). Zero
// decisions with no such evidence defaults to 'understood', per the ADR
// ("a healthy domain with nothing to flag must not read as 'nothing was
// imported'").
function stateOf(decisions, isResolved) {
  if (decisions.length === 0) return 'understood'
  const unresolved = decisions.filter((d) => !isResolved(d))
  if (unresolved.length === 0) return 'understood'
  // Mixed unresolved sets bias toward 'attention' — it is the
  // action-required state and must not be masked by 'changed'.
  const allChanged = unresolved.every((d) => d.kind === 'confirm_change')
  return allChanged ? 'changed' : 'attention'
}

export function buildRootMapModel(report, { answers = {}, dismissedGaps = new Set() } = {}) {
  const lanes = reportToLanes(report ?? { decisions: [], buckets: {}, readiness: [] })
  const allDecisions = [...lanes.hold, ...lanes.standard]
  const isResolved = (d) => isDecisionResolvedFor(d, answers, dismissedGaps)

  const domains = DOMAINS.map((domainKey) => {
    const domainDecisions = allDecisions.filter((d) => domainOf(d) === domainKey)

    // 'Context' never has any entity/screen mapping to it (domainRollup.js),
    // so it always has zero decisions here — that absence of attribution IS
    // the positive evidence of absence the ADR requires, and is the only
    // domain this model marks 'absent'.
    const isContext = domainKey === 'Context'

    const childGroups = new Map()
    for (const d of domainDecisions) {
      const key = childOf(d)
      if (!childGroups.has(key)) childGroups.set(key, [])
      childGroups.get(key).push(d)
    }

    const children = [...childGroups.entries()].map(([childKey, decisions], index) => {
      const pos = layoutForChild(domainKey, childKey, index)
      return {
        key: childKey,
        name: childKey,
        count: decisions.length,
        state: stateOf(decisions, isResolved),
        x: pos.x,
        y: pos.y,
        decisionIds: decisions.map((d) => d.id),
      }
    })

    const domainPos = NODE_LAYOUT[domainKey] ?? { x: 0.5, y: 0.5 }
    return {
      key: domainKey,
      label: domainKey,
      state: isContext ? 'absent' : stateOf(domainDecisions, isResolved),
      x: domainPos.x,
      y: domainPos.y,
      children,
    }
  })

  return { domains }
}
