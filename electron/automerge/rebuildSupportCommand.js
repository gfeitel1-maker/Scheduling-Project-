// T161: the support-command entry point for "delete this computer's SQLite
// and rebuild it from the Automerge document" (T151 proved the property;
// nothing ran it). Deliberately NOT a UI button — see the ticket for why —
// this is something a person runs on purpose, from the MCP support surface
// (scripts/mcp/tools.js's rebuild_projection_from_document), gated the same
// way repair_projection_entity is.
//
// This is a genuine file DELETE, not an in-place table wipe: rebuildFromDoc's
// wipe-then-reinsert path (projector.js) deletes every modeled table's rows
// while the `operations` table — this device's own op-log/history ledger,
// NOT a modeled/document-tracked table — still references the old `users`
// row by id (operations.author_user_id REFERENCES users(id)), so wiping
// `users` in place throws a foreign key violation. Deleting the whole SQLite
// file and starting from a fresh schema (exactly the shape T151's property
// test proves: a genuinely empty current-schema database, camps row
// bootstrapped, then projectAll) sidesteps that — the fresh file's
// `operations` table starts empty too, so there is nothing left to conflict.
// It is also the more literal reading of "delete SQLite and rebuild."
import fs from 'node:fs'
import { openLocalDb } from '../db/localDb.js'
import { writePreMigrationBackup } from '../db/projectManager.js'
import { docPath as automergeDocPath, loadDoc as loadAutomergeDoc } from '../sync/automerge/docStore.js'
import { sharesGenesis, listRecordIds } from './campDocument.js'
import { projectAll, MODELED_ORDER } from './projector.js'

export class RebuildRefusalError extends Error {}

// At-rest encryption (ADR 2026-09-15, constraint 2). "No document file" and "document file present
// but undecryptable" need OPPOSITE support advice, and until this they were indistinguishable: an
// undecryptable file EXISTS, so the existsSync check passed and the load threw a raw GCM-auth error
// that bypassed the "no file" refusal below. This is the second case — the bytes are here but this
// device's storage key is gone (keychain wiped, restored to a different machine/login). Rebuild
// cannot help: the key is what is missing, not the data, and there is nothing to rebuild FROM that
// this device can read. Same answer as a lost key everywhere else — see docs/current/KEY_RECOVERY_STORY.md.
export const UNDECRYPTABLE_NOTICE = (campId) =>
  `Refusing: the Automerge document file for camp ${campId} exists on this device but cannot be ` +
  'decrypted — this device\'s at-rest storage key is missing (the OS keychain entry was wiped, or ' +
  'this data was moved to a different machine or login). Rebuild cannot recover it: the key is what ' +
  'is gone, not the data, and this is by design (see the "three keys, one event" recovery story). ' +
  'Re-sync this device from a paired peer that still holds the camp, or re-pair it fresh — do NOT ' +
  'try to repair this file. This is a DIFFERENT situation from "no document file exists".'

export const NOT_RECOVERABLE_NOTICE =
  "This rebuild restores this device's current setup and schedule state from the synced " +
  "document — the same state every other synced device already has. It does NOT restore: " +
  "(1) the operations table, this device's own history ledger — Trash contents, Restore's " +
  'prior values, and ingest-undo history are gone for good; (2) this device\'s signing_secret ' +
  'and signing_public_key, and the host_signing_key if this device is the sync Host — those are ' +
  'host-only/device-local and were never written to the document, so they come back empty and ' +
  "must be re-established through the normal pairing/host flow. Until this device re-syncs " +
  "camps.signing_public_key, it cannot VERIFY credential changes (role/PIN) arriving over sync: on a " +
  "fresh rebuild the users table starts at safe defaults (no admin, unusable PINs) and NO ONE can " +
  "log in on this device until the key returns and the signed credentials re-apply — for a rebuilt " +
  "CLIENT the key arrives on its next re-join; a rebuilt HOST also lost its signing key, so it cannot " +
  "MINT credentials (add users, promote admins) and must re-establish its identity first. Only what " +
  'the document currently holds comes back.'

function tableRowCounts(db) {
  const counts = {}
  for (const entity of MODELED_ORDER) {
    counts[entity] = db.prepare(`SELECT COUNT(*) AS n FROM ${entity}`).get().n
  }
  return counts
}

// Every refusal here is a case the T151 property test's precondition, or the
// projector's own guards, would otherwise turn into a silent half-camp or a
// destructive merge — see rebuildFromDocument.test.js and syncNode.js's
// sharesGenesis usage. Each message says what to do next, not just what's
// wrong. Pure: takes an already-open db and an already-loaded doc (or null).
export function validateRebuildSource(db, doc) {
  const campRow = db.prepare('SELECT id, name FROM camps LIMIT 1').get()
  if (!campRow) {
    throw new RebuildRefusalError(
      'Refusing: this database has no camps row at all. Document replay never creates it — ' +
        'bootstrap the camp first (bootstrapCamp, or complete the join flow) so the camps row ' +
        'exists with the right id, then run this again.'
    )
  }
  if (!doc) {
    throw new RebuildRefusalError(
      `Refusing: no Automerge document file exists for camp ${campRow.id} on this device. This ` +
        'device has never synced or been seeded from SQLite — there is nothing to rebuild from. ' +
        'Pair with another device (or seed the document from this SQLite first) before retrying.'
    )
  }
  if (!sharesGenesis(doc)) {
    throw new RebuildRefusalError(
      'Refusing: this document does not share this camp\'s genesis. Projecting a document from a ' +
        "different lineage would be destructive — it is not a peer's view of this camp, it is a " +
        'foreign document. Confirm the document file actually belongs to this camp before retrying.'
    )
  }
  const docCampIds = listRecordIds(doc, 'camps')
  if (docCampIds.length === 0 || docCampIds[0] !== campRow.id) {
    throw new RebuildRefusalError(
      `Refusing: the camps row on this device (id ${campRow.id}) does not match the camp the ` +
        `document holds (id ${docCampIds[0] ?? 'none'}). Rebuilding would try to project a ` +
        "different camp's data through this device's own camp_id guard and fail loudly, or worse, " +
        'silently mismatch. Confirm the document file belongs to this device\'s camp before retrying.'
    )
  }
  return { campId: campRow.id, campName: campRow.name }
}

// Pure core: given a FRESH, schema-only db (no camps row yet — exactly
// T151's precondition) plus the campId/campName recovered from the old
// database and a validated doc, bootstraps the camps row and projects. Kept
// separate from validateRebuildSource so tests can exercise "does the
// projection itself round-trip into a truly fresh db" without any file I/O.
export function rebuildIntoFreshDb(freshDb, doc, campId, campName) {
  freshDb.prepare('INSERT INTO camps (id, name) VALUES (?, ?)').run(campId, campName)
  const before = tableRowCounts(freshDb)
  projectAll(freshDb, doc)
  const after = tableRowCounts(freshDb)
  return { ok: true, campId, before, after, notRecoverable: NOT_RECOVERABLE_NOTICE }
}

// File-path orchestration for the MCP tool: validates against the CURRENT
// database, backs it up, deletes it, recreates it from schema alone, and
// projects the document into it. userDataDir is the directory
// automerge/<campId>.automerge lives under (docStore.js's docPath) — pass
// the resolved userData path explicitly, the same injected-path discipline
// userDataPath.js and docStore.js already use; do not infer it from dbPath,
// which may live elsewhere (a custom project path, a smoke-test override).
export function rebuildProjectionFromDocumentAtPath({ dbPath, userDataDir, cipher = null, key = null }) {
  const oldDb = openLocalDb(dbPath, { key })
  let campId, campName, doc
  try {
    const campRow = oldDb.prepare('SELECT id FROM camps LIMIT 1').get()
    const resolvedDocPath = campRow ? automergeDocPath(userDataDir, campRow.id) : null
    if (resolvedDocPath && fs.existsSync(resolvedDocPath)) {
      // File-present-but-undecryptable must NOT fall through to the "no file" refusal (finding 2).
      // A decrypt/decode failure here means the bytes exist but this device cannot read them —
      // opposite support advice from "no file". Catch it and refuse distinctly. A successful load
      // (plaintext when cipher is null, or decrypted when a cipher is passed) proceeds as before.
      try {
        doc = loadAutomergeDoc(userDataDir, campRow.id, cipher)
      } catch {
        throw new RebuildRefusalError(UNDECRYPTABLE_NOTICE(campRow.id))
      }
    } else {
      doc = null
    }
    ;({ campId, campName } = validateRebuildSource(oldDb, doc))
  } finally {
    oldDb.close()
  }

  // Only reached once every refusal check above has passed — a refusal never
  // leaves a backup or touches the database.
  const backupPath = writePreMigrationBackup(dbPath)
  for (const suffix of ['', '-wal', '-shm']) {
    const sidecarPath = `${dbPath}${suffix}`
    if (fs.existsSync(sidecarPath)) fs.unlinkSync(sidecarPath)
  }

  const freshDb = openLocalDb(dbPath, { key })
  try {
    const result = rebuildIntoFreshDb(freshDb, doc, campId, campName)
    return { ...result, backupPath, docPath: automergeDocPath(userDataDir, campId) }
  } finally {
    freshDb.close()
  }
}
