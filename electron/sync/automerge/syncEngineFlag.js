// Stage 5 flag (docs/work/plans/2026-09-06-stage5-live-wiring-design.md § 1): which sync engine
// drives the write/replay path. Read ONCE at import, mirroring this repo's existing env-driven
// dev toggles (e.g. SHORESH_SMOKE_NONCE, electron/preload.js). Pure — no DB or file I/O.
//
// Fail-safe: any value other than exactly 'automerge' resolves to 'oplog', the current, unchanged
// behavior. This means flag-OFF (including an unset or mistyped env var) can never itself be a new
// failure mode.
const rawValue = process.env.SHORESH_SYNC_ENGINE

export const SYNC_ENGINE = rawValue === 'automerge' ? 'automerge' : 'oplog'

export function isAutomergeEngine() {
  return SYNC_ENGINE === 'automerge'
}

export function isOpLogEngine() {
  return SYNC_ENGINE === 'oplog'
}
