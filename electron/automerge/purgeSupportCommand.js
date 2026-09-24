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
//      non-modeled, host-only table on this device (PURGE_WIPED_TABLES in purgeCollateral.js:
//      conflicts, import_evidence, import_decisions, open_reconciliation_decisions, pending_writes,
//      pending_restores, device_health_events, projection_failures, source_aliases,
//      compound_cell_decisions, location_word_decisions, declined_two_row_splits, plus the
//      camps.signing_secret column) is wiped along with it, camp-wide, not just for the purged
//      camper. That collateral is an accepted tradeoff. (schedule_snapshots is MODELED — it is
//      document-replicated and round-trips back via the fresh document, so it is NOT collateral;
//      purgeCollateral.js and its test are the source of truth this list must match.)
//   5b. PRESERVE THIS DEVICE'S SIGNING/IDENTITY KEYS across the rebuild (T202 follow-up). The three
//      load-bearing device-identity artifacts — host_signing_key, device_identity_key, and
//      camps.signing_public_key — are read out of the pre-rebuild db (step 3's oldDb) and written
//      back into the freshly-rebuilt db, byte-identical, so a purge no longer silently strips a live
//      Host of its ability to mint credentials or changes this device's stable libp2p PeerId. A
//      purge is not a "device lost/reset" event (the machine stays alive and stays Host), so the
//      KEY_RECOVERY_STORY "re-establish identity" answer does not apply. See hostKeyPreservation.js
//      for the full rationale, scope (exactly these three — signing_secret and rendezvous_sequence
//      are deliberately NOT preserved), and the documented app-must-be-stopped precondition. Restore
//      happens BEFORE the step-6 shred (see FIX3 below), and purgeCamperRecord returns its own
//      PURGE_NOT_RECOVERABLE_NOTICE (the rebuild's NOT_RECOVERABLE_NOTICE is now wrong for a purge:
//      it says the keys must be re-established, which is exactly what 5b reverses).
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
// EXCEPTION (5b/FIX3): the one window auto-recovery does NOT cover is after the rebuild completes
// but before key-restore finishes — by then operations is already emptied, so a re-run hits the
// FIX4 refusal. That window is instead covered by ordering restore before the shred, so the
// pre-migration backup (still holding the original keys) survives as a manual recovery source.
//
// Not reliable for OTHER devices: nothing here changes the app-wide Automerge genesis, so a stale,
// already-paired peer still shares genesis with the purged device and an ordinary sync merge can
// reintroduce the purged history — see SECURITY.md and this file's own "known gap" test.
import fs from 'node:fs'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { openLocalDb } from '../db/localDb.js'
import { docPath as automergeDocPath, loadDoc as loadAutomergeDoc, saveDoc as saveAutomergeDoc } from '../sync/automerge/docStore.js'
import { createEmptyDoc, sharesGenesis } from './campDocument.js'
import { seedAllFromSqlite } from './seed.js'
import { signTombstone } from './tombstoneSignature.js'
import { projectAll } from './projector.js'
import { reconcileAndRecordConflicts } from './reconcileForProjection.js'
import {
  validateRebuildSource,
  rebuildProjectionFromDocumentAtPathCore,
  RebuildRefusalError,
  UNDECRYPTABLE_NOTICE,
} from './rebuildSupportCommand.js'
import { acquireSupportCommandLock } from './supportCommandLock.js'
import {
  readPreservableKeys,
  restorePreservableKeys,
  writePreservableKeysInto,
  PURGE_NOT_RECOVERABLE_NOTICE,
} from './hostKeyPreservation.js'

// Same glob-by-basename approach rotatePreResolveBackups (electron/db/projectManager.js) uses for
// its own `*.pre-resolve-*.sqlite` family — writePreMigrationBackup's own files are otherwise NEVER
// pruned by anything (see SECURITY.md's "Known limitations" note this ticket adds). Shared by
// shredPreMigrationBackups and findRecoverableKeyBackup below, which both need the same listing.
function listPreMigrationBackups(dbPath) {
  const dir = path.dirname(dbPath)
  const base = path.basename(dbPath)
  let entries
  try {
    entries = fs.readdirSync(dir)
  } catch {
    return []
  }
  return entries
    .filter((name) => name.startsWith(`${base}.pre-migration-`) && name.endsWith('.bak'))
    .map((name) => path.join(dir, name))
}

function shredPreMigrationBackups(dbPath) {
  const removed = []
  for (const fullPath of listPreMigrationBackups(dbPath)) {
    try {
      fs.unlinkSync(fullPath)
      removed.push(fullPath)
    } catch {
      /* disk race — best effort, same tolerance as rotatePreResolveBackups */
    }
  }
  return removed
}

// T233 round 2, finding 1: crash-safe key recovery from the pre-migration backup rebuild already
// writes. rebuildProjectionFromDocumentAtPathCore backs up dbPath (which still has the three
// preservable artifacts — host_signing_key/device_identity_key/camps.signing_public_key — intact)
// BEFORE it wipes and recreates the file — so the intact key material sits on disk in that `.bak`
// throughout the exact window a
// crash between the wipe and the in-memory key restore would otherwise destroy it permanently. Read
// via a throwaway COPY of the backup (opened through the ordinary openLocalDb path, honoring the
// same SQLite `key` this device uses) rather than the backup file itself, so nothing here mutates
// or locks a file that still needs to survive until this purge's own final shred step.
function findRecoverableKeyBackup(dbPath, { key }) {
  const dir = path.dirname(dbPath)
  const base = path.basename(dbPath)
  const RECOVERY_PREFIX = `${base}.purge-key-recovery-`
  // The throwaway copy is written into the DB's OWN directory (Red Hat round-2 finding), NOT
  // os.tmpdir(): when at-rest encryption is off the `.bak` is plaintext, and a copy in a
  // world-readable system temp dir would be a materially wider exposure than the userData location
  // this data already lives in. Co-locating it keeps the same trust boundary as the backups
  // themselves. Also sweep any orphan left by a crash INSIDE the copy/open window on a prior run —
  // the one path the per-iteration finally below cannot cover.
  try {
    for (const name of fs.readdirSync(dir)) {
      if (name.startsWith(RECOVERY_PREFIX)) {
        try { fs.unlinkSync(path.join(dir, name)) } catch { /* best-effort */ }
      }
    }
  } catch { /* dir unreadable — nothing to sweep */ }
  // Newest-first: the ISO-timestamp suffix in each backup's name sorts lexicographically.
  const backups = listPreMigrationBackups(dbPath).sort().reverse()
  for (const backupPath of backups) {
    const tmpCopy = path.join(dir, `${RECOVERY_PREFIX}${randomUUID()}.sqlite`)
    try {
      fs.copyFileSync(backupPath, tmpCopy)
      const bakDb = openLocalDb(tmpCopy, { key })
      try {
        // Same 3-artifact scope and shape hostKeyPreservation.js uses everywhere else (no
        // camps.signing_secret — deliberately not preserved). A backup with no host_signing_key row
        // (e.g. from a Client, or a pre-key-era db) is not a key-recovery source — skip it.
        const preservable = readPreservableKeys(bakDb)
        if (!preservable.hostSigningKey) continue
        return preservable
      } finally {
        bakDb.close()
      }
    } catch {
      continue // this backup is unreadable (undecryptable, corrupt) — try the next-newest
    } finally {
      for (const suffix of ['', '-wal', '-shm']) {
        try { fs.unlinkSync(`${tmpCopy}${suffix}`) } catch { /* best-effort cleanup */ }
      }
    }
  }
  return null
}

// T233 round 2, finding 2: the LOCKED entry point. Acquires the machine-wide, dbPath-keyed
// support-command lock (supportCommandLock.js, shared with rebuildSupportCommand.js) for this
// purge's ENTIRE duration — including its internal call into the rebuild core below — so two
// purges, or a purge racing an ordinary rebuild, on the same dbPath serialize rather than
// interleave against the same SQLite file. See supportCommandLock.js for what this lock does and
// does NOT cover (purge/rebuild vs each other, not vs the live app's hot sync path).
export function purgeCamperRecord({ dbPath, userDataDir, cipher = null, key = null, entityId, lockOptions }) {
  const release = acquireSupportCommandLock(dbPath, lockOptions)
  try {
    return purgeCamperRecordLocked({ dbPath, userDataDir, cipher, key, entityId })
  } finally {
    release()
  }
}

function purgeCamperRecordLocked({ dbPath, userDataDir, cipher = null, key = null, entityId }) {
  let campId
  let removed
  let tombstone
  let freshDoc
  let preservedKeys
  const oldDb = openLocalDb(dbPath, { key })
  try {
    // T233 (docs/adr/2026-09-19-multi-device-erasure-propagation.md), Host-only purge: only the
    // Host holds host_signing_key, so only the Host can mint the signed tombstone that makes an
    // erasure reach the fleet. A purge that "succeeds" locally without minting one reproduces the
    // exact reintroduction gap this ticket closes — refuse outright, before any mutation, rather
    // than silently purging this device alone.
    let hostKeyExists = oldDb.prepare('SELECT 1 FROM host_signing_key WHERE id = 1').get()

    // T233 round 2, finding 1: crash-safe recovery, tried BEFORE the Host-only refusal below — a
    // crash between rebuildProjectionFromDocumentAtPathCore's wipe (which also wipes
    // host_signing_key) and this function's own in-memory key restore would otherwise permanently
    // destroy this device's only signing key AND make a recovery re-run trip the refusal below,
    // bricking the Host. If a `.bak` written by that same rebuild before the wipe still holds the
    // key, restore it into the live db first — this makes a crashed-mid-purge re-run recover the
    // key, then proceed idempotently, exactly as the module header's "re-run to recover" guarantee
    // promises. A genuine non-Host device (no key, no recoverable `.bak`) still falls through to
    // the refusal unchanged.
    let didRecoverKeys = false
    if (!hostKeyExists) {
      const recovered = findRecoverableKeyBackup(dbPath, { key })
      if (recovered) {
        writePreservableKeysInto(oldDb, recovered)
        hostKeyExists = oldDb.prepare('SELECT 1 FROM host_signing_key WHERE id = 1').get()
        didRecoverKeys = true
      }
    }
    if (!hostKeyExists) {
      throw new RebuildRefusalError(
        'purgeCamperRecord: this device has no host_signing_key row — only the Host can mint the ' +
          'signed purge tombstone that propagates an erasure to the rest of the fleet. Run this ' +
          'purge on the Host device.'
      )
    }
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

    // T233 round 2, finding 1 continued — GATED to the recovery case (Red Hat round-2 review).
    // ONLY when this call actually recovered keys from a crashed prior purge, catch up any change
    // gated on the now-restored key — chiefly a tombstone this same purge minted before the crash,
    // which the rebuild's own internal projectAll pass could not apply without a signing key
    // (upsertTombstonesEntity's keep-last-known no-key branch). This MUST run before the FIX4 check
    // below, because that check reads the tombstones TABLE and the recovered tombstone is still
    // only in the document until this projects it in. It is gated to `didRecoverKeys` so the NORMAL
    // purge path never runs a projectAll here — that closes Red Hat's finding that an unconditional
    // projectAll made a typo'd-id no-op refusal (a) commit a projection pass and (b) risk an
    // unrelated assertConflictsRecorded throw instead of the clean "nothing to purge" message.
    // In the recovery case a projectAll is legitimate mid-purge work, not a refusal path.
    //
    // T235/T242 finding 2: `doc` was loaded fresh from disk above, not reconciled in-process the
    // way syncNode's merge path is — it can carry a live conflict (scalar or hard-set unique)
    // nobody has recorded yet. Derive and record first, exactly as rebuildIntoFreshDb now does,
    // so assertConflictsRecorded doesn't turn an unrelated, already-surfaced conflict into a
    // refusal of this crash-recovery retry.
    if (didRecoverKeys && doc) projectAll(oldDb, reconcileAndRecordConflicts(oldDb, doc))

    // FIX4: refuse a whole-device purge (see the blast-radius comment above) for an id that names
    // nothing at all — a typo, or a camper already purged. Checked against the live projection,
    // this device's operations history, AND its tombstones table (round 2, finding 1) so a camper
    // recovered mid-crash-recovery — already fully purged except for the key-restore/shred tail
    // end, evidenced by its own tombstone row (projected in by the recovery pass above) — is never
    // mistaken for an id that never existed. In the normal (non-recovery) path no projectAll ran
    // above, so this refusal stays a TRUE no-op (module header contract, point 1).
    const camperExists = oldDb.prepare('SELECT 1 FROM campers WHERE id = ?').get(entityId)
    const hasOpHistory = oldDb.prepare('SELECT 1 FROM operations WHERE entity_id = ? LIMIT 1').get(entityId)
    const hasTombstone = oldDb.prepare('SELECT 1 FROM tombstones WHERE id = ?').get(entityId)
    if (!camperExists && !hasOpHistory && !hasTombstone) {
      throw new RebuildRefusalError(
        `Refusing: no camper record or operations history exists for id ${entityId} on this ` +
          'device. This purge is a whole-device rebuild with real collateral cost (see this ' +
          "module's header) — refusing to run it for an id that has nothing to purge."
      )
    }

    // 5b: capture this device's signing/identity keys BEFORE the rebuild destroys them. Read-only,
    // and the purge transaction below never touches these tables, so capturing here (before it) sees
    // exactly the keys the pre-purge device held. Absent rows come back null and are skipped later.
    preservedKeys = readPreservableKeys(oldDb)

    // FIX1: deletes + document regeneration + genesis check all inside ONE transaction, so a
    // failure anywhere in this block rolls the deletes back — no split between "SQLite purged" and
    // "document still holds it". seedAllFromSqlite only reads oldDb, so it is safe here.
    freshDoc = oldDb.transaction(() => {
      removed = {
        elective_assignments: oldDb.prepare('DELETE FROM elective_assignments WHERE camper_id = ?').run(entityId).changes,
        elective_preferences: oldDb.prepare('DELETE FROM elective_preferences WHERE camper_id = ?').run(entityId).changes,
        campers: oldDb.prepare('DELETE FROM campers WHERE id = ?').run(entityId).changes,
      }

      // T233: mint the signed tombstone and persist it into SQLite BEFORE seedAllFromSqlite runs
      // (the regen trap, Red Hat HIGH) — seedAllFromSqlite rebuilds the document FROM SQLite, not
      // by carrying the old document forward, so a tombstone that only lived in the document would
      // be discarded by the very rebuild meant to carry it. IDEMPOTENT RE-RUN (this file's header
      // IDEMPOTENCY note): an existing tombstone for this id keeps its already-minted version
      // rather than incrementing again — a crash-recovery retry re-signs and re-inserts the SAME
      // version, never regressing or needlessly advancing it.
      const existingTombstone = oldDb.prepare('SELECT version FROM tombstones WHERE id = ?').get(entityId)
      const version = existingTombstone?.version ?? 1
      const sig = signTombstone(oldDb, { id: entityId, entity: 'campers', version })
      oldDb
        .prepare(
          'INSERT OR REPLACE INTO tombstones (id, entity, version, sig, created_at) VALUES (?, ?, ?, ?, ?)'
        )
        .run(entityId, 'campers', version, sig, new Date().toISOString())
      tombstone = { id: entityId, entity: 'campers', version }

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
    // never reflects deletes that could still have been rolled back. (Key material for the device
    // was already captured into `preservedKeys` via readPreservableKeys(oldDb) above, before the
    // transaction — the single capture; restored after the rebuild below.)
    saveAutomergeDoc(userDataDir, campId, freshDoc, cipher)
  } finally {
    oldDb.close()
  }

  // Rebuild SQLite from the fresh, camper-free document — reuses the exact
  // validate->backup->delete->recreate->project pipeline an ordinary rebuild uses. Calls the
  // UNLOCKED core (round 2, finding 2) because this whole function already holds the
  // support-command lock for its entire duration — calling the locked export here would deadlock
  // against itself. The backup it writes here (of the ALREADY-mutated db from the block above) is
  // shredded below along with every other pre-migration backup for this dbPath.
  const rebuildResult = rebuildProjectionFromDocumentAtPathCore({ dbPath, userDataDir, cipher, key })

  // 5b: write the preserved keys back into the freshly-rebuilt db, BEFORE the step-6 shred.
  // FIX3 — ORDERING IS LOAD-BEARING: the pre-migration backup rebuild just wrote (and which the
  // shred below deletes) still holds the ORIGINAL keys, because it was copied from the pre-rebuild
  // db. Restoring before shredding means a crash in the narrow window between rebuild-finish and
  // restore-finish leaves that backup as a manual recovery source for the keys. This is the one
  // crash window the IDEMPOTENCY note below cannot auto-recover: once the rebuild has completed the
  // camper row and its operations history are gone, so a re-run hits the FIX4 refusal — an accepted,
  // bounded regression, recoverable by hand from the still-present backup rather than silently.
  let keysRestored
  try {
    keysRestored = restorePreservableKeys({ dbPath, key, preservedKeys, openLocalDb })
  } catch (cause) {
    // Restore threw AFTER the rebuild but BEFORE the step-6 shred, so FIX3's ordering holds: the
    // shred below never runs and the pre-migration backup still holds this device's ORIGINAL keys.
    // The default error would surface with no purge context, so name what happened and where the
    // keys still live. No key bytes are logged. SECURITY.md §347 documents the recovery path.
    throw new Error(
      'purgeCamperRecord: keys were NOT restored after the purge rebuild. This device\'s original ' +
        `signing/identity keys are still in the pre-migration backup at ${dbPath}.pre-migration-*.bak ` +
        '(NOT shredded — the shred is skipped on this failure). Restore them by hand before shredding; ' +
        'see SECURITY.md §347.',
      { cause }
    )
  }

  // T233: re-project now that the keys are back. The rebuild's own internal projectAll ran with NO
  // camps.signing_public_key (it was wiped by the rebuild and restored only just above), so
  // upsertTombstonesEntity's no-key branch SKIPPED applying the tombstone this purge just minted —
  // keep-last-known, never apply an unverifiable change (same policy as upsertUsersEntity). With the
  // verifier key restored, one more idempotent projectAll verifies and applies it into THIS device's
  // own tombstones table + denylist, so the purging device itself refuses a later stale-peer
  // re-merge of the camper (the inverted "known gap" test asserts exactly this). Runs only when the
  // public key actually came back.
  if (keysRestored?.campsSigningPublicKey && freshDoc) {
    const reprojectDb = openLocalDb(dbPath, { key })
    try {
      // T235/T242 finding 2: same guard as the crash-recovery reproject above — derive/record
      // before projecting, rather than assuming a document this purge itself regenerated cannot
      // carry an unrecorded conflict.
      projectAll(reprojectDb, reconcileAndRecordConflicts(reprojectDb, freshDoc))
    } finally {
      reprojectDb.close()
    }
  }

  const backupsRemoved = shredPreMigrationBackups(dbPath)

  return {
    campId,
    entityId,
    removed,
    keysRestored,
    backupsRemoved,
    docPath: rebuildResult.docPath,
    // FIX2 + 5b: purgeCamperRecord issues its OWN not-recoverable notice rather than relaying the
    // rebuild's NOT_RECOVERABLE_NOTICE, which is now wrong for a purge — it says the signing keys
    // "come back empty and must be re-established", the exact behavior 5b reverses. This notice
    // states what a purge truly does not recover (the operations ledger) and that the keys survive.
    notRecoverable: PURGE_NOT_RECOVERABLE_NOTICE,
    before: rebuildResult.before,
    after: rebuildResult.after,
    // T233: the tombstone this purge minted, and an explicit honesty flag — this purge has
    // erased the record LOCALLY, but fleet propagation depends on this tombstone reaching at
    // least one live peer, which this function cannot itself confirm (see the ADR's residual
    // risks section). Callers must not report fleet-erasure as complete from this return value
    // alone.
    tombstone,
    propagationPending: true,
  }
}
