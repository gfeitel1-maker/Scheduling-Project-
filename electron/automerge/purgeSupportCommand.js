// T202: the camper-record purge path — docs/work/tickets/T202-camper-record-purge-path.md, ADR
// 2026-09-17-individual-elective-scheduling.md D10. Support-level only (no UI, no preload/IPC
// surface), same shape as rebuildSupportCommand.js's rebuild_projection_from_document.
//
// Composes alongside rebuildSupportCommand.js rather than overloading it with a purge flag:
//   1. Validate the source exactly as an ordinary rebuild would (validateRebuildSource) — a
//      refusal here must not touch the db or write a backup.
//   2. Delete the target camper and its dependent rows (elective_preferences, elective_assignments
//      by camper_id) from THIS device's live projection.
//   3. Regenerate a FRESH document via seedAllFromSqlite(oldDb, createEmptyDoc()) — the same
//      "materialize current SQLite state into a document descended from the frozen genesis"
//      primitive seed.js already provides for cutover/rebuild. Because the purge target's rows
//      are gone from SQLite before this runs, the fresh document's history never mentions them —
//      no prior-value history, not just a projection-level delete.
//   4. Save the fresh document over this device's .automerge file, then reuse
//      rebuildProjectionFromDocumentAtPath to rebuild SQLite from it — the only existing path that
//      also empties `operations` (a whole-file delete+recreate, not a targeted prune; T202 is
//      whole-device-history purge, not per-record op-log pruning — see the ticket's exit condition).
//   5. Shred EVERY `*.pre-migration-*.bak` for this dbPath — the step that otherwise silently
//      defeats the whole procedure (D10). This shred is PURGE-ONLY: it must never run from
//      rebuildSupportCommand.js's own rebuild, or from localDb.js/sqliteCipher.js's migration and
//      rekey call sites, all of which need their pre-migration backups kept. Implemented here, not
//      inside writePreMigrationBackup, so those call sites are untouched.
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

    removed = {
      elective_assignments: oldDb.prepare('DELETE FROM elective_assignments WHERE camper_id = ?').run(entityId).changes,
      elective_preferences: oldDb.prepare('DELETE FROM elective_preferences WHERE camper_id = ?').run(entityId).changes,
      campers: oldDb.prepare('DELETE FROM campers WHERE id = ?').run(entityId).changes,
    }

    const freshDoc = seedAllFromSqlite(oldDb, createEmptyDoc())
    if (!sharesGenesis(freshDoc)) {
      throw new Error(
        'purgeCamperRecord: the regenerated document unexpectedly does not share this camp\'s ' +
          'genesis — refusing to write it. This should be impossible (createEmptyDoc clones the ' +
          'frozen genesis) and indicates a bug in this procedure, not a normal refusal case.'
      )
    }
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
  }
}
