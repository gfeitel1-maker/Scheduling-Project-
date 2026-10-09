// Pair again, step one: apply the camp's signed purge tombstones to THIS device's own document
// before it merges with the camp. A device that was offline through a purge still holds the erased
// camper; merging first would carry it back into the camp's document. Deleting it locally first
// means the merge carries the deletion instead (the camp's regenerated document never had the
// record, so the device's create and delete both arrive and the record stays gone).
import { applyWrites, listRecordIds, readRecord } from './campDocument.js'
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
