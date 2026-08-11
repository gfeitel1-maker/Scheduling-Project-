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
// side channel). Rule 7 (legacyPriorityActivities, C2b) is NOT built here —
// see the extension-point comment below for exactly where it plugs in.
// Rule 4's 'human' fieldProvenance branch (C4) is also not built — C1 treats
// every update/clear as routine import refinement.

import { CONFIDENCE } from './confidence.js'

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
// 'understood' | 'needsAttention' (never 'notInSource'/'changed' in C1 — see
// module doc). decision is null when the item does not warrant one.
function classifyItem(item) {
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
        evidence: null,
        reason: item.reason ?? null,
      },
    }
  }

  if (item.op === 'update' || item.op === 'clear') {
    // C4 extension point: when fieldProvenance says a field's live value is
    // 'human'-sourced, that field forces a 'confirm_change'/CHANGED decision
    // regardless of tier. C1 has no fieldProvenance input, so every field here
    // falls through to the same HIGH/MEDIUM/LOW routing as 'create'.
    const confidence = tierToConfidence(item.evidence?.tier)
    if (confidence === CONFIDENCE.HIGH) return { outcome: 'understood', decision: null }
    const fields = Object.keys(item.fields ?? {})
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
        evidence: null,
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
function fixedEventDecisionId(kind, reason, name) {
  return `anchor_activities:null:${kind}:${reason}:${name ?? ''}`
}

function addFixedEventDecision(decisionsByKey, { kind, confidence, name, reason }) {
  const id = fixedEventDecisionId(kind, reason, name)
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
    evidence: null,
    reason: reason ?? null,
  })
}

// Destructuring defaults only cover `undefined`, not `null` — a caller
// passing an explicit null field (e.g. { moved: null }) must not throw.
function asArray(value) {
  return Array.isArray(value) ? value : []
}

export function buildReconciliationReport(input) {
  const {
    planItems = [], readiness = [], now = null, fixedEventsReport = {},
    legacyPriorityActivities = [],
  } = input ?? {}

  const buckets = { understood: 0, needsAttention: 0, notInSource: 0, changed: 0 }
  const decisionsByKey = new Map() // dedup-by-root-cause: (entity, entityId) -> merged decision

  for (const item of planItems) {
    const { outcome, decision } = classifyItem(item)
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
    if (Array.isArray(existing.field) && Array.isArray(decision.field)) {
      existing.field = [...new Set([...existing.field, ...decision.field])]
    }
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
    })
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
    })
  }

  // skipped/rejected: explicitly excluded per ADR rule 5 — import-run
  // diagnostics only. skipped never got far enough to become an entity;
  // rejected is a director-tombstoned slot re-encountered on reimport, and
  // re-surfacing it as a fresh decision would re-litigate a settled choice.
  void skipped
  void rejected

  buckets.understood += asArray(created).length + asArray(unchanged).length

  // C2b, rule 7. Owner-resolved OQ3 (ADR "Resolved 2026-08-11"): BATCH — one
  // consolidated "N priorities need review" decision, never one-per-activity.
  // source='import' cannot distinguish a manufactured default from a
  // director-typed value from an accepted-conflict value (all stored
  // identically), so Shoresh surfaces the whole set for review rather than
  // proposing any value — proposedValue stays null, this is never a clear.
  const legacySet = asArray(legacyPriorityActivities)
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

  return {
    buckets,
    decisions: [...decisionsByKey.values()],
    meta: { generatedAt: now, planItemCount: planItems.length },
  }
}
