// Adapts electron/ops/openReconciliationDecisions.js's persisted rows into
// the exact shape buildAttentionList({ model, decisionsById, structureIssues })
// already reads (src/ingest/attentionList.js, on the unmerged
// feat/ws4-roots-home branch) — WITHOUT changing that function's signature.
// docs/adr/2026-08-28-persisted-reconciliation-decisions.md §5.
//
// FOLLOW-UP (blocked on feat/ws4-roots-home merging): RootsHomeScreen.jsx
// does not exist on this branch yet. Once it merges, wire this module's
// output — via useOpenReconciliationDecisions(campId) — into
// RootsHomeScreen's existing buildAttentionList({ model, decisionsById,
// structureIssues }) call as the `model`/`decisionsById` arguments
// (merged/unioned with whatever it already builds from
// buildRootMapModel(null, { snapshot: collections, mode: 'inspect' })). That
// one-line wiring is the ONLY remaining step — this module is otherwise
// complete and independently unit-tested.

// §1: 'confirm_change' rows are the only kind whose roster state is
// 'changed'; every other persisted kind (confirm_value, resolve_conflict)
// reads as 'attention' — the same two-state split stateOf/rootMapModel.js
// already draws for a live decision.
function stateFor(kind) {
  return kind === 'confirm_change' ? 'changed' : 'attention'
}

// Groups persisted rows by their precomputed domain_key/child_key (written
// once at commitPlan time — see openReconciliationDecisions.js's
// replaceOpenDecisionsForCommit) into buildAttentionList's synthetic
// `model.domains[].children[].roster[]` shape. Pure: no DOMAINS/CHILD_OF
// lookup needed here since §1 already precomputed those labels.
export function openDecisionsToModel(rows) {
  const domainsByKey = new Map() // domain_key -> { label, childrenByKey: Map(child_key -> child) }
  const decisionsById = new Map()

  for (const row of rows ?? []) {
    if (!row || !row.id) continue

    decisionsById.set(row.id, { reason: row.reason ?? null })

    const domainKey = row.domain_key ?? 'General'
    const childKey = row.child_key ?? 'General'
    if (!domainsByKey.has(domainKey)) {
      domainsByKey.set(domainKey, { label: domainKey, childrenByKey: new Map() })
    }
    const domain = domainsByKey.get(domainKey)
    if (!domain.childrenByKey.has(childKey)) {
      domain.childrenByKey.set(childKey, { key: childKey, roster: [] })
    }
    domain.childrenByKey.get(childKey).roster.push({
      state: stateFor(row.kind),
      decisionId: row.id,
      entityId: row.entity_id ?? null,
      name: row.entity_name ?? null,
    })
  }

  const model = {
    domains: [...domainsByKey.values()].map((domain) => ({
      label: domain.label,
      children: [...domain.childrenByKey.values()],
    })),
  }

  return { model, decisionsById }
}
