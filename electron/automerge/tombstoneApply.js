// Pair again, step one: apply the camp's signed purge tombstones to THIS device's own document
// before it merges with the camp. A device that was offline through a purge still holds the erased
// camper; merging first would carry it back into the camp's document. Deleting it locally first
// means the merge carries the deletion instead (the camp's regenerated document never had the
// record, so the device's create and delete both arrive and the record stays gone).
import { applyWrites, listRecordIds, readRecord, readFieldAuthor, AUTHOR_COLLECTION, PROVENANCE_COLLECTION } from './campDocument.js'
import { verifyTombstone } from './tombstoneSignature.js'
import { TOMBSTONE_DENYLISTED_ENTITIES } from './projector.js'
import { DELETE_FIELD } from '../ops/operations.js'

/** Every tombstone must verify against the camp's signing key, or none are applied. */
export function verifyTombstones(publicKeyHex, tombstones) {
  if (!Array.isArray(tombstones)) return false
  return tombstones.every((t) => verifyTombstone(publicKeyHex, { id: t?.id, entity: t?.entity, version: Number(t?.version) }, t?.sig))
}

export function applyTombstonesToDoc(doc, tombstones) {
  const erased = new Set(tombstones.filter((t) => t.entity === 'campers').map((t) => t.id))
  if (erased.size === 0) return doc
  const deletes = []
  for (const [entity, { idField }] of Object.entries(TOMBSTONE_DENYLISTED_ENTITIES)) {
    if (!doc[entity]) continue
    for (const id of listRecordIds(doc, entity)) {
      const gate = idField === 'id' ? id : readRecord(doc, entity, id)?.[idField]
      if (erased.has(gate)) deletes.push({ entity, entity_id: id, field: DELETE_FIELD, value: null })
    }
  }
  return deletes.length ? applyWrites(doc, deletes) : doc
}

// Pair again, step two (keeper ruling): a camp-side DELETE wins over this device's offline FIELD
// EDITS to the same record. A delete removes every field key; Automerge keeps a put that was
// concurrent with that removal, so a plain merge brings the record back holding only the fields
// edited offline — a half-record. It cannot be pruned BEFORE the merge, because this device does
// not know what the camp deleted until the camp's document arrives. So after the merge, every such
// record is deleted again by a write authored HERE: it causally follows both the offline edit and
// the camp's delete, so it removes the surviving keys on every device and no field is in conflict.
//
// A record counts as deleted by the camp when, compared with this device's pre-merge document, the
// camp's delete marker newly appeared or one of its field keys disappeared (only a delete removes a
// key) — and every field still present is exactly this device's own pre-merge value, i.e. nothing
// in it came from the camp. The second condition leaves a record the camp deleted and then wrote
// again untouched. Records the camp did not delete keep their offline edits.
export function settleRejoinDeletes(preMergeDoc, mergedDoc) {
  const deletes = []
  for (const entity of Object.keys(preMergeDoc)) {
    if (entity === AUTHOR_COLLECTION || entity === PROVENANCE_COLLECTION) continue
    for (const id of listRecordIds(preMergeDoc, entity)) {
      const mine = readRecord(preMergeDoc, entity, id)
      const now = readRecord(mergedDoc, entity, id)
      if (!now) continue
      const marker = readFieldAuthor(mergedDoc, entity, id, DELETE_FIELD)
      const markerIsNew = marker !== null && readFieldAuthor(preMergeDoc, entity, id, DELETE_FIELD) === null
      const lostAKey = Object.keys(mine).some((f) => !(f in now))
      const onlyMine = Object.entries(now).every(([f, v]) => f in mine && JSON.stringify(mine[f]) === JSON.stringify(v))
      if ((markerIsNew || lostAKey) && onlyMine) {
        deletes.push({ entity, entity_id: id, field: DELETE_FIELD, value: null, ...(marker ? { author_user_id: marker } : {}) })
      }
    }
  }
  return deletes.length ? applyWrites(mergedDoc, deletes) : mergedDoc
}
