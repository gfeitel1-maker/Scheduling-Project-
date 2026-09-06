// Stage 5c review round, Finding 1 (CRITICAL — data destruction) and Finding 2 (unbatched IPC
// fan-out): the two decisions main.js's startAutomergeSyncNodeIfEnabled needs to make, pulled out
// into pure, Electron-free functions so they're unit-testable without booting a window, a libp2p
// node, or mocking `electron`. main.js is the only caller; this module has no side effects of its
// own.

// Finding 1: which document (if any) is safe to start the sync node with. projectAll's
// delete-reconcile treats the doc as an authoritative superset of SQLite — a doc that was never
// seeded from existing SQLite (the common case before Stage 5e wires seedAllFromSqlite) is not that,
// and projecting it deletes live data (confirmed empirically, see projector.test.js's regression
// test). So: prefer liveDoc's in-memory copy (5b's write-path mirror — only ever holds a doc it
// already loaded-or-seeded and persisted), then the persisted file (§5). NEVER synthesize a fresh
// empty document here — a null return means "this camp has not been seeded yet," and the caller
// must refuse to start rather than fall back to createEmptyDoc().
export function resolveStartupDoc({ liveDoc, persistedDoc }) {
  return liveDoc ?? persistedDoc ?? null
}

// Finding 2: a single merge from a device that's been offline can advance hundreds of fields in one
// onRemoteOps call. Sending one 'shoresh:op-applied' per field fires that many full reloads back to
// back (ScheduleScreen reloads unconditionally on every non-self event, no debounce). Above
// `threshold` changed fields in one batch, collapse to a single 'shoresh:full-sync-applied' — the
// existing "re-read everything" contract — instead. Below it, send individual events exactly as
// before, each still passed through `sanitizeOpForIpc` (never skipped, never reimplemented).
//
// Threshold rationale: 20 sits comfortably above the field count of even a busy single-sitting edit
// (a handful of fields per record, a handful of records) and comfortably below the "hundreds of
// fields" shape a catch-up merge produces after a device has been offline — there is nothing
// load-bearing about the exact number since normal usage sits nowhere near either boundary.
export const REMOTE_OPS_COALESCE_THRESHOLD = 20

export function dispatchRemoteOps(events, { send, sanitizeOpForIpc, threshold = REMOTE_OPS_COALESCE_THRESHOLD } = {}) {
  if (events.length > threshold) {
    send('shoresh:full-sync-applied')
    return
  }
  for (const event of events) {
    send('shoresh:op-applied', sanitizeOpForIpc(event))
  }
}
