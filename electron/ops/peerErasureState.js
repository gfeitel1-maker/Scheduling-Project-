// T322 S3b — the per-peer erasure-state read behind the Device Manager badge.
// docs/work/tickets/T322-per-peer-erasure-state-ui.md (S3b); scoping note
// docs/work/specs/2026-10-01-t233-s3-per-peer-erasure-state-ui-design.md.
//
// A purged camper is suppressed fleet-wide by a signed, monotonic purge-tombstone
// gated at projection time (T233 S1/S2). S3a added `peer_tombstone_reports`: over
// the authenticated `authenticate` handshake, a peer self-reports the set of
// (tombstone id, version) pairs it has verified-and-projected. This module turns
// that into the per-peer verdict the director sees.
//
// The verdict is deliberately per-id, never scalar-vs-max: `tombstones.version`
// is per-camper-id (mirrors cred_version), not a global sequence (ADR
// 2026-09-19 "Addendum (2026-10-01, Architect, T322 S3a)"). A peer is
// LOGICALLY_ERASED only when, for EVERY real tombstone, it has reported an
// applied version >= that tombstone's version; otherwise UNKNOWN. UNKNOWN is the
// honest default — a peer that reported nothing, or is behind on even one
// tombstone, or that this device simply cannot hear from, all read UNKNOWN,
// never silently erased (ticket never-claim #3).
export const PEER_ERASURE_STATE = {
  LOGICALLY_ERASED: 'LOGICALLY_ERASED',
  UNKNOWN: 'UNKNOWN',
}

// Pure verdict. `tombstones`: [{ id, version }] of REAL purge-tombstones.
// `reports`: rows from peer_tombstone_reports. `peerDeviceIds`: the device ids to
// score (the local device is excluded by the caller — it never self-reports and
// is not a propagation target). Returns {} when there are no tombstones, so the
// UI shows no column until a purge has actually happened.
export function computePeerErasureStates({ tombstones, reports, peerDeviceIds }) {
  const states = {}
  if (!Array.isArray(tombstones) || tombstones.length === 0) return states

  // device_id -> Map(tombstone_id -> highest reported applied version)
  const byDevice = new Map()
  for (const r of reports ?? []) {
    if (!r || typeof r.device_id !== 'string' || typeof r.tombstone_id !== 'string') continue
    if (typeof r.version !== 'number' || !Number.isFinite(r.version)) continue
    let seen = byDevice.get(r.device_id)
    if (!seen) {
      seen = new Map()
      byDevice.set(r.device_id, seen)
    }
    const prev = seen.get(r.tombstone_id)
    if (prev === undefined || r.version > prev) seen.set(r.tombstone_id, r.version)
  }

  for (const deviceId of peerDeviceIds ?? []) {
    const seen = byDevice.get(deviceId)
    let caughtUpOnAll = true
    for (const t of tombstones) {
      const reported = seen?.get(t.id)
      if (reported === undefined || reported < t.version) {
        caughtUpOnAll = false
        break
      }
    }
    states[deviceId] = caughtUpOnAll
      ? PEER_ERASURE_STATE.LOGICALLY_ERASED
      : PEER_ERASURE_STATE.UNKNOWN
  }
  return states
}

// db-backed read for the IPC handler. Reads only REAL purge-tombstones
// (version >= 1 — the version-0/empty-sig row a field-by-field projection's
// ensureExists creates is a placeholder, not a purge event), the peer self-report
// rows, and the peer device ids the Device Manager actually renders (same
// `pairing_status IS NOT 'unknown'` filter as listDevices, minus this device).
// Read-only: it never writes peer_tombstone_reports (that is S3a's sole,
// authenticated write path) and takes no action.
export function listPeerErasureStateFromDb(db, { localDeviceId } = {}) {
  const tombstones = db.prepare('SELECT id, version FROM tombstones WHERE version >= 1').all()
  const peerRows = db
    .prepare("SELECT id FROM devices WHERE pairing_status IS NOT 'unknown' AND id IS NOT ?")
    .all(localDeviceId ?? null)
  const peerDeviceIds = peerRows.map((row) => row.id)

  const reports =
    tombstones.length === 0
      ? []
      : db.prepare('SELECT device_id, tombstone_id, version FROM peer_tombstone_reports').all()

  const states = computePeerErasureStates({ tombstones, reports, peerDeviceIds })
  return { hasErasure: tombstones.length > 0, states, localDeviceId: localDeviceId ?? null }
}
