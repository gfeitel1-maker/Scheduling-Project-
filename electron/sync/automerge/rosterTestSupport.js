// Test-only (docs/adr/2026-10-12-shared-signed-device-roster.md, T376). Admission now reads the device-local roster_cache,
// which projector.js derives from Host-signed document entries (deviceRoster.projector.test.js and
// deviceRoster.integration.test.js cover that derivation end to end). Tests that exercise something else and just need two
// nodes to admit each other write the DERIVED row directly through here instead of forging a signed document entry.
export function rosterDevice(db, deviceId, peerId) {
  db.prepare('INSERT OR REPLACE INTO roster_cache (device_id, peer_id, verified_at) VALUES (?, ?, ?)').run(
    deviceId,
    String(peerId),
    new Date().toISOString()
  )
}

/** Put every `{ deviceId, peerId }` in `members` on the roster of every db in `dbs`. */
export function rosterEveryone(dbs, members) {
  for (const db of dbs) for (const m of members) rosterDevice(db, m.deviceId, m.peerId)
}
