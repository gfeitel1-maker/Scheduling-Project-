// "A camp peer told THIS device it is no longer allowed in" — recorded durably, on this device.
//
// Packaged E2E on 42275c9f: after A removed B, B went on as if nothing had happened. Nothing on B
// ever learned the fact, because the only thing that could carry it — the `auth_failed` frame A
// sends to a refused `authenticate` — either never got sent (A dropped admission but kept the
// connection, so B never re-authenticated) or was cut off by A aborting the stream straight after
// writing it (B read EOF, an AUTH_ERROR indistinguishable from a network blip).
//
// ONLY AN AUTHORITATIVE REFUSAL COUNTS. A timeout, a dropped stream, a peer that is offline — none
// of these say anything about whether this device is still in the camp, and none may set this.
// The refusal reasons below are the ones evaluateAuthenticate (electron/auth/connectionAuth.js)
// returns when the camp has revoked this device; they reach us only after the peer verified a
// valid camp token for this device id, so they are not something an arbitrary stranger can send
// to make the director think the device was removed — at worst a peer that can read the camp
// token can claim it, and the remedy (Pair again) is the same either way.
//
// Stored as a deterministic-id row in device_health_events (host-local, no schema change): it is
// exactly that table's kind of fact — something about this device the director must see, that
// survives a restart, cleared when resolved. Local data is never touched.
import { DEVICE_HEALTH, recordDeviceHealthEvent } from '../../ops/deviceHealthEvents.js'

export const REMOVED_FROM_CAMP_REASONS = new Set(['device_revoked', 'device_revoked_by_authority'])
const ROW_ID = 'self:removed_from_camp'

export function isRemovalRefusal(reply) {
  return !!reply && reply.type === 'auth_failed' && REMOVED_FROM_CAMP_REASONS.has(reply.reason)
}

/** Records the removal. Returns true when the row is present afterwards (reported, not assumed). */
export function markRemovedFromCamp(db, { peerId, reason } = {}) {
  try {
    // Re-arms a previously cleared row rather than leaving it resolved.
    db.prepare('UPDATE device_health_events SET resolved_at = NULL WHERE id = ?').run(ROW_ID)
  } catch { /* the insert below reports */ }
  recordDeviceHealthEvent(db, {
    id: ROW_ID,
    kind: DEVICE_HEALTH.REMOVED_FROM_CAMP,
    detail: JSON.stringify({ peerId: peerId ?? null, reason: reason ?? null }),
    incident: 'removed-from-camp',
  })
  return isRemovedFromCamp(db)
}

export function isRemovedFromCamp(db) {
  try {
    return !!db.prepare('SELECT 1 FROM device_health_events WHERE id = ? AND resolved_at IS NULL').get(ROW_ID)
  } catch {
    return false
  }
}

/** Pair again succeeded: the camp let this device back in. */
export function clearRemovedFromCamp(db) {
  try {
    db.prepare('UPDATE device_health_events SET resolved_at = ? WHERE id = ? AND resolved_at IS NULL').run(new Date().toISOString(), ROW_ID)
    return true
  } catch (err) {
    console.error(`selfRemoval: could not clear the removed-from-camp state: ${err?.message ?? err}`)
    return false
  }
}
