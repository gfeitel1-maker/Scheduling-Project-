// buildRootMapModel — root-map port, docs/adr/2026-08-18-rootmap-screen-port.md §2.
// Roster/census extension: docs/adr/2026-08-19-roots-census-and-persistent-inspector.md §(a)-(d).
//
// PURE. No IO/DOM/random. Projects a buildReconciliationReport() output (via
// reportToLanes, so the root map can never disagree with the card list about
// which decisions exist) into the node model RootMap.jsx renders.
//
// Reuses, never reimplements: DOMAINS/domainOf/childOf/computeDomainCounts
// (domainRollup.js) for domain/child membership, reportToLanes for the
// actual decision list, isDecisionResolvedFor for resolved/unresolved,
// REQUIRED_AREAS (readiness.js) for the not_set_up required-5 scoping.

import { reportToLanes } from './reportToLanes.js'
import { isDecisionResolvedFor } from '../screens/reconciliationTriage.js'
import { DOMAINS, DOMAIN_OF, domainOf, CHILD_OF, childOf } from '../components/reconciliation/domainRollup.js'
import { NODE_LAYOUT, layoutForChild } from '../components/reconciliation/rootMapLayout.js'
import { REQUIRED_AREAS } from '../engine/readiness.js'

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

// Reverse of CHILD_OF: child label -> the snapshot entity type it's backed
// by. Every CHILD_OF value is unique, so this is a clean inversion.
const ENTITY_TYPE_FOR_CHILD = Object.fromEntries(
  Object.entries(CHILD_OF).map(([entityType, childKey]) => [childKey, entityType]),
)

// REQUIRED_AREAS' keys (readiness.js) don't match the snapshot's canonical
// table-name keys for two of the five ('days' -> 'days_of_operation',
// 'timeblocks' -> 'time_blocks') — same translation the audit's R3 fix
// documents. Reused as the not_set_up scoping's sole source of truth; see
// (d)'s "where this ADR would tell Red Hat no."
const REQUIRED_AREA_ENTITY_TYPE = {
  tiers: 'tiers',
  groups: 'groups',
  days: 'days_of_operation',
  timeblocks: 'time_blocks',
  activities: 'activities',
}
const REQUIRED_ENTITY_TYPES = new Set(
  REQUIRED_AREAS.map((a) => REQUIRED_AREA_ENTITY_TYPE[a.key]).filter(Boolean),
)

export function buildRootMapModel(report, { answers = {}, dismissedGaps = new Set(), snapshot = {}, mode = 'import' } = {}) {
  // Inspect mode never runs buildReconciliationReport (ADR §(e)) — there is
  // no report, no decisions, no proposed-new entities, ever.
  const lanes = mode === 'inspect'
    ? { hold: [], standard: [] }
    : reportToLanes(report ?? { decisions: [], buckets: {}, readiness: [] })
  const allDecisions = [...lanes.hold, ...lanes.standard]
  const isResolved = (d) => isDecisionResolvedFor(d, answers, dismissedGaps)

  // Groups' roster grouping label reuses fieldUpdate.js's enrichSnapshotRow
  // tier_id -> tierNameById join pattern (ADR §(a)/(b), R5) — the real,
  // already-existing "Age Division" relationship, not an invented Unit join.
  const tierNameById = new Map((snapshot.tiers ?? []).map((t) => [t.id, t.name]))
  // Fixed-event decisions carry no entity_id at all (reconciliationReport.js's
  // addFixedEventDecision mints entityId: null for both creates AND changes —
  // fixedEventDecisionId's real identity is (name, time_block LABEL, days
  // LABELS)). A live anchor_activities row only has time_block_id/day_id, so
  // attributing it needs the same id->label maps enrichSnapshotRow would use
  // if it had an anchor_activities branch (it doesn't).
  const timeBlockNameById = new Map((snapshot.time_blocks ?? []).map((t) => [t.id, t.name]))
  const dayNameById = new Map((snapshot.days_of_operation ?? []).map((d) => [d.id, d.name]))

  function groupLabelFor(entityType, row) {
    if (entityType !== 'groups') return null
    const tierName = row.tier_id != null ? tierNameById.get(row.tier_id) : null
    return tierName ? `Age Division: ${tierName}` : '(no age division)'
  }

  // A row's attributed decision (if any) — by entity_id for every ordinary
  // entity type, or by the fixed-event identity key (name, time-block label,
  // day label) for anchor_activities, whose decisions never carry entityId.
  function attributedDecisionFor(entityType, row, decisions) {
    if (entityType === 'anchor_activities') {
      const timeBlockName = timeBlockNameById.get(row.time_block_id) ?? null
      const dayName = dayNameById.get(row.day_id) ?? null
      return decisions.find((d) =>
        d.entityName === row.name && d.timeBlock === timeBlockName && Array.isArray(d.days) && d.days.includes(dayName),
      )
    }
    return decisions.find((d) => d.entityId != null && d.entityId === row.id)
  }

  function buildRoster(entityType, decisions) {
    if (!entityType) return []
    const liveRows = Array.isArray(snapshot[entityType]) ? snapshot[entityType] : []
    const attributedIds = new Set()
    const live = liveRows.map((row) => {
      const attributed = attributedDecisionFor(entityType, row, decisions)
      let state = 'understood'
      let decisionId = null
      if (attributed) {
        attributedIds.add(attributed.id)
        decisionId = attributed.id
        if (!isResolved(attributed)) {
          state = attributed.kind === 'confirm_change' ? 'changed' : 'attention'
        }
      }
      return { entityId: row.id, name: row.name, state, decisionId, group: groupLabelFor(entityType, row) }
    })

    // A create-shaped decision (confirm_value, entityId: null) whose id was
    // NOT already claimed by a live row above is genuinely proposed-new —
    // true for ordinary entities (entityId is always null for creates) and
    // for anchor_activities alike, now that attribution is tracked by id
    // rather than inferred from entityId being null.
    const proposedNew = decisions
      .filter((d) => d.kind === 'confirm_value' && d.entityId == null && !attributedIds.has(d.id))
      .map((d) => ({
        entityId: null,
        name: d.entityName ?? '(unnamed)',
        state: isResolved(d) ? 'understood' : 'attention',
        decisionId: d.id,
        group: null,
      }))

    return [...live, ...proposedNew]
  }

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
    // Snapshot-driven children (ADR §(a)): a child with live rows but zero
    // decisions (e.g. 30 cleanly-imported activities) must still render a
    // roster — decisions alone under-report which children exist. CHILD_OF
    // caps each domain at ≤3 children regardless, so this never approaches
    // layoutForChild's 5-position hard cap.
    for (const entityType of Object.keys(snapshot)) {
      if (DOMAIN_OF[entityType] !== domainKey) continue
      const key = CHILD_OF[entityType] ?? 'General'
      if (!childGroups.has(key)) childGroups.set(key, [])
    }

    const children = [...childGroups.entries()].map(([childKey, decisions], index) => {
      const pos = layoutForChild(domainKey, childKey, index)
      const entityType = ENTITY_TYPE_FOR_CHILD[childKey]
      // not_set_up (ADR §(d), R3) — required-5 only, caller-assigned before
      // stateOf's decision-based default, from a GENUINELY empty backing
      // table (an array, not the null fetchCensusSnapshot returns when a
      // list() call itself errored — a transient read failure must never
      // read as "nothing set up yet" for a required area).
      const isRequired = Boolean(entityType) && REQUIRED_ENTITY_TYPES.has(entityType)
      const fetchErrored = isRequired
        && Object.prototype.hasOwnProperty.call(snapshot, entityType)
        && snapshot[entityType] == null
      if (fetchErrored) {
        // eslint-disable-next-line no-console -- deliberate: a required-area
        // read failure must be visible, not silently downgraded to "ready".
        console.warn(`buildRootMapModel: census fetch for '${entityType}' failed — not asserting not_set_up`)
      }
      const notSetUp = isRequired
        && !fetchErrored
        && Object.prototype.hasOwnProperty.call(snapshot, entityType)
        && Array.isArray(snapshot[entityType])
        && snapshot[entityType].length === 0

      return {
        key: childKey,
        name: childKey,
        count: decisions.length,
        state: notSetUp ? 'not_set_up' : stateOf(decisions, isResolved),
        x: pos.x,
        y: pos.y,
        decisionIds: decisions.map((d) => d.id),
        roster: notSetUp ? [] : buildRoster(entityType, decisions),
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
