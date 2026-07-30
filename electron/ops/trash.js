import { DELETE_FIELD, BULK_REPLACE_FIELD } from './operations.js'
import { isPinField } from './pinFields.js'
import { RESTORABLE_ENTITIES, lastKnownFields, nameFieldFor } from './restore.js'

// What was deleted, by whom, and when — read straight out of the op log,
// which has held all of it since the first delete and never showed a director
// any of it.
//
// NOT INDEXED, and it must not be described as if it were.
// idx_operations_entity(entity, entity_id, field) covers a per-record read;
// this is a grouped scan over the whole log. That is fine at camp scale (a
// season's op count is thousands, not millions) and is written as ONE grouped
// query rather than N+1 per entity so it stays that way.
//
// `seq` is this device's own local sequence. On a Client that is receive
// order, not the Host's canonical order — good enough for "which op is the
// latest for this record", which is all this needs, because ops arrive in
// broadcast order.
//
// Scoped to restorable entities deliberately: offering a director a row whose
// Restore button the handler would refuse is worse than not listing it.
export function listDeleted(db) {
  const rows = db
    .prepare(
      `SELECT o.entity, o.entity_id, o.timestamp AS deleted_at, o.author_user_id AS deleted_by_user_id,
              o.device_id AS deleted_on_device_id,
              u.name AS deleted_by_name, d.name AS deleted_on_device_name
         FROM operations o
         JOIN (SELECT entity, entity_id, MAX(seq) AS mx FROM operations GROUP BY entity, entity_id) m
           ON m.entity = o.entity AND m.entity_id = o.entity_id AND m.mx = o.seq
         LEFT JOIN users u ON u.id = o.author_user_id
         LEFT JOIN devices d ON d.id = o.device_id
        WHERE o.field = ?
        ORDER BY o.timestamp DESC`
    )
    .all(DELETE_FIELD)

  return rows
    .filter((row) => RESTORABLE_ENTITIES.has(row.entity))
    .map((row) => ({
      ...row,
      name: lastKnownFields(db, row.entity, row.entity_id).get(nameFieldFor(row.entity)) ?? null,
    }))
}

// Who changed what, when, for one record. Ascending by seq. `previous_value`
// is derived, not stored: the prior op on the same (entity, entity_id, field).
//
// PIN MATERIAL IS WITHHELD. Both value and previous_value are omitted
// entirely (not blanked) for users.pin_hash/pin_salt, using the same list the
// op-applied IPC push filters on — see electron/ops/pinFields.js. The change
// itself still appears, so a director can see that a PIN was changed without
// the digest crossing the boundary.
export function getEntityHistory(db, { entity, entity_id }) {
  if (typeof entity !== 'string' || typeof entity_id !== 'string') return []

  const rows = db
    .prepare(
      `SELECT o.seq, o.field, o.value, o.timestamp, o.author_user_id, o.device_id,
              u.name AS author_name, d.name AS device_name
         FROM operations o
         LEFT JOIN users u ON u.id = o.author_user_id
         LEFT JOIN devices d ON d.id = o.device_id
        WHERE o.entity = ? AND o.entity_id = ?
        ORDER BY o.seq ASC`
    )
    .all(entity, entity_id)

  const seen = new Map()
  return rows.map((row) => {
    const previous = seen.has(row.field) ? seen.get(row.field) : null
    seen.set(row.field, row.value)

    const entry = {
      seq: row.seq,
      field: row.field,
      timestamp: row.timestamp,
      author_user_id: row.author_user_id,
      author_name: row.author_name ?? null,
      device_id: row.device_id,
      device_name: row.device_name ?? null,
    }
    if (isPinField(entity, row.field)) return entry
    // A bulk_replace value is the whole scope's row set as JSON — megabytes of
    // machine detail with nothing in it for a director to read.
    if (row.field === BULK_REPLACE_FIELD) return entry
    return { ...entry, value: row.value, previous_value: previous }
  })
}
