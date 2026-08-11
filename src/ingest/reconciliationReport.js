// buildReconciliationReport — Phase C, slice C1 (the aggregator).
//
// docs/adr/2026-08-10-ingestion-phaseC-compression-layer.md
//
// A pure function: no IO, no DB, no IPC, no React, no clock/random inside.
// Walks plan.items ONCE and readiness ONCE; `buckets` is folded out of the
// SAME classification pass that produces `decisions`, so the two outputs
// cannot drift apart by construction (the ADR's central design point).
//
// C1 scope = ADR rules 1, 2, 3, 4, 6 only. Rule 5 (fixedEventsReport side
// channel, C2a) and rule 7 (legacyPriorityActivities, C2b) are NOT built here
// — see the extension-point comments below for exactly where they plug in.
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

export function buildReconciliationReport(input) {
  const { planItems = [], readiness = [], now = null } = input ?? {}

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

  // C2a extension point: fold in fixedEventsReport.{fixedMoved,fixedPartial,
  // fixedSkipped,fixedCreated,fixedUnchanged} here — a second, parallel
  // classification source per the ADR's rule 5, folding into the same
  // buckets/decisionsByKey structures above.

  // C2b extension point: fold in legacyPriorityActivities here — rule 7,
  // one 'confirm_legacy_priority' decision per row, always needsAttention.

  return {
    buckets,
    decisions: [...decisionsByKey.values()],
    meta: { generatedAt: now, planItemCount: planItems.length },
  }
}
