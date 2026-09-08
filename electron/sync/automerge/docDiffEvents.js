// Stage 5c (docs/work/plans/2026-09-06-stage5-live-wiring-design.md § 3): turns "the Automerge doc
// advanced from beforeHeads to afterHeads" into the same `{entity, entity_id, field, value,
// device_id, author_user_id}` shape the renderer's `shoresh:op-applied` consumers already parse
// (see main.js's sanitizeOpForIpc / wireOpApplied). Nothing today needs to turn a CRDT merge into
// an op-log-shaped push event — this is that translation, and only that.
//
// Grounded on @automerge/automerge 3.4.1 (verified by hand against this repo's installed version,
// per org-source-verification): A.diff(doc, before, after) returns patches shaped
// {action, path, value}. A STRING field is Automerge Text under the hood, so a string field write
// produces a `put` at [entity, entity_id, field] with value:"" followed by a `splice` patch at
// [entity, entity_id, field, 0] carrying the actual characters — TWO patches for one logical field
// change. Reading `patch.value` would therefore see the empty string, not the real value, for every
// string field. Fix: never read `patch.value` — use patch PATHS only to identify which
// (entity, entity_id, field) changed, then read the actual current value out of the after-state via
// A.view(doc, afterHeads). This handles strings, numbers, booleans, and objects uniformly, and it is
// also what naturally deduplicates the two string patches into one event (same path prefix, same
// dedup key).
//
// Pure module: no SQLite, no IPC, no Electron. Takes plain heads + a doc; the caller (syncNode.js)
// owns when to call this and what to do with the result.
import * as A from '@automerge/automerge'
import { DELETE_FIELD } from '../../ops/operations.js'
import { MODELED_ENTITIES, readRecord, splitRecordKey } from '../../automerge/campDocument.js'
import { PROJECTIONS } from '../../ops/projections.js'

// `deviceId` is the REMOTE peer the doc changes came from (or null if unknown) — never the local
// device id. This is load-bearing: src/screens/ScheduleScreen.jsx skips reloading when
// `op.device_id === localDeviceId`, so a synthesized remote-origin event must never be mistaken for
// a local one. This module has no notion of "local" at all — it only ever emits whatever the caller
// passes in — which is the actual guarantee: there is no code path here that could invent a local id.
export function synthesizeOpEvents(doc, beforeHeads, afterHeads, { deviceId = null } = {}) {
  const patches = A.diff(doc, beforeHeads, afterHeads)
  const afterDoc = A.view(doc, afterHeads)
  const seen = new Set()
  const events = []

  for (const patch of patches) {
    const entity = patch.path[0]
    if (entity === undefined || !MODELED_ENTITIES.has(entity)) continue

    // A patch path is now [entity, "<id>\u0000<field>"] — two segments, not
    // three, because a field is its own document key
    // (docs/adr/2026-09-08-flat-record-shape.md). Anything shorter carries no
    // record information; anything longer is inside a value we do not model.
    if (patch.path.length < 2) continue
    const parsed = splitRecordKey(String(patch.path[1]))
    if (!parsed) continue
    const { entityId: entity_id, field } = parsed

    // Whole-record delete vs. a single field going away. Under the flat shape a
    // record delete is N separate `del` patches, one per field key, so the
    // patch alone cannot tell them apart. Ask the resulting document instead:
    // if nothing is left of the record, it was deleted. That is a stronger test
    // than counting patches and does not depend on how Automerge batches them.
    if (patch.action === 'del' && readRecord(afterDoc, entity, entity_id) === null) {
      const key = `${entity}\u0000${entity_id}\u0000${DELETE_FIELD}`
      if (seen.has(key)) continue
      seen.add(key)
      events.push({ entity, entity_id, field: DELETE_FIELD, device_id: deviceId, author_user_id: null })
      continue
    }

    // Mirrors applyWrite's silent no-op rule (electron/automerge/campDocument.js): a field not
    // registered in PROJECTIONS[entity].fields never reaches SQLite, so no event should be
    // synthesized for it either — same fence, same silent behavior, on both sides.
    const fields = PROJECTIONS[entity]?.fields
    if (!fields || !fields.includes(field)) continue

    const key = `${entity}\u0000${entity_id}\u0000${field}`
    if (seen.has(key)) continue
    seen.add(key)

    const value = readRecord(afterDoc, entity, entity_id)?.[field]
    events.push({ entity, entity_id, field, value, device_id: deviceId, author_user_id: null })
  }

  return events
}
