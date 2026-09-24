// Writing derived conflicts into the `conflicts` table — the bridge between
// reconcile.js (which derives them from the document) and the ConflictsScreen
// the director already has.
//
// docs/adr/2026-09-08-crdt-conflict-reconciliation.md. Nothing here is new UI
// or a new table: the op-log wrote these same rows on a conflicting appendOp,
// and `ConflictsScreen`'s FIELD_LABELS already carries
// `template_slots.activity_id` -> "Which activity is in a cell", i.e. the exact
// case a director hits. This is a new producer for machinery that already
// exists and was already written for a non-technical reader.
//
// IDEMPOTENCE IS THE WHOLE JOB. Conflicts are DERIVED, so the same conflict is
// re-derived on every projection until a human resolves it — every merge, every
// restart, on every device. Writing a row per derivation would give a director
// the same disagreement forty times. So a pending row for
// (entity, entity_id, field) is written once and left alone until resolved.
import { randomUUID } from 'node:crypto'

// Deterministic id per unresolved disagreement. Not random: two devices derive
// the SAME conflict from the same document, and a random id would make them
// two different rows that a director would see (and have to dismiss) twice.
// Resolution is per (entity, entity_id, field), so that is the identity.
function conflictKey(entity, entityId, field) {
  return `crdt:${entity}:${entityId}:${field}`
}

/**
 * Record every conflict `reconcile` derived, skipping any already pending.
 * Returns the rows actually inserted, which is what a caller logs or counts —
 * usually zero, because a conflict is normally already known by the second time
 * a document is projected.
 */
export function recordConflicts(db, conflicts, { now = () => new Date().toISOString() } = {}) {
  if (!conflicts || conflicts.length === 0) return []
  const existing = db.prepare(
    'SELECT id FROM conflicts WHERE entity = ? AND entity_id = ? AND field = ? AND resolved_at IS NULL'
  )
  const insert = db.prepare(
    `INSERT OR IGNORE INTO conflicts (id, entity, entity_id, field, incoming_op, existing_op, existing_op_id, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
  )
  const inserted = []
  const run = db.transaction(() => {
    for (const c of conflicts) {
      if (existing.get(c.entity, c.entityId, c.field)) continue
      // `incoming_op`/`existing_op` are the shapes ConflictsScreen already
      // renders (it reads `.value` off each side). Under the op-log these were
      // whole ops; under the CRDT the meaningful content is the two competing
      // values, so that is what is carried. `values` is ordered deterministically
      // by reconcile, so both devices label the same side "existing".
      const [first, second] = c.values
      const id = conflictKey(c.entity, c.entityId, c.field)
      insert.run(
        id,
        c.entity,
        c.entityId,
        c.field,
        JSON.stringify({ value: second?.value ?? null, op_id: second?.opId ?? null }),
        JSON.stringify({ value: first?.value ?? null, op_id: first?.opId ?? null }),
        first?.opId ?? randomUUID(),
        now()
      )
      inserted.push({ id, entity: c.entity, entityId: c.entityId, field: c.field })
    }
  })
  run()
  return inserted
}

/**
 * Close out any pending row whose disagreement is no longer in the document —
 * because a human chose, or because the same choice arrived from another
 * device. Resolution clears by the same mechanism that surfaced it: nothing is
 * broadcast, and a device that was offline throughout still ends up correct,
 * because the answer is derived from the document it eventually receives.
 */
export function clearResolvedConflicts(db, conflicts, { now = () => new Date().toISOString() } = {}) {
  const live = new Set((conflicts ?? []).map((c) => conflictKey(c.entity, c.entityId, c.field)))
  // Scoped to rows THIS path wrote. While both engines coexist, the op-log
  // writes its own conflict rows with random ids from a completely different
  // mechanism; a document-derived "it isn't in the doc any more" says nothing
  // about those, and auto-resolving one would dismiss a real disagreement a
  // director never saw.
  const pending = db
    .prepare("SELECT id FROM conflicts WHERE resolved_at IS NULL AND id LIKE 'crdt:%'")
    .all()
  const stale = pending.filter((r) => !live.has(r.id))
  if (stale.length === 0) return []
  const update = db.prepare('UPDATE conflicts SET resolved_at = ? WHERE id = ?')
  const at = now()
  const run = db.transaction(() => {
    for (const r of stale) update.run(at, r.id)
  })
  run()
  return stale.map((r) => r.id)
}

// ---------------------------------------------------------------------------
// HARD-SET UNIQUE collisions (docs/adr/2026-09-23-merge-unique-collision-schema-and-conflict-shape.md,
// Decision 1). Parallel to the pair above rather than a generalization of it: a hard-set
// collision is "two whole records share one scoped value", not "one field has two values", and
// forcing the two into one function would corrupt the scalar rows' shape (single `entity_id`,
// single-value `incoming_op`/`existing_op`). Rows here live under the `unique:` id namespace so
// the two sweeps below never touch each other's rows.
//
// Deterministic id per unresolved collision, keyed by (entity, scope, field) rather than by the
// colliding ids themselves — like `conflictKey` above, this is what makes two devices agree on
// one row instead of two, and lets the same row keep identifying "this scope+field's collision"
// even if the set of colliding ids it names later changes.
function uniqueConflictKey(entity, scopeId, field) {
  return `unique:${entity}:${scopeId}:${field}`
}

/**
 * Record every hard-set collision `deriveUniqueConflicts` found, skipping any already pending —
 * same idempotence rule as `recordConflicts`: this is re-derived every merge, so a pending row is
 * written once and left alone until the collision clears from the document.
 */
export function recordUniqueConflicts(db, conflicts, { now = () => new Date().toISOString() } = {}) {
  if (!conflicts || conflicts.length === 0) return []
  const existing = db.prepare('SELECT id FROM conflicts WHERE id = ? AND resolved_at IS NULL')
  const insert = db.prepare(
    `INSERT OR IGNORE INTO conflicts
       (id, entity, entity_id, field, entity_ids, kind, incoming_op, existing_op, existing_op_id, created_at)
     VALUES (?, ?, ?, ?, ?, 'unique', ?, ?, ?, ?)`
  )
  const inserted = []
  const run = db.transaction(() => {
    for (const c of conflicts) {
      const id = uniqueConflictKey(c.entity, c.scopeId, c.field)
      if (existing.get(id)) continue
      // `entity_id` (NOT NULL) holds the lowest colliding id — a director's-convenience link
      // target per the ADR, never load-bearing for correctness, which lives in `entity_ids`
      // instead. `existing_op_id` (also NOT NULL) has no natural op id for a hard-set collision,
      // so it reuses the same lowest id.
      const [first, ...rest] = c.values
      const last = rest[rest.length - 1] ?? first
      insert.run(
        id,
        c.entity,
        c.entityIds[0],
        c.field,
        JSON.stringify(c.entityIds),
        JSON.stringify(last.record),
        JSON.stringify(first.record),
        c.entityIds[0],
        now()
      )
      inserted.push({ id, entity: c.entity, entityIds: c.entityIds, field: c.field })
    }
  })
  run()
  return inserted
}

/**
 * Close out any pending `unique:` row whose collision is no longer in the document — a director
 * renamed or deleted one of the colliding records on either device. Scoped to `id LIKE
 * 'unique:%'` the same way `clearResolvedConflicts` is scoped to `crdt:%`, so the two sweeps
 * never resolve each other's rows.
 */
export function clearResolvedUniqueConflicts(db, conflicts, { now = () => new Date().toISOString() } = {}) {
  const live = new Set((conflicts ?? []).map((c) => uniqueConflictKey(c.entity, c.scopeId, c.field)))
  const pending = db
    .prepare("SELECT id FROM conflicts WHERE resolved_at IS NULL AND id LIKE 'unique:%'")
    .all()
  const stale = pending.filter((r) => !live.has(r.id))
  if (stale.length === 0) return []
  const update = db.prepare('UPDATE conflicts SET resolved_at = ? WHERE id = ?')
  const at = now()
  const run = db.transaction(() => {
    for (const r of stale) update.run(at, r.id)
  })
  run()
  return stale.map((r) => r.id)
}
