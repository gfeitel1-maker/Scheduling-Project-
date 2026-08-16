// The v32 migration's first-run review journal — a plain, host-local read.
// docs/adr/2026-08-15-locations-merge-and-delete-rehome.md D3.
//
// location_migration_reviews is created and populated INSIDE the v32
// migration (electron/db/localDb.js's backfillLocations), never replicated,
// and never in PROJECTIONS/DIRECT_CAMP_ENTITIES/any sync registry — every
// device that ran its own migration holds its own copy, recomputed
// identically from its own free-text activity data (same posture as
// migration_v24_repoint_log, which also has no read path). This module reads
// straight off the CALLING device's own db and must never reach the Host —
// see electron/main.js's listMigrationReviewsHandler/
// dismissMigrationReviewsHandler, which are local-only, unlike previewDelete/
// deleteRecord above.
//
// TABLE-ABSENCE GUARDED: a device that paired into an already-v32 camp never
// ran the migration and has no journal table at all. That is not a device
// error — it must read as an empty list, never throw (design spec §3.3: a
// fresh camp or such a device sees no review region at all).
function hasJournalTable(db) {
  return !!db
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'location_migration_reviews'")
    .get()
}

// Parses `detail` defensively (Security, ADR "Security-relevant surface"):
// this is JSON written by the migration itself, but a corrupted/tampered row
// must not crash the review region.
function parseDetail(raw) {
  if (!raw) return null
  try {
    return JSON.parse(raw)
  } catch {
    return null
  }
}

export function listMigrationReviews(db) {
  if (!hasJournalTable(db)) return []
  const camp = db.prepare('SELECT id FROM camps LIMIT 1').get()
  if (!camp) return []
  const rows = db
    .prepare(
      `SELECT id, location_id, name, kind, detail, created_at
         FROM location_migration_reviews WHERE camp_id = ? ORDER BY created_at ASC`
    )
    .all(camp.id)
  return rows.map((row) => ({ ...row, detail: parseDetail(row.detail) }))
}

// Dismiss = delete the local journal row(s) (D4). Local-only write: never an
// op, never routed to the Host, never replicated — resolving a review on one
// device says nothing about any other device's copy of the journal.
export function dismissMigrationReviews(db, ids) {
  if (!hasJournalTable(db)) return { ok: true, dismissed: 0 }
  if (!Array.isArray(ids) || ids.length === 0) return { ok: true, dismissed: 0 }

  const stmt = db.prepare('DELETE FROM location_migration_reviews WHERE id = ?')
  const run = db.transaction((idList) => {
    let dismissed = 0
    for (const id of idList) {
      if (typeof id !== 'string' || id.length === 0) continue
      dismissed += stmt.run(id).changes
    }
    return dismissed
  })

  return { ok: true, dismissed: run(ids) }
}
