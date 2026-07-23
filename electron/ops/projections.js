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
  cohorts: {
    table: 'cohorts',
    key: 'id',
    fields: [
      'camp_id',
      'name',
      'session_week_start',
      'session_week_end',
      'capacity_source',
      'anchor_model',
      'sort_order',
    ],
    ensureExists: (db, id) => {
      // MEDIUM (deferred per Sub-plan B Task 2 round 1 Red Hat review,
      // revisit in Task 3): a zero-camps db makes camp?.id resolve to null,
      // which is silently inserted rather than surfaced as an error.
      const camp = db.prepare('SELECT id FROM camps LIMIT 1').get()
      db.prepare("INSERT OR IGNORE INTO cohorts (id, camp_id, name) VALUES (?, ?, '')").run(
        id,
        camp?.id ?? null
      )
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
