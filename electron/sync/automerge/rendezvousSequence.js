// Device-local rendezvous publish sequence.
// docs/adr/2026-09-18-rendezvous-record-encoding-and-namespace-rotation.md, Decision 2.
//
// `seq` is deliberately device-local and disposable (unlike `epoch`, which lives on the camp
// Automerge document — electron/sync/automerge/rendezvousNamespace.js): a device rebuild loses
// its `seq` entirely, which is fine, because a rebuilt device also gets a fresh
// device_identity_key and can never again produce a valid signature for its old peerId. Sequence
// numbers need not be gapless, only increasing, so an unknown-outcome publish is safe to retry
// with a higher value.
//
// Same singleton `id = 1` shape as device_identity_key/host_signing_key, and the same exclusion
// class: this table must NEVER be registered in PROJECTIONS, campScopedEntities.js, or
// campDocument.js's MODELED_ENTITIES — see rendezvousSequence.migration.test.js's standing guard,
// mirroring electron/db/deviceIdentityKey.migration.test.js.
export function nextSequence(db) {
  return db.transaction(() => {
    db.prepare('INSERT OR IGNORE INTO rendezvous_sequence (id, seq) VALUES (1, 0)').run()
    db.prepare('UPDATE rendezvous_sequence SET seq = seq + 1 WHERE id = 1').run()
    return db.prepare('SELECT seq FROM rendezvous_sequence WHERE id = 1').get().seq
  })()
}
