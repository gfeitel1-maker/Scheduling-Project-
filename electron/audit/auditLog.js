const SECRET_KEYS = new Set([
  'pin',
  'pin_hash',
  'pinhash',
  'pin_salt',
  'pinsalt',
  'signing_secret',
  'signingsecret',
  'token',
])

// Recurses into nested plain objects/arrays so a secret buried in a nested
// metadata shape (e.g. { context: { pin: ... } }) is scrubbed too, not just
// top-level keys. Arrays and non-plain objects (Buffer, Date, etc.) are not
// treated as key/value bags — recursing element-by-element rather than via
// Object.entries avoids numeric-index keys silently bypassing SECRET_KEYS.
function scrubValue(value) {
  if (Array.isArray(value)) return value.map(scrubValue)
  if (value && typeof value === 'object' && value.constructor === Object) {
    const scrubbed = {}
    for (const [key, v] of Object.entries(value)) {
      if (SECRET_KEYS.has(key.toLowerCase())) continue
      scrubbed[key] = scrubValue(v)
    }
    return scrubbed
  }
  return value
}

function scrubMetadata(metadata) {
  if (!metadata || typeof metadata !== 'object' || metadata.constructor !== Object) return null
  return scrubValue(metadata)
}

// Single writer for the audit_events table — see
// docs/adr/2026-07-25-append-only-audit-event-log.md. Never throws: a
// failure here must never block or corrupt the real authorization decision
// it's recording.
export function recordAuditEvent(
  db,
  { campId, actorUserId, deviceId, action, targetType, targetId, outcome, reason, metadata } = {}
) {
  try {
    const resolvedCampId = campId ?? db.prepare('SELECT id FROM camps LIMIT 1').get()?.id ?? null
    const scrubbed = scrubMetadata(metadata)
    db.prepare(
      `INSERT INTO audit_events
        (camp_id, actor_user_id, device_id, action, target_type, target_id, occurred_at, outcome, reason, metadata)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      resolvedCampId,
      actorUserId ?? null,
      deviceId ?? null,
      action,
      targetType ?? null,
      targetId ?? null,
      new Date().toISOString(),
      outcome,
      reason ?? null,
      scrubbed ? JSON.stringify(scrubbed) : null
    )
  } catch (err) {
    console.warn(`recordAuditEvent: failed to write audit event for action=${action}: ${err.message}`)
  }
}

export function listAuditEvents(db, { limit = 100, actorUserId, action, outcome } = {}) {
  const clauses = []
  const params = []

  if (actorUserId !== undefined) {
    clauses.push('actor_user_id = ?')
    params.push(actorUserId)
  }
  if (action !== undefined) {
    clauses.push('action = ?')
    params.push(action)
  }
  if (outcome !== undefined) {
    clauses.push('outcome = ?')
    params.push(outcome)
  }

  const where = clauses.length ? ` AND ${clauses.join(' AND ')}` : ''
  params.push(limit)

  return db
    .prepare(`SELECT * FROM audit_events WHERE 1=1${where} ORDER BY id DESC LIMIT ?`)
    .all(...params)
}
