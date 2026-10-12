// The shared signed device roster (docs/adr/2026-10-12-shared-signed-device-roster.md, T376). One document
// record per enrolled device (record id = device_id); the Host signs it, every device verifies it against
// camps.signing_public_key and projects it into the device-local roster_cache (projector.js's
// upsertDeviceRosterEntity). Admission between devices reads roster_cache, so it needs no Host.
import { appendOp } from '../ops/operations.js'
import { signRosterEntry } from './deviceRosterSignature.js'
import { DEVICE_ROSTER_FIELDS } from './campDocument.js'

export const DEVICE_ROSTER_ENTITY = 'device_roster'

/**
 * The document writes that enroll `deviceId` (bound to `peerId`), or null when this device cannot sign
 * (not the Host) or the device is already cached under that peer id. Pure data: the caller applies them
 * through whichever write path it owns (appendOp in main.js, applyWrite on a live node).
 */
export function buildRosterWrites(db, { deviceId, peerId }) {
  if (typeof deviceId !== 'string' || !deviceId || typeof peerId !== 'string' || !peerId) return null
  if (!db.prepare('SELECT 1 FROM host_signing_key WHERE id = 1').get()) return null
  const cached = db.prepare('SELECT peer_id FROM roster_cache WHERE device_id = ?').get(deviceId)
  if (cached?.peer_id === peerId) return null
  const campId = db.prepare('SELECT id FROM camps LIMIT 1').get()?.id
  if (!campId) return null
  const addedAt = new Date().toISOString()
  const sig = signRosterEntry(db, { id: deviceId, camp_id: campId, device_id: deviceId, device_peer_id: peerId, added_at: addedAt })
  const hostDeviceId = db.prepare('SELECT id FROM device_identity LIMIT 1').get()?.id ?? ''
  const values = { device_id: deviceId, device_peer_id: peerId, added_at: addedAt, added_by_device_id: hostDeviceId, sig }
  return DEVICE_ROSTER_FIELDS.map((field) => ({ entity: DEVICE_ROSTER_ENTITY, entity_id: deviceId, field, value: values[field] }))
}

/**
 * Enroll through the generic op-log dual-write (appendOp mirrors into the document), exactly as authorityLog.js
 * mints its entries. Used by bootstrapCamp for the Host's own entry; a live node uses buildRosterWrites directly.
 * Returns true when an entry was written.
 */
export function mintRosterEntry(db, { deviceId, peerId }) {
  const writes = buildRosterWrites(db, { deviceId, peerId })
  if (!writes) return false
  for (const w of writes) appendOp(db, { ...w, device_id: deviceId })
  return true
}
