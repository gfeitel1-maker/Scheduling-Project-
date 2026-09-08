// Stage 5 flag (docs/work/plans/2026-09-06-stage5-live-wiring-design.md § 1): which sync engine
// drives the write/replay path. Read ONCE at import, mirroring this repo's existing env-driven
// dev toggles (e.g. SHORESH_SMOKE_NONCE, electron/preload.js). Pure — no DB or file I/O.
//
// Stage 6b (docs/work/plans/2026-09-07-stage6-cutover-plan.md): the default is now `automerge`.
// The owner released the op-log once the correctness regression that was holding it open — two
// devices concurrently editing losing one side's work — was fixed at its source by the flat record
// shape (docs/adr/2026-09-08-flat-record-shape.md).
//
// `oplog` stays EXPLICITLY selectable for this slice, deliberately. 6b is the reversible step: a
// device that hits trouble is one env var away from the old engine, and the WS layer and op-log are
// both still present to fall back onto. Nothing is deleted until 6c/6d, which are gated on the
// integration harness reaching its bar — see the plan's "6a before anything is deleted".
//
// The fail-safe direction is therefore INVERTED from Stage 5: an unset or mistyped value now
// resolves to `automerge`. That is the point of the flip, but it means a typo can no longer
// silently keep you on the old engine, so selecting `oplog` must be exact.
const rawValue = process.env.SHORESH_SYNC_ENGINE

export const SYNC_ENGINE = rawValue === 'oplog' ? 'oplog' : 'automerge'

export function isAutomergeEngine() {
  return SYNC_ENGINE === 'automerge'
}

export function isOpLogEngine() {
  return SYNC_ENGINE === 'oplog'
}
