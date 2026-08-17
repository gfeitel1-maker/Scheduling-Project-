// buildReconciliationReport — Phase C, slice C1 (the aggregator).
//
// docs/adr/2026-08-10-ingestion-phaseC-compression-layer.md
//
// A pure function: no IO, no DB, no IPC, no React, no clock/random inside.
// Walks plan.items ONCE and readiness ONCE; `buckets` is folded out of the
// SAME classification pass that produces `decisions`, so the two outputs
// cannot drift apart by construction (the ADR's central design point).
//
// C1 scope = ADR rules 1, 2, 3, 4, 6. C2a (below) adds rule 5 (fixedEventsReport
// side channel). C2b (below) adds rule 7 (legacyPriorityActivities). C4 (below)
// adds rule 4's 'human' fieldProvenance branch: an update/clear delta on a
// director-confirmed field is CHANGED regardless of tier.

import { CONFIDENCE } from './confidence.js'
import { normalizeName } from './preview.js'

// C1 has no numeric "strength" to classify (identity tiers are categorical,
// not scored), so this maps buildPlan's evidence.tier vocabulary onto
// CONFIDENCE directly, once, for every op that reuses the HIGH/MEDIUM/LOW
// bucketing rule (create + update/clear when fieldProvenance is absent/import).
// A missing/absent tier defaults to the SAFEST bucket (LOW) rather than
// throwing or silently treating it as HIGH — an unrecognized tier must always
// surface for review, never auto-pass as understood.
const HIGH_IDENTITY_TIERS = new Set(['new', 'exact_name', 'uuid', 'confirmed_alias'])

function tierToConfidence(tier) {
  if (tier === CONFIDENCE.MEDIUM) return CONFIDENCE.MEDIUM
  if (tier === CONFIDENCE.LOW) return CONFIDENCE.LOW
  if (HIGH_IDENTITY_TIERS.has(tier)) return CONFIDENCE.HIGH
  // classifyConfidence exists for numeric-strength sites; here we only need
  // its vocabulary as the fallback landing spot for an unrecognized tier.
  return CONFIDENCE.LOW
}

// update/clear items always carry a real entity_id (buildPlan sets
// entity_id: match.id on every update/clear arm) — those key by (entity,
// entityId) alone, which is the genuine dedup-by-root-cause case (N field
// deltas on the same row collapse to one decision).
//
// create/conflict items never have an entity_id (buildPlan emits entity_id:
// null on every create/conflict arm) — keying those by (entity, null,
// reason) alone collapsed DIFFERENT rows sharing an entity+reason into one
// decision, silently dropping the second row (round-2 HIGH finding). Each
// create/conflict is inherently one-row-one-decision, never a cross-row
// dedup case, so the key must include a per-row discriminator. `_name` is
// populated on every buildPlan create/conflict arm, so it's used here.
function decisionId(entity, entityId, reason, name) {
  return entityId != null
    ? `${entity}:${entityId}`
    : `${entity}:null:${reason}:${name ?? ''}`
}

// Classifies one plan item. Returns { outcome, decision } where outcome is
// 'understood' | 'needsAttention' | 'changed' (the last only reachable via
// C4's fieldProvenance branch below; 'notInSource' is never produced here —
// see module doc). decision is null when the item does not warrant one.
//
// fieldProvenance is a caller-supplied Map<"entity:entityId:field", 'human'
// | 'import'> (ADR C4, OQ2 resolved EXTRACT — see buildFieldProvenanceMap in
// electron/ops/ingest.js). A missing/undefined map means every lookup misses,
// so every field is treated as non-human — this is what makes C4 additive:
// callers that don't pass fieldProvenance get byte-identical C1 output.
//
// CONTRACT: on a REAL import, the caller MUST build this map via
// buildFieldProvenanceMap and pass it through. Omitting it does not error —
// it silently degrades to pre-C4 classification, meaning a delta on a
// director-confirmed field is treated as routine and never surfaces a
// CHANGED decision. That is intentional (additive degradation is the spec),
// but it makes it a data-safety obligation the CALLER owns, not this
// function — see buildFieldProvenanceMap's own contract comment.
// D3: activities join their support by entity_id (the same handle planItems
// carry as item.entity_id); a decision with no entity_id (create/conflict —
// buildPlan mints entity_id: null for both) has nothing to join against and
// stays null, honestly. activityEvidence defaults to {} so an omitted
// evidenceSupport degrades to null everywhere, matching fieldProvenance's
// contract.
function activitySupportFor(item, activityEvidence) {
  if (item.entity !== 'activities' || item.entity_id == null) return null
  return activityEvidence[item.entity_id] ?? null
}

function classifyItem(item, fieldProvenance, activityEvidence) {
  if (item.op === 'conflict') {
    return {
      outcome: 'needsAttention',
      decision: {
        id: decisionId(item.entity, item.entity_id, item.reason, item._name),
        kind: 'resolve_conflict',
        entity: item.entity,
        entityId: item.entity_id ?? null,
        entityName: item._name ?? null,
        field: null,
        confidence: 'conflict',
        proposedValue: null, // a conflict has no single proposed value by definition
        unknowns: [], // C1 does not build UNKNOWN-field detection — deferred, see module doc
        evidence: null, // extension point (Phase D / C-caller): dereference via listImportEvidence
        reason: item.reason,
      },
    }
  }

  if (item.op === 'unchanged') {
    return { outcome: 'understood', decision: null }
  }

  if (item.op === 'create') {
    const confidence = tierToConfidence(item.evidence?.tier)
    if (confidence === CONFIDENCE.HIGH) return { outcome: 'understood', decision: null }
    return {
      outcome: 'needsAttention',
      decision: {
        id: decisionId(item.entity, item.entity_id, 'create', item._name),
        kind: 'confirm_value',
        entity: item.entity,
        entityId: item.entity_id ?? null,
        entityName: item._name ?? null,
        field: null, // whole-row decision (a fresh row, not one changed field) — no single proposedValue
        confidence,
        proposedValue: null,
        unknowns: [], // C1 does not build UNKNOWN-field detection — deferred, see module doc
        evidence: activitySupportFor(item, activityEvidence),
        reason: item.reason ?? null,
      },
    }
  }

  if (item.op === 'update' || item.op === 'clear') {
    const allFields = Object.keys(item.fields ?? {})
    // C4, ADR rule 4: a field whose live value is 'human'-sourced means this
    // delta overwrites a director's confirmed value — CHANGED, always a
    // decision, regardless of the item's identity-confidence tier. Multiple
    // human fields on the same row fold into ONE confirm_change decision
    // (dedup-by-root-cause), not one per field.
    const humanFields = allFields.filter(
      (f) => fieldProvenance?.get(`${item.entity}:${item.entity_id}:${f}`) === 'human',
    )
    if (humanFields.length > 0) {
      // MIXED-row design choice: a row with both human and import fields
      // lists only the human fields in `field`/`proposedValue`. Those are the
      // director-set values actually at stake — the case rule 4/D5 exists to
      // surface — while the riding-along import refinement isn't itself a
      // judgment call. One row still yields exactly one decision (dedup).
      const proposedValue = humanFields.length === 1
        ? item.fields[humanFields[0]].to
        : Object.fromEntries(humanFields.map((f) => [f, item.fields[f].to]))
      return {
        outcome: 'changed',
        decision: {
          id: decisionId(item.entity, item.entity_id, item.op, item._name),
          kind: 'confirm_change',
          entity: item.entity,
          entityId: item.entity_id ?? null,
          entityName: item._name ?? null,
          field: humanFields,
          confidence: 'changed',
          proposedValue,
          unknowns: [],
          evidence: activitySupportFor(item, activityEvidence),
          reason: item.reason ?? null,
        },
      }
    }

    // No human-provenance field on this row (or no fieldProvenance input at
    // all) — routine refinement of a previously-inferred value. Falls through
    // to the same HIGH/MEDIUM/LOW classification 'create' above uses.
    const confidence = tierToConfidence(item.evidence?.tier)
    if (confidence === CONFIDENCE.HIGH) return { outcome: 'understood', decision: null }
    const fields = allFields
    // Single field -> its proposed value directly (matches ADR's field-level
    // decision shape). Multiple fields on one row -> a field->value map, since
    // one scalar can't represent N proposed values on a single decision.
    const proposedValue = fields.length === 1
      ? item.fields[fields[0]].to
      : Object.fromEntries(fields.map((f) => [f, item.fields[f].to]))
    return {
      outcome: 'needsAttention',
      decision: {
        id: decisionId(item.entity, item.entity_id, item.op, item._name),
        kind: 'confirm_value',
        entity: item.entity,
        entityId: item.entity_id ?? null,
        entityName: item._name ?? null,
        field: fields, // dedup-by-root-cause: one decision per row, every changed field listed
        confidence,
        proposedValue,
        unknowns: [], // C1 does not build UNKNOWN-field detection — deferred, see module doc
        evidence: activitySupportFor(item, activityEvidence),
        reason: item.reason ?? null,
      },
    }
  }

  // No other op exists in buildPlan.js today; treat unrecognized ops as
  // understood rather than throw, matching the "never manufacture surprise
  // decisions" discipline — but this branch should be unreachable.
  return { outcome: 'understood', decision: null }
}

// C2a: moved/partial entries carry a name+reason, no entity_id — same
// dedup-by-root-cause key shape as create/conflict above, qualified by kind
// so a confirm_change and a confirm_value sharing (reason, name) never merge.
function fixedEventDecisionId(kind, reason, name, timeBlock, days) {
  // Full key shape is `entity:entityId:kind:reason:name:timeBlock:days` where
  // entity is the literal 'anchor_activities' and entityId is the literal
  // null (fixed-event decisions carry no entity_id). reason/name/timeBlock
  // are `?? ''`-guarded so a missing segment collapses to empty rather than
  // interpolating 'undefined'. The timeBlock/days discriminator (A1, Red Hat
  // 2026-08-17) mirrors ImportScreen.jsx's fixedEventKey — without it, two
  // same-named anchors on different days/time-blocks collapse into one
  // decision and the second's identity is silently discarded.
  const daysKey = Array.isArray(days) ? days.join(',') : (days ?? '')
  return `anchor_activities:null:${kind}:${reason ?? ''}:${name ?? ''}:${timeBlock ?? ''}:${daysKey}`
}

// D3: fixed-event decisions carry no entity_id (see fixedEventDecisionId) —
// their join handle is the event's own name. fixedEventEvidence defaults to
// {} at the call site, so an omitted evidenceSupport degrades to null here
// too.
function addFixedEventDecision(
  decisionsByKey,
  { kind, confidence, name, reason, timeBlock, days, from, to },
  fixedEventEvidence,
) {
  const id = fixedEventDecisionId(kind, reason, name, timeBlock, days)
  // `decisionsByKey.has(id)` above already dedups multiple fixedEventsReport
  // entries sharing (kind, reason, name, timeBlock, days) down to ONE
  // decision (round-2 fix's dedup-by-root-cause, extended by A1's
  // day/time-block discriminator) — this early return means only the FIRST
  // entry's lookup runs, so evidence granularity intentionally matches that
  // same name-level dedup: one decision, one evidence lookup by name, not a
  // per-entry one. Not a bug if a later entry's support differs; it never
  // reaches here to be considered.
  if (decisionsByKey.has(id)) return
  decisionsByKey.set(id, {
    id,
    kind,
    entity: 'anchor_activities',
    entityId: null,
    entityName: name ?? null,
    field: null,
    confidence,
    proposedValue: null,
    unknowns: [],
    evidence: fixedEventEvidence?.[name] ?? null,
    reason: reason ?? null,
    // A1 / sub-slice 4 — carried onto the decision itself (not just baked
    // into `id`) so a consumer (reconciliationResolutions.js's fixed-event
    // hold-back) can match a decision back to its source fixedEvents[] entry
    // by (name, timeBlock, days) without parsing the id string.
    timeBlock: timeBlock ?? null,
    days: Array.isArray(days) ? days : [],
    // F2 (ADR §4): optional structured from/to, additive — a caller that
    // doesn't supply them (every non-moved/scopeChanged kind, or a fixture
    // written before this change) gets undefined, which the UI must render
    // as "no structured from/to", never a stringified null/undefined.
    from,
    to,
  })
}

// Destructuring defaults only cover `undefined`, not `null` — a caller
// passing an explicit null field (e.g. { moved: null }) must not throw.
function asArray(value) {
  return Array.isArray(value) ? value : []
}

// Round-2 FIX 2: a truthy fieldProvenance that is NOT a Map fails loud here,
// at the boundary, rather than throwing a confusing TypeError deep inside
// classifyItem's `fieldProvenance?.get(...)` call. null/undefined/absent
// still degrade silently to pre-C4 output — that's the additive-degradation
// property classifyItem's doc comment describes, and this check must not
// break it: only a truthy non-Map value is rejected.
function assertFieldProvenanceShape(fieldProvenance) {
  if (fieldProvenance == null) return
  if (fieldProvenance instanceof Map) return
  throw new Error(
    `fieldProvenance must be a Map<string,'human'|'import'>; got ${typeof fieldProvenance}`,
  )
}

// Round-2 FIX 1: merge-collision stakes ordering. When two decisions land on
// the same (entity, entityId) key, a merge must never DOWNGRADE stakes —
// 'confirm_change' (a director's confirmed value is being overwritten)
// always dominates 'confirm_value' (a routine review prompt), regardless of
// arrival order. Losing that upgrade would let buckets.changed count a
// CHANGED fact while the surfaced decision silently reverts to
// confirm_value, hiding the human field + its proposedValue — the exact
// drift the ADR's "buckets and decisions cannot drift apart" promise rules
// out. 'resolve_conflict' is left out of this ordering: a conflict has no
// entity_id (see decisionId), so it can never collide with an update/clear
// decision under today's keying.
function mergeDecisions(existing, incoming) {
  const existingWins = existing.kind === 'confirm_change'
  const changeWins = incoming.kind === 'confirm_change'
  const winner = changeWins && !existingWins ? incoming : existing
  const loser = winner === existing ? incoming : existing

  const mergedField = Array.isArray(winner.field) && Array.isArray(loser.field)
    ? [...new Set([...winner.field, ...loser.field])]
    : winner.field

  // proposedValue must track `field`'s own shape contract (see classifyItem:
  // "single field -> scalar; multiple fields -> field->value map"), NOT which
  // kinds are on each side. Round-2 FIX: the earlier version only combined
  // into a map when BOTH sides were confirm_change, so a mixed confirm_change
  // + confirm_value merge with different fields grew `field` to length > 1
  // while `proposedValue` stayed the winner's bare scalar — silently
  // dropping the loser's value. A side with no field-keyed value (a
  // whole-row decision or a conflict, field: null) contributes nothing.
  const valueMapOf = (side) => {
    if (!Array.isArray(side.field)) return {}
    return side.field.length === 1
      ? { [side.field[0]]: side.proposedValue }
      : { ...(side.proposedValue ?? {}) }
  }
  let mergedProposedValue = winner.proposedValue
  if (Array.isArray(mergedField)) {
    const combined = { ...valueMapOf(loser), ...valueMapOf(winner) }
    mergedProposedValue = mergedField.length === 1 ? combined[mergedField[0]] : combined
  }

  return { ...winner, field: mergedField, proposedValue: mergedProposedValue }
}

// R2'a additive input (docs/adr/2026-08-17-onescreen-reconciliation-projection.md,
// Seam 2 gap fix / Consequences). Same key scheme buildBlastRadiusIndex
// (src/ingest/blastRadius.js) produces: a real entity_id keys as
// `entity:entityId`; a decision with no entity_id (create/conflict/batch)
// keys as `entity:name:normalizedName`, matching the synthetic create key
// blastRadiusIndex uses for a not-yet-committed row. blastRadiusIndex
// defaults to an empty Map, so every lookup misses and decision.blastRadius
// is 0 for every decision — the same additive-degradation contract
// fieldProvenance/evidenceSupport already use.
function blastRadiusKeyFor(entity, entityId, entityName) {
  return entityId != null
    ? `${entity}:${entityId}`
    : `${entity}:name:${normalizeName(String(entityName ?? ''))}`
}

export function buildReconciliationReport(input) {
  const {
    planItems = [], readiness = [], now = null, fixedEventsReport = {},
    legacyPriorityActivities = [], fieldProvenance = null,
    // D3: the dry-run's real support objects (electron/ops/ingest.js's
    // evidenceSupportActivities/evidenceSupportFixedEvents, reused verbatim,
    // never recomputed here). Shape: { activities: { [entity_id]: support },
    // fixedEvents: { [name]: support } }. Omitted (or a decision with no
    // matching entry) leaves decision.evidence at its honest null default —
    // this is the same additive-degradation contract fieldProvenance uses.
    evidenceSupport = {},
    blastRadiusIndex = new Map(),
  } = input ?? {}
  const { activities: activityEvidence = {}, fixedEvents: fixedEventEvidence = {} } = evidenceSupport ?? {}

  assertFieldProvenanceShape(fieldProvenance)

  const buckets = { understood: 0, needsAttention: 0, notInSource: 0, changed: 0 }
  const decisionsByKey = new Map() // dedup-by-root-cause: (entity, entityId) -> merged decision

  for (const item of planItems) {
    const { outcome, decision } = classifyItem(item, fieldProvenance, activityEvidence)
    buckets[outcome] += 1
    if (!decision) continue

    const existing = decisionsByKey.get(decision.id)
    if (!existing) {
      decisionsByKey.set(decision.id, decision)
      continue
    }
    // Same row already produced a decision (shouldn't happen within a single
    // planItems walk today — one buildPlan item per entity — but the merge
    // is defined so a future multi-item-per-row source folds correctly).
    // See mergeDecisions above: CHANGED always dominates on merge, never lost.
    decisionsByKey.set(decision.id, mergeDecisions(existing, decision))
  }

  // Rule 6: readiness rows with state 'optional' contribute to notInSource
  // ONLY — zero decisions, by design (see ADR "Bucketing" rule 6).
  for (const row of readiness) {
    if (row.state === 'optional') buckets.notInSource += 1
  }

  // Rule 5: fixedEventsReport is a second, parallel classification source
  // (not reachable via planItems), folded into the same buckets/
  // decisionsByKey structures above. buckets fold over every fact SEEN
  // (mirrors how buckets fold over every planItem above), while decisions
  // dedup by root cause — so two identical moved entries count as 2 in
  // buckets.changed but collapse to 1 decision, same as create/conflict.
  //
  // Field names below are ingest.js's real, unprefixed output shape
  // (electron/ops/ingest.js:1220-1227, `fixedEvents: { created, unchanged,
  // skipped, partial, rejected, moved }`) — the ADR pseudocode's prefixed
  // names (fixedMoved etc.) were a documentation slip, corrected alongside
  // this fix.
  const {
    moved = [],
    partial = [],
    skipped = [],
    created = [],
    unchanged = [],
    rejected = [],
    scopeChanged = [],
  } = fixedEventsReport ?? {}

  for (const entry of asArray(moved)) {
    buckets.changed += 1
    addFixedEventDecision(decisionsByKey, {
      kind: 'confirm_change',
      // ADR's confidence enum is closed but silent on which of its values a
      // confirm_change decision carries; 'changed' is the documented 5th
      // member (see ADR line ~139) — a move is a confirmed fact, not a
      // 'conflict', so it needs its own distinct marker.
      confidence: 'changed',
      name: entry.name,
      reason: entry.reason,
      timeBlock: entry.time_block,
      days: entry.days,
      from: entry.from,
      to: entry.to,
    }, fixedEventEvidence)
  }

  // C3: a group-scope drift is a confirmed CHANGED fact on an existing
  // anchor slot, same category as a move — CHANGED bucket, confirm_change
  // decision, 'changed' confidence, read-only (never auto-applied, never
  // proposes a value). electron/ops/ingest.js:1256 pushes { name, reason }
  // onto fixedScopeChanged; :1347 attaches it as fixedEvents.scopeChanged.
  // Folded identically to `moved` above — same addFixedEventDecision call,
  // same kind, so dedup/no-double-count works via the existing
  // (entity, entityId=null, kind, reason, name) key with no parallel dedup path.
  // docs/adr/2026-08-10-ingestion-phaseC-compression-layer.md, C3.
  for (const entry of asArray(scopeChanged)) {
    buckets.changed += 1
    addFixedEventDecision(decisionsByKey, {
      kind: 'confirm_change',
      confidence: 'changed',
      name: entry.name,
      reason: entry.reason,
      timeBlock: entry.time_block,
      days: entry.days,
      from: entry.from,
      to: entry.to,
    }, fixedEventEvidence)
  }

  for (const entry of asArray(partial)) {
    buckets.needsAttention += 1
    addFixedEventDecision(decisionsByKey, {
      kind: 'confirm_value',
      // ADR is silent on confidence here too; 'low' matches the safest-
      // default fallback tierToConfidence uses for an untiered value.
      confidence: 'low',
      name: entry.name,
      reason: entry.reason,
      timeBlock: entry.time_block,
      days: entry.days,
    }, fixedEventEvidence)
  }

  // skipped/rejected: explicitly excluded per ADR rule 5 — import-run
  // diagnostics only. skipped never got far enough to become an entity;
  // rejected is a director-tombstoned slot re-encountered on reimport, and
  // re-surfacing it as a fresh decision would re-litigate a settled choice.
  void skipped
  void rejected

  // FIX 1 (2026-08-17 fix round, Red Hat RISK 1): a FULLY-RESOLVED fixed
  // event (no shortfall — it never touched the `partial` branch above) can
  // still be sub-majority evidence (fe.confidence === 'low', e.g. 1 of
  // several eligible groups actually observed it). Before this fix that
  // wrote silently — `created` only ever counted toward `understood`, with
  // no confidence gate, unlike every other create path in this module. Route
  // a low-confidence created entry through the SAME confirm_value +
  // addFixedEventDecision path `partial` uses, so §3's hold-back (keyed by
  // name/timeBlock/days) gates it exactly like a partial one. A high-
  // confidence entry (or one with no confidence info at all — pre-existing
  // fixtures/callers) ships unconditionally, unchanged from before.
  for (const entry of asArray(created)) {
    if (entry?.confidence === 'low') {
      buckets.needsAttention += 1
      addFixedEventDecision(decisionsByKey, {
        kind: 'confirm_value',
        confidence: 'low',
        name: entry.name,
        reason: entry.reason ?? 'Only some groups showed this pattern in the file — confirm before creating it.',
        timeBlock: entry.time_block,
        days: entry.days,
      }, fixedEventEvidence)
    } else {
      buckets.understood += 1
    }
  }
  buckets.understood += asArray(unchanged).length

  // C2b, rule 7. Owner-resolved OQ3 (ADR "Resolved 2026-08-11"): BATCH — one
  // consolidated "N priorities need review" decision, never one-per-activity.
  // source='import' cannot distinguish a manufactured default from a
  // director-typed value from an accepted-conflict value (all stored
  // identically), so Shoresh surfaces the whole set for review rather than
  // proposing any value — proposedValue stays null, this is never a clear.
  // Defensive filter: a row that can't identify its activity (no entity_id)
  // can't be reviewed against anything, so it's dropped rather than surfaced
  // as a phantom row in the batch. Never throws on malformed input.
  const legacySet = asArray(legacyPriorityActivities).filter((a) => a?.entity_id != null)
  if (legacySet.length > 0) {
    buckets.needsAttention += 1
    decisionsByKey.set('activities:legacy_priority', {
      id: 'activities:legacy_priority',
      kind: 'review_legacy_priority',
      entity: 'activities',
      entityId: null,
      entityName: null,
      field: 'priority',
      confidence: 'low', // a pre-B2 value was never actually judged
      proposedValue: null, // review prompt, not a proposed change — never an auto-clear
      count: legacySet.length,
      activities: legacySet.map((a) => ({ entityId: a.entity_id, name: a.name })),
      unknowns: [],
      evidence: null,
      reason: 'These activities carry an import-sourced priority from before Shoresh stopped '
        + 'inferring priority automatically. Shoresh cannot tell whether each value is a leftover '
        + 'manufactured default, a value you typed into the workbook, or a value you accepted while '
        + 'resolving an earlier conflict — review each one and confirm or change it.',
    })
  }

  const decisions = [...decisionsByKey.values()].map((decision) => ({
    ...decision,
    blastRadius: blastRadiusIndex.get(
      blastRadiusKeyFor(decision.entity, decision.entityId, decision.entityName),
    ) ?? 0,
  }))

  return {
    buckets,
    decisions,
    // R2'a fix: additively expose the raw readiness rows (see readiness.js's
    // `{ key, label, screen, kind, state, message? }` shape) so a consumer
    // like reportToLanes can compute a real "required area unsatisfied" gate
    // instead of only inferring it from lane emptiness. Safe default ([])
    // when the caller omits readiness — same additive-degradation contract
    // fieldProvenance/evidenceSupport/blastRadiusIndex already use; existing
    // callers that ignore this field see byte-identical buckets/decisions.
    readiness,
    meta: { generatedAt: now, planItemCount: planItems.length },
  }
}
