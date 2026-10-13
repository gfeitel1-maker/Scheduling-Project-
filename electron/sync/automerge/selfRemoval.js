// "A camp peer told THIS device it is no longer allowed in" — recorded durably, on this device.
//
// Packaged E2E on 42275c9f: after A removed B, B went on as if nothing had happened. Nothing on B
// ever learned the fact, because the only thing that could carry it — the `auth_failed` frame A
// sends to a refused `authenticate` — either never got sent (A dropped admission but kept the
// connection, so B never re-authenticated) or was cut off by A aborting the stream straight after
// writing it (B read EOF, an AUTH_ERROR indistinguishable from a network blip).
//
// THE RULE: a device records its own removal ONLY when ITS OWN trust state — the signed authority log it holds
// (T331 revoke entries, re-derived into authority_cache) — says it is revoked. A peer's refusal of ANY kind
// (device_not_authorized, device_not_found, device_revoked, device_revoked_by_authority) is never a verdict by
// itself: a joining device that has no roster yet refuses the very host that is approving it, and a hostile peer can
// claim anything. A refusal is only a reason to re-check own state, and a revocation refusal carries the signed revoke
// entries so a genuinely removed device — refused by every peer, unable to sync — can verify and merge them first
// (removalEvidence.js). Unsigned, forged, wrong-camp or non-admin-signed claims verify against nothing and change
// nothing. Timeouts, dropped streams and offline peers never set this either.
//
// _Prior: any refusal with reason device_revoked / device_revoked_by_authority set this, on the premise that the peer
// had first verified a valid camp token for this device. T376 removed tokens from admission, so any peer could say it._
//
// Stored as a deterministic-id row in device_health_events (host-local, no schema change): it is
// exactly that table's kind of fact — something about this device the director must see, that
// survives a restart, cleared when resolved. Local data is never touched.
import { DEVICE_HEALTH, recordDeviceHealthEvent } from '../../ops/deviceHealthEvents.js'

const ROW_ID = 'self:removed_from_camp'

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
