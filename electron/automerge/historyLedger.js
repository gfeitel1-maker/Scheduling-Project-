// The local history ledger: what this device knows about how its data got here.
//
// docs/adr/2026-09-07-stage6-cutover-plan.md (narrowed 6d).
//
// THE OP-LOG IS RETIRED AS A SYNC MECHANISM, NOT AS A RECORD. Sync is the
// Automerge document; the `operations` table stays, doing a different and
// smaller job — answering questions about the past that the document cannot:
//
//   - Trash ("what was deleted, and by whom?") — trash.js reads `operations`.
//   - Restore ("what did this record contain before it was deleted?") — a CRDT
//     document holds the CURRENT state; a deleted record is simply absent from
//     it. The history is the only place the old values still exist.
//   - Ingest undo (`commitPlan` captures prior values; `ingestUndo` checks the
//     field has not moved since) — both read op rows.
//
// Until now those rows only ever came from LOCAL writes (appendOp). A record
// created or deleted on another device arrived as a document merge and left no
// trace, so a device could see a record it could not explain and could not
// restore. That is what this closes: a received merge writes rows too.
//
// WHAT THIS MUST NOT DO, and why each matters:
//
//   - It must not project. `projectAll` has already written SQLite from the
//     merged document by the time this runs; projecting again would be
//     redundant at best and would fight the document as source of truth.
//   - It must not call `recordLocalWrite`. That is the LOCAL write path, which
//     applies the write back into the shared document — a received change
//     echoing back out as a local one, forever.
//
// Both are the reason this does not simply call `appendOp`, which does both.
import { randomUUID } from 'node:crypto'
import { coerceOpValue, DELETE_FIELD } from '../ops/operations.js'
import { isHumanEdited, readRecord } from './campDocument.js'
import { PROJECTIONS } from '../ops/projections.js'

// Peers whose device row we could not find, warned about once each rather than
// once per field — a full camp arriving from an unmapped peer would otherwise
// print thousands of identical lines.
const warnedPeers = new Set()

/**
 * Write ledger rows for changes that arrived from another device.
 *
 * @param db          this device's SQLite handle
 * @param events      synthesizeOpEvents output for the merge just applied
 * @param fromPeerId  the libp2p peer the merge came from
 * @param doc         the merged document — read for per-field provenance
 * @returns { written, skipped }
 */
export function appendReceivedOps(db, events, { fromPeerId, doc } = {}) {
  if (!Array.isArray(events) || events.length === 0) return { written: 0, skipped: 0 }

  // `operations.device_id` is NOT NULL REFERENCES devices(id), so a row cannot
  // be written for a peer this device cannot name. That FK is the concern the
  // retired WS scenario 24 existed to protect, and it returns here exactly as
  // that retirement note predicted it would.
  //
  // The mapping is recorded on a successful authenticate/login
  // (peerIdentity.js), both of which happen before a peer is admitted, and a
  // document is only accepted from an admitted peer — so a mapped peer is the
  // normal case.
  const deviceRow = fromPeerId
    ? db.prepare('SELECT id FROM devices WHERE libp2p_peer_id = ?').get(fromPeerId)
    : null

  if (!deviceRow) {
    // Deliberately SKIPPED, not invented. The alternatives are worse: stamping
    // this device's own id would falsely record a peer's edit as ours (and
    // Trash would name the wrong person), and creating a `devices` row from a
    // peer id alone would mint an unauthenticated device with no name and no
    // authorization trail.
    //
    // The cost of skipping is bounded and honest: the data itself is already
    // correct in SQLite (projectAll ran), and only the HISTORY of these fields
    // is missing on this device. Restore of these particular records degrades
    // to a clean `no-history` error rather than anything wrong.
    if (fromPeerId && !warnedPeers.has(fromPeerId)) {
      warnedPeers.add(fromPeerId)
      console.warn(
        `historyLedger: no devices row maps to peer ${fromPeerId} — history for its changes is not ` +
          `recorded on this device (data itself is unaffected; Trash/Restore for those records will ` +
          `report no history)`
      )
    }
    return { written: 0, skipped: events.length }
  }

  const now = new Date().toISOString()
  const insert = db.prepare(
    `INSERT INTO operations
       (id, entity, entity_id, field, value, author_user_id, device_id, timestamp, parent_op_id, client_write_id, source)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL, ?)`
  )

  // Fields SQLite holds that the document never carried.
  //
  // `camp_id` is the load-bearing case. Under doc-native ensureExists
  // (projections.js's `knownRow`) it is DERIVED when a record is projected, not
  // written as a document field — so it can never appear in a merge's events.
  //
  // restore.js requires it (`if (!fields.has('camp_id')) return no-history`) on
  // the reasoning that "every create path writes it, so its absence means this
  // device does not hold the record's creation". That was true of the op-log and
  // is not true of a merge: the device holds the record perfectly well, it just
  // never saw an op for a field nobody ever wrote. Without this, restoring a
  // record that arrived by merge fails with `no-history` even though every value
  // needed is sitting in SQLite.
  //
  // Read from the projected row (projectAll has already run) rather than
  // invented, and written once per record rather than per field.
  const derived = []
  const seenRecords = new Set()
  for (const e of events) {
    if (e.field === DELETE_FIELD) continue
    const key = `${e.entity}/${e.entity_id}`
    if (seenRecords.has(key)) continue
    seenRecords.add(key)
    const fields = PROJECTIONS[e.entity]?.fields
    if (!fields?.includes('camp_id')) continue
    // Only when the DOCUMENT does not carry it — a record whose camp_id really
    // was written as a field needs no help and must not get a duplicate row.
    if (doc && readRecord(doc, e.entity, e.entity_id)?.camp_id !== undefined) continue
    let row
    try {
      row = db.prepare(`SELECT camp_id FROM ${e.entity} WHERE id = ?`).get(e.entity_id)
    } catch {
      continue // entity has no such column after all; nothing to record
    }
    if (row?.camp_id) {
      derived.push({ entity: e.entity, entity_id: e.entity_id, field: 'camp_id', value: row.camp_id })
    }
  }

  const run = db.transaction((rows) => {
    for (const e of rows) {
      // Provenance comes from the DOCUMENT, which now carries it
      // (docs/adr/2026-09-09-field-provenance-in-the-document.md). This is the
      // whole reason that ADR is sequenced ahead of this one: without a marker
      // in the document there is no truthful value to record here. 'human'
      // would wrongly protect every imported field from re-import; 'import'
      // would drop the protection the director is relying on. Inventing either
      // would make this table lie, which is worse than it being incomplete.
      //
      // A delete has no field of its own to attribute, so it carries NULL —
      // the same thing appendOp records when a caller names no source.
      const source =
        e.field === DELETE_FIELD
          ? null
          : (doc && isHumanEdited(doc, e.entity, e.entity_id, e.field) ? 'human' : 'import')

      insert.run(
        randomUUID(),
        e.entity,
        e.entity_id,
        e.field,
        // A delete's value is meaningless; every other field is coerced exactly
        // as appendOp coerces a local write, so a row's shape does not depend on
        // whether it arrived locally or by merge.
        e.field === DELETE_FIELD ? null : coerceOpValue(e.value ?? null),
        // author_user_id stays NULL: the document carries no author
        // (CRDT_SECURITY_GAPS item 8), and guessing one would put a name against
        // an edit that person may not have made.
        null,
        deviceRow.id,
        now,
        source
      )
    }
  })

  // Derived rows FIRST: restore reads the history in seq order, and camp_id
  // must be present as part of the record's arrival rather than after its
  // deletion.
  const all = [...derived, ...events]
  run(all)
  return { written: all.length, skipped: 0 }
}

/** Test seam — the warn-once set is process-global by design. */
export function resetLedgerWarnings() {
  warnedPeers.clear()
}
