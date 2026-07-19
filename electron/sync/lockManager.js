function assertValidDeviceId(device_id) {
  if (typeof device_id !== 'string' || device_id === '') {
    throw new Error('device_id must be a non-empty string')
  }
}

export function acquireLock(db, { entity, entity_id, field, device_id }) {
  assertValidDeviceId(device_id)
  const existing = db.prepare('SELECT * FROM locks WHERE entity = ? AND entity_id = ? AND field = ?')
    .get(entity, entity_id, field)
  if (existing && existing.holder_device_id !== device_id) {
    return { granted: false, holder_device_id: existing.holder_device_id }
  }
  db.prepare(`INSERT INTO locks (entity, entity_id, field, holder_device_id, acquired_at)
    VALUES (?, ?, ?, ?, datetime('now'))
    ON CONFLICT(entity, entity_id, field) DO UPDATE SET holder_device_id = excluded.holder_device_id, acquired_at = excluded.acquired_at`)
    .run(entity, entity_id, field, device_id)
  return { granted: true }
}

export function releaseLock(db, { entity, entity_id, field, device_id }) {
  assertValidDeviceId(device_id)
  db.prepare('DELETE FROM locks WHERE entity = ? AND entity_id = ? AND field = ? AND holder_device_id = ?')
    .run(entity, entity_id, field, device_id)
}

export function expireLocks(db, olderThanMs) {
  const cutoffSeconds = Math.floor(olderThanMs / 1000)
  const result = db.prepare(`DELETE FROM locks WHERE acquired_at < datetime('now', '-' || ? || ' seconds')`)
    .run(cutoffSeconds)
  return result.changes
}
