// Single query, single column set, covering every current call site's needs — including
// device_secret_identifier, which only handleLogin reads, so handleLogin needs no second query.
// docs/adr/2026-08-17-sync-auth-layer-deepening.md, C3.
export function deviceTrustStatus(db, deviceId) {
  const row = db
    .prepare('SELECT id, authorized_at, revoked_at, device_secret_identifier FROM devices WHERE id = ?')
    .get(deviceId)
  return {
    found: !!row,
    authorized: !!row?.authorized_at,
    revoked: !!row?.revoked_at,
    row: row ?? null,
  }
}

// Canonical reason precedence — owner-directed harmonization, accepted 2026-08-17 (see
// docs/adr/2026-08-17-sync-auth-layer-deepening.md's acceptance note). Revoked wins over
// not-authorized: a device with revoked_at set is reported as 'device_revoked' regardless of
// whether authorized_at was ever set. Returns null when the device is fully trusted (found,
// authorized, not revoked).
export function deviceTrustReason(trust) {
  if (!trust.found) return 'device_not_found'
  if (trust.revoked) return 'device_revoked'
  if (!trust.authorized) return 'device_not_authorized'
  return null
}
