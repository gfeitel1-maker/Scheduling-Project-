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

// T194 / ADR docs/adr/2026-09-17-individual-elective-scheduling.md D9: no
// camper field value may reach audit_events.
//
// SECRET_KEYS above is a KEY-NAME blocklist and cannot be made to do this job:
// the hazard is the VALUE, not the key. No key name makes `'Sarah Cohen'` safe,
// and none makes it dangerous. And audit_events is APPEND-ONLY and survives
// deletion, so a name written here is unrecoverable by any purge, T202's
// included — there is no cleanup pass that can fix it afterwards.
//
// So the guard is structural and at the write: for these entities, every
// metadata value must come from a fixed safe set — ids, numbers, booleans,
// null, and the enum literals the v66 schema declares. A display name cannot
// pass, and neither can a filename.
const PARTICIPANT_ENTITIES = new Set([
  'campers',
  'elective_assignment_runs',
  'elective_occurrences',
  'elective_choices',
  'elective_choice_offerings',
  'elective_preferences',
  'elective_assignments',
])

// uuid + slug alphabet, PLUS ':' and '.' — because a DERIVED ID
// (electron/ops/electiveDerivedIds.js) is length-prefixed and version-tagged,
// e.g. `easgn1:5.run-18.camper-15.occ-1`. The design named a bare
// [A-Za-z0-9_-] set, which would have refused the very ids this feature is
// built on. Still no whitespace, so free text cannot pass.
const SAFE_SCALAR = /^[A-Za-z0-9_.:-]+$/

function assertNoParticipantFreeText(targetType, value, path) {
  if (value === null || value === undefined) return
  if (typeof value === 'number' || typeof value === 'boolean') return
  if (typeof value === 'string') {
    if (SAFE_SCALAR.test(value)) return
    throw new Error(
      `recordAuditEvent: refusing free text in participant metadata at '${path}' for ` +
        `targetType='${targetType}'. audit_events is append-only and survives every purge ` +
        `(ADR D9), so only ids, numbers, booleans and declared enum literals may be recorded ` +
        `for the participant entities. Pass an id, not a value.`
    )
  }
  if (Array.isArray(value)) {
    value.forEach((v, i) => assertNoParticipantFreeText(targetType, v, `${path}[${i}]`))
    return
  }
  if (typeof value === 'object' && value.constructor === Object) {
    for (const [k, v] of Object.entries(value)) {
      assertNoParticipantFreeText(targetType, v, `${path}.${k}`)
    }
    return
  }
  throw new Error(
    `recordAuditEvent: refusing a non-serializable participant metadata value at '${path}' ` +
      `for targetType='${targetType}'.`
  )
}

// Single writer for the audit_events table — see
// docs/adr/2026-07-25-append-only-audit-event-log.md. Never throws for an
// INFRASTRUCTURE failure: that must never block or corrupt the real
// authorization decision it's recording.
//
// The ONE deliberate exception is the participant PII guard below, which runs
// BEFORE the try block so it actually reaches the caller. That is not a
// relaxation of the never-throws contract — it is a different class of event.
// A DB error is the environment failing; free text in participant metadata is a
// CALLER BUG that would write an unerasable child's name, and this repo's
// standing rule is to surface write failures rather than swallow them. Throwing
// beats redacting because a redacted row is a silent behaviour change at the
// exact moment someone made a mistake. No caller passes participant metadata
// today, so this can only fire on newly-written code.
export function recordAuditEvent(
  db,
  { campId, actorUserId, deviceId, action, targetType, targetId, outcome, reason, metadata } = {}
) {
  if (PARTICIPANT_ENTITIES.has(targetType) && metadata != null) {
    assertNoParticipantFreeText(targetType, metadata, 'metadata')
  }

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
