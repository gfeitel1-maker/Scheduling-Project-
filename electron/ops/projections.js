export const PROJECTIONS = {
  users: {
    table: 'users',
    key: 'id',
    fields: ['camp_id', 'name', 'pin_hash', 'pin_salt', 'role'],
    ensureExists: (db, id) => {
      // The placeholder row below uses '' as a stand-in camp_id (satisfying the NOT NULL/
      // FK constraint on users.camp_id) until a real camp_id op overwrites it in the same
      // batch. Ensure that sentinel camp row exists first so the FK doesn't reject the insert.
      db.prepare("INSERT OR IGNORE INTO camps (id, name) VALUES ('', '')").run()
      db.prepare(
        "INSERT OR IGNORE INTO users (id, camp_id, name, pin_hash, pin_salt, role) VALUES (?, '', '', '', '', 'staff')"
      ).run(id)
    },
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
