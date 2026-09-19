// T202: the camper-record purge path — docs/work/tickets/T202-camper-record-purge-path.md, ADR
// 2026-09-17-individual-elective-scheduling.md D10. Support-level only (no UI, no preload/IPC
// surface), same shape as rebuildSupportCommand.js's rebuild_projection_from_document.
//
// Composes alongside rebuildSupportCommand.js rather than overloading it with a purge flag:
//   1. Validate the source exactly as an ordinary rebuild would (validateRebuildSource) — a
//      refusal here must not touch the db or write a backup.
//   2. Refuse outright if entityId names nothing (round 2, FIX4): no camper row AND no operations
//      history for it. This purge is a WHOLE-DEVICE rebuild with real collateral cost (see point 5
//      below) — running it for an id that names nothing purges nothing and still destroys camp-wide
//      state and this device's signing key for free.
//   3. Delete the target camper and its dependent rows (elective_preferences, elective_assignments
//      by camper_id) from THIS device's live projection, regenerate a FRESH document via
//      seedAllFromSqlite(oldDb, createEmptyDoc()), and confirm it still shares this camp's genesis
//      — ALL THREE inside one oldDb.transaction() (round 2, FIX1). Before this fix the three
//      DELETEs auto-committed individually, so a throw from seedAllFromSqlite/the genesis check
//      left SQLite purged while the on-disk .automerge (the source of truth) still held the camper
//      — a split, recoverable-looking-but-wrong state that is exactly the failure this feature
//      exists to prevent. Wrapping all three in one transaction means any failure rolls the deletes
//      back, leaving a clean PRE-purge state (both stores still hold the camper) instead of a split.
//      seedAllFromSqlite(oldDb, ...) only ever READS oldDb, so it is safe to run inside the same
//      transaction as the deletes it must observe.
//   4. Save the fresh document over this device's .automerge file — AFTER the transaction has
//      committed, never before, so the document on disk never reflects a set of deletes that could
//      still be rolled back. docStore.js's saveDoc is already atomic (write to a temp file in the
//      same directory, then fs.renameSync over the target), so a crash mid-write leaves either the
//      old or the new file, never a truncated one — no additional hardening needed here.
//   5. Reuse rebuildProjectionFromDocumentAtPath to rebuild SQLite from the fresh document — the
//      only existing path that also empties `operations` (a whole-file delete+recreate, not a
//      targeted prune; T202 is whole-device-history purge, not per-record op-log pruning — see the
//      ticket's exit condition). BLAST RADIUS, STATED EXPLICITLY (round 2, FIX2): this is a
//      WHOLE-DEVICE rebuild. It reprojects ONLY the modeled, document-replicated entities — every
//      non-modeled, host-only table on this device (schedule_snapshots, conflicts, import_evidence,
//      import_decisions, open_reconciliation_decisions, pending_writes, pending_restores,
//      device_health_events, projection_failures, source_aliases, compound_cell_decisions,
//      location_word_decisions, declined_two_row_splits, and this device's own
//      host_signing_key/device_identity_key rows, plus camps.signing_secret) is wiped along with
//      it, camp-wide, not just for the purged camper. A Host that purges a camper loses its
//      credential-minting key in the same stroke and must re-establish device identity afterward.
//      rebuildIntoFreshDb's own NOT_RECOVERABLE_NOTICE already documents this for disaster-recovery
//      callers; purgeCamperRecord's return value relays it (notRecoverable/before/after below) so
//      no caller can miss it, and SECURITY.md states it plainly rather than only inheriting it.
//      Preserving/re-establishing keys across a purge is explicitly out of scope here — tracked as
//      a follow-up ticket, not attempted in this slice.
//   6. Shred EVERY `*.pre-migration-*.bak` for this dbPath — the step that otherwise silently
//      defeats the whole procedure (D10). This shred is PURGE-ONLY: it must never run from
//      rebuildSupportCommand.js's own rebuild, or from localDb.js/sqliteCipher.js's migration and
//      rekey call sites, all of which need their pre-migration backups kept. Implemented here, not
//      inside writePreMigrationBackup, so those call sites are untouched.
//
// IDEMPOTENCY (round 2, FIX1's other half): a crash in the narrow window AFTER the transaction
// commits but BEFORE the save/rebuild/shred below finish is recovered by simply re-running
// purgeCamperRecord with the same entityId. The deletes become no-ops (0 rows changed) the second
// time, seedAllFromSqlite re-derives an already-camper-free document, and save/rebuild/shred repeat
// safely — rebuildProjectionFromDocumentAtPath and the shred are themselves idempotent (an already
// camper-free document projects the same way twice; an already-shredded backup set stays empty).
// The FIX4 refusal above does not defeat this: while recovery is still possible, this device's
// `operations` table (only emptied by the LAST step, the rebuild) still carries rows for entityId,
// so the "no camper row AND no operations history" guard does not fire until the purge has
// genuinely finished — at which point refusing a second run is the correct behavior, not a bug.
//
// Not reliable for OTHER devices: nothing here changes the app-wide Automerge genesis, so a stale,
// already-paired peer still shares genesis with the purged device and an ordinary sync merge can
// reintroduce the purged history — see SECURITY.md and this file's own "known gap" test.
import fs from 'node:fs'
import path from 'node:path'
import { openLocalDb } from '../db/localDb.js'
import { docPath as automergeDocPath, loadDoc as loadAutomergeDoc, saveDoc as saveAutomergeDoc } from '../sync/automerge/docStore.js'
import { createEmptyDoc, sharesGenesis } from './campDocument.js'
import { seedAllFromSqlite } from './seed.js'
import {
  validateRebuildSource,
  rebuildProjectionFromDocumentAtPath,
  RebuildRefusalError,
  UNDECRYPTABLE_NOTICE,
} from './rebuildSupportCommand.js'

// Same glob-by-basename approach rotatePreResolveBackups (electron/db/projectManager.js) uses for
// its own `*.pre-resolve-*.sqlite` family — writePreMigrationBackup's own files are otherwise NEVER
// pruned by anything (see SECURITY.md's "Known limitations" note this ticket adds).
function shredPreMigrationBackups(dbPath) {
  const dir = path.dirname(dbPath)
  const base = path.basename(dbPath)
  let entries
  try {
    entries = fs.readdirSync(dir)
  } catch {
    return []
  }
  const removed = []
  for (const name of entries) {
    if (name.startsWith(`${base}.pre-migration-`) && name.endsWith('.bak')) {
      const fullPath = path.join(dir, name)
      try {
        fs.unlinkSync(fullPath)
        removed.push(fullPath)
      } catch {
        /* disk race — best effort, same tolerance as rotatePreResolveBackups */
      }
    }
  }
  return removed
}

export function purgeCamperRecord({ dbPath, userDataDir, cipher = null, key = null, entityId }) {
  let campId
  let removed
  const oldDb = openLocalDb(dbPath, { key })
  try {
    const campRow = oldDb.prepare('SELECT id FROM camps LIMIT 1').get()
    const resolvedDocPath = campRow ? automergeDocPath(userDataDir, campRow.id) : null
    let doc
    if (resolvedDocPath && fs.existsSync(resolvedDocPath)) {
      try {
        doc = loadAutomergeDoc(userDataDir, campRow.id, cipher)
      } catch {
        throw new RebuildRefusalError(UNDECRYPTABLE_NOTICE(campRow.id))
      }
    } else {
      doc = null
    }
    // Reuses the ordinary rebuild's own precondition checks (camps row exists, document exists,
    // shares genesis, camp ids match) — a refusal here throws before any mutation below runs, so it
    // never touches the db or writes a backup, exactly like an ordinary rebuild refusal.
    ;({ campId } = validateRebuildSource(oldDb, doc))

    // FIX4: refuse a whole-device purge (see the blast-radius comment above) for an id that names
    // nothing at all — a typo, or a camper already purged. Checked against BOTH the live
    // projection and this device's operations history so a camper mid-recovery (see IDEMPOTENCY
    // above) is never mistaken for one that never existed.
    const camperExists = oldDb.prepare('SELECT 1 FROM campers WHERE id = ?').get(entityId)
    const hasOpHistory = oldDb.prepare('SELECT 1 FROM operations WHERE entity_id = ? LIMIT 1').get(entityId)
    if (!camperExists && !hasOpHistory) {
      throw new RebuildRefusalError(
        `Refusing: no camper record or operations history exists for id ${entityId} on this ` +
          'device. This purge is a whole-device rebuild with real collateral cost (see this ' +
          "module's header) — refusing to run it for an id that has nothing to purge."
      )
    }

    // FIX1: deletes + document regeneration + genesis check all inside ONE transaction, so a
    // failure anywhere in this block rolls the deletes back — no split between "SQLite purged" and
    // "document still holds it". seedAllFromSqlite only reads oldDb, so it is safe here.
    const freshDoc = oldDb.transaction(() => {
      removed = {
        elective_assignments: oldDb.prepare('DELETE FROM elective_assignments WHERE camper_id = ?').run(entityId).changes,
        elective_preferences: oldDb.prepare('DELETE FROM elective_preferences WHERE camper_id = ?').run(entityId).changes,
        campers: oldDb.prepare('DELETE FROM campers WHERE id = ?').run(entityId).changes,
      }

      const candidate = seedAllFromSqlite(oldDb, createEmptyDoc())
      if (!sharesGenesis(candidate)) {
        throw new RebuildRefusalError(
          'purgeCamperRecord: the regenerated document unexpectedly does not share this camp\'s ' +
            'genesis — refusing to write it. This should be impossible (createEmptyDoc clones the ' +
            'frozen genesis) and indicates a bug in this procedure, not a normal refusal case.'
        )
      }
      return candidate
    })()

    // Save happens AFTER the transaction commits (FIX1) — never before, so the on-disk document
    // never reflects deletes that could still have been rolled back.
    saveAutomergeDoc(userDataDir, campId, freshDoc, cipher)
  } finally {
    oldDb.close()
  }

  // Rebuild SQLite from the fresh, camper-free document — reuses the exact
  // validate->backup->delete->recreate->project pipeline an ordinary rebuild uses. The backup it
  // writes here (of the ALREADY-mutated db from the block above) is shredded below along with every
  // other pre-migration backup for this dbPath.
  const rebuildResult = rebuildProjectionFromDocumentAtPath({ dbPath, userDataDir, cipher, key })

  const backupsRemoved = shredPreMigrationBackups(dbPath)

  return {
    campId,
    entityId,
    removed,
    backupsRemoved,
    docPath: rebuildResult.docPath,
    // FIX2: relay the rebuild's own disaster-recovery warning rather than dropping it — this purge
    // IS that whole-device rebuild, run for a new purpose, and callers must see the same collateral
    // notice a disaster-recovery caller would.
    notRecoverable: rebuildResult.notRecoverable,
    before: rebuildResult.before,
    after: rebuildResult.after,
  }
}
