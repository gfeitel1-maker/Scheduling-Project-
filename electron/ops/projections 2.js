export const PROJECTIONS = {
  users: {
    table: 'users',
    key: 'id',
    fields: ['camp_id', 'name', 'pin_hash', 'pin_salt', 'role'],
    ensureExists: (db, id) =>
      db
        .prepare(
          "INSERT OR IGNORE INTO users (id, camp_id, name, pin_hash, pin_salt, role) VALUES (?, NULL, '', '', '', 'staff')"
        )
        .run(id),
  },
}

export function applyProjection(db, op) {
  const projection = PROJECTIONS[op.entity]
  if (!projection) return

  if (!projection.fields.includes(op.field)) return

  projection.ensureExists?.(db, op.entity_id)

  db.prepare(`UPDATE ${projection.table} SET ${op.field} = ? WHERE ${projection.key} = ?`).run(
    op.value,
    op.entity_id
  )
}
