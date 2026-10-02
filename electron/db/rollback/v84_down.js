// Inverse of migration v84 (electron/db/localDb.js) — T293, docs/adr/2026-10-01-anchors-become-
// fixed-and-recurring-events.md. Pure vocabulary rename, no new shape.
//
//   1. `ALTER TABLE template_slots RENAME COLUMN fixed_event_id TO anchor_id`, and the same for
//      `is_fixed_event` -> `is_anchor`. These columns are ALTER-added (v17), never declared in
//      schema.sql, so the rename-back is the whole story — no table recreate needed.
//   2. `ALTER TABLE cohorts RENAME COLUMN fixed_event_model TO anchor_model`.
//   3. `ALTER TABLE compound_cell_decisions RENAME COLUMN base_name TO anchor_name` — a different
//      sense of "anchor" than the other three (the base term in a compound cell label), renamed in
//      the same migration purely for mechanical convenience; reverted here for the same reason.
//   4. Every rename is guarded by column presence, not run unconditionally: a database already
//      below v84 (one that never got this far, or one already rolled back) would otherwise error
//      on a column that does not exist. Mirrors the `renameColumnIfPresent` guard the v84 migration
//      itself uses.
//   5. No registry membership restored: this script does not touch PROJECTIONS
//      (electron/ops/projections.js), src/localClient.mock.js, undoReferences.js, deleteRecord.js,
//      or campScopedEntities.js. Those are separate, deliberate code changes a schema-only rollback
//      does not undo — same ruling as v82_down point 3, v83_down point 3.
//   6. THESE ENTITIES REPLICATE (template_slots and cohorts; compound_cell_decisions does NOT —
//      see schema.sql's comment on that table, host-local/admin-only, deliberately unregistered
//      anywhere sync touches). For the two that replicate, this is a local column rename only — it
//      does not tell any peer anything, and a peer still on v84 keeps sending rows shaped with the
//      new column names, which this device's SQLite layer would then need to re-map on the next
//      forward migration. Running this script is a local, host-side operation, not a fleet
//      downgrade.
//   7. No data loss: a RENAME COLUMN keeps every value, under its old name. Nothing is dropped,
//      nothing is recomputed.
//
// Usage:  node electron/db/rollback/v84_down.js <path-to-shoresh.sqlite>

const renameColumnIfPresent = (db, table, oldName, newName) => {
  const has = db.pragma(`table_info(${table})`).some((col) => col.name === oldName)
  if (has) db.exec(`ALTER TABLE ${table} RENAME COLUMN ${oldName} TO ${newName}`)
}

/**
 * @returns {{ok:true}}
 */
// Inverse of the forward migration's schedule_snapshots.slots blob rewrite — same key-targeted
// transform, same per-row try/catch so a malformed/NULL/non-array value is left untouched and
// cannot abort the rollback for every other row.
const renameSnapshotSlotKeysBack = (slots) =>
  slots.map((el) => {
    if (!el || typeof el !== 'object') return el
    const out = { ...el }
    if ('fixed_event_id' in out) { out.anchor_id = out.fixed_event_id; delete out.fixed_event_id }
    if ('is_fixed_event' in out) { out.is_anchor = out.is_fixed_event; delete out.is_fixed_event }
    return out
  })

import { assertHighestApplied } from './assertHighestApplied.js'

export function rollbackV84(db) {
  db.transaction(() => {
    renameColumnIfPresent(db, 'template_slots', 'fixed_event_id', 'anchor_id')
    renameColumnIfPresent(db, 'template_slots', 'is_fixed_event', 'is_anchor')
    renameColumnIfPresent(db, 'cohorts', 'fixed_event_model', 'anchor_model')
    renameColumnIfPresent(db, 'compound_cell_decisions', 'base_name', 'anchor_name')

    const updateSnapshotSlots = db.prepare('UPDATE schedule_snapshots SET slots = ? WHERE id = ?')
    for (const row of db.prepare('SELECT id, slots FROM schedule_snapshots').all()) {
      try {
        const parsed = JSON.parse(row.slots)
        if (!Array.isArray(parsed)) continue
        updateSnapshotSlots.run(JSON.stringify(renameSnapshotSlotKeysBack(parsed)), row.id)
      } catch {
        // Malformed/non-JSON blob — left untouched, same defensive posture as the forward migration.
      }
    }
  })()

  // `>= 84`, never `= 84` — a bare equality leaves any LATER migration row behind, so a database
  // rolled back from a future version would claim a version whose shape it no longer has
  // (bareEqualityRollback.guard.test.js).
  db.prepare('DELETE FROM schema_migrations WHERE version >= 84').run()

  return { ok: true }
}

// Direct invocation (node electron/db/rollback/v84_down.js <file>).
if (process.argv[1] && process.argv[1].endsWith('v84_down.js')) {
  const file = process.argv[2]
  if (!file) {
    console.error('usage: node electron/db/rollback/v84_down.js <path-to-shoresh.sqlite>')
    process.exit(1)
  }
  const { default: Database } = await import('better-sqlite3')
  const db = new Database(file)
  db.pragma('foreign_keys = ON')
  assertHighestApplied(db, 84)
  rollbackV84(db)
  db.close()
  console.log(
    'v84 rolled back: template_slots.fixed_event_id/is_fixed_event renamed back to ' +
    'anchor_id/is_anchor, cohorts.fixed_event_model renamed back to anchor_model, ' +
    'compound_cell_decisions.base_name renamed back to anchor_name. All values preserved — a ' +
    'RENAME COLUMN keeps data, it is not a drop. This app build still declares schema version 84: ' +
    'reopening it re-applies the rename.'
  )
}
