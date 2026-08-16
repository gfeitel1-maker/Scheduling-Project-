// confirmAlias — the single writer of source_aliases (S1b, host-local).
//
// docs/adr/2026-08-09-s1b-host-local-aliases.md §2.
//
// Sibling to commitPlan (electron/ops/ingest.js), same architectural shape —
// one db.transaction(), host-only, admin-gated at the IPC boundary — but with
// NO appendOp call: source_aliases is never replicated and never replayed, so
// this is a direct, transactional SQL write, the same pattern
// electron/auth/localAuth.js's ensureHostSigningKey uses for host_signing_key.

import { randomUUID } from 'node:crypto'
import { INGESTIBLE_ENTITIES, COHORT_SCOPED } from './ingest.js'
import { normalizeName } from '../../src/ingest/preview.js'

// The same entity_type -> table map ingest.js's listAliasMap reads against —
// FIXED, never string-built from input, since entity_type is
// attacker-influenced (sourced from the imported file). Kept as its own copy
// here (not imported) so a change to ingest.js's private map cannot silently
// change what this write boundary accepts; both are asserted equal by
// confirmAlias.test.js.
const ALIAS_ENTITY_TABLE = Object.freeze({
  cohorts: 'cohorts',
  tiers: 'tiers',
  groups: 'groups',
  days_of_operation: 'days_of_operation',
  time_blocks: 'time_blocks',
  locations: 'locations',
  activities: 'activities',
})

export class ConfirmAliasError extends Error {
  constructor(reason, detail) {
    super(`confirmAlias: ${reason}`)
    this.reason = reason
    this.detail = detail ?? null
  }
}

/**
 * Confirm that `source_label` (as it appeared in an imported file) means
 * `entity_id` (a live row of `entity_type`). Validated BEFORE any DB access
 * (ADR §3): entity_type must be one of the six ingestible types, and
 * cohort_id may be present only for the two cohort-scoped types.
 *
 * Re-confirming the same scope key to a different target supersedes the
 * prior active row (status='superseded', superseded_by = new id) and inserts
 * a fresh active row — both inside the SAME transaction, so no partial state
 * is ever observable (ADR §1, completion evidence #3).
 *
 * A target that is not a LIVE row (Trashed or never existed) is refused. A
 * target with activities.is_locked set is surfaced rather than silently
 * bound (ADR §6) — the caller decides whether to proceed.
 *
 * @returns {{ id: string, superseded: string|null }}
 */
export function confirmAlias(db, { camp_id, entity_type, cohort_id = null, source_label, entity_id, confirmed_by = null }) {
  if (!camp_id) throw new ConfirmAliasError('camp_id_required')
  if (!INGESTIBLE_ENTITIES.includes(entity_type)) {
    throw new ConfirmAliasError('invalid_entity_type', { entity_type })
  }
  if (cohort_id && !COHORT_SCOPED.has(entity_type)) {
    throw new ConfirmAliasError('cohort_id_not_allowed', { entity_type })
  }
  const label = String(source_label ?? '').trim()
  if (!label) throw new ConfirmAliasError('source_label_required')
  if (!entity_id) throw new ConfirmAliasError('entity_id_required')

  const table = ALIAS_ENTITY_TABLE[entity_type]

  const run = db.transaction(() => {
    const target = db.prepare(`SELECT * FROM ${table} WHERE id = ? AND camp_id = ?`).get(entity_id, camp_id)
    if (!target) throw new ConfirmAliasError('target_not_live', { entity_type, entity_id })
    if (entity_type === 'activities' && target.is_locked) {
      throw new ConfirmAliasError('target_locked', { entity_type, entity_id })
    }

    const scopedCohortId = COHORT_SCOPED.has(entity_type) ? (cohort_id ?? null) : null
    const normalized = normalizeName(label)

    // The scope key is (camp_id, entity_type, cohort_id, normalizeName(label))
    // among status='active' rows — read-then-write inside this one
    // transaction is safe because there is exactly one writer of this table
    // (ADR §1).
    const activeRows = db
      .prepare(
        `SELECT id, entity_id, source_label FROM source_aliases
          WHERE camp_id = ? AND entity_type = ? AND status = 'active' AND cohort_id IS ?`
      )
      .all(camp_id, entity_type, scopedCohortId)
    const existing = activeRows.find((r) => normalizeName(r.source_label) === normalized)

    const newId = randomUUID()
    const now = new Date().toISOString()
    let supersededId = null

    if (existing && existing.entity_id !== entity_id) {
      db.prepare(`UPDATE source_aliases SET status = 'superseded', superseded_by = ? WHERE id = ?`).run(newId, existing.id)
      supersededId = existing.id
    } else if (existing && existing.entity_id === entity_id) {
      // Re-confirming the SAME label to the SAME target is a no-op — return
      // the existing active row rather than minting a redundant duplicate.
      return { id: existing.id, superseded: null }
    }

    db.prepare(
      `INSERT INTO source_aliases (id, camp_id, entity_type, cohort_id, source_label, entity_id, status, confirmed_by, confirmed_at)
       VALUES (?, ?, ?, ?, ?, ?, 'active', ?, ?)`
    ).run(newId, camp_id, entity_type, scopedCohortId, label, entity_id, confirmed_by ?? null, now)

    return { id: newId, superseded: supersededId }
  })

  return run()
}
