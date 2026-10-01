// Stage 5 flag (docs/work/plans/2026-09-06-stage5-live-wiring-design.md § 1): which sync engine
// drives the write/replay path. Read ONCE at import, mirroring this repo's existing env-driven
// dev toggles (e.g. SHORESH_SMOKE_NONCE, electron/preload.js). Pure — no DB or file I/O.
//
// Stage 6b (docs/work/plans/2026-09-07-stage6-cutover-plan.md): the default is now `automerge`.
// The owner released the op-log once the correctness regression that was holding it open — two
// devices concurrently editing losing one side's work — was fixed at its source by the flat record
// shape (docs/adr/2026-09-08-flat-record-shape.md).
//
// ⚠️ _Prior, and VOID rather than merely re-described: "`oplog` stays EXPLICITLY selectable for
// this slice, deliberately. 6b is the reversible step: a device that hits trouble is one env var
// away from the old engine, and the WS layer and op-log are both still present to fall back onto.
// Nothing is deleted until 6c/6d, which are gated on the integration harness reaching its bar."
// 6c happened. The WS layer is deleted, there is no second engine, and `oplog` is NOT a recovery
// route — nobody may read this header as one. The reason the escape hatch was kept (reversibility
// while the engine was young) survives only as history; the parser below still accepts the value,
// and what selecting it does TODAY is:
//   - appendOp and appendBulkReplaceOp early-return on isOpLogEngine() before mirroring anything
//     into the Automerge document, stamping DOCUMENT_OUTCOME='engine-off' (electron/ops/operations.js,
//     vocabulary in documentOutcome.js); and
//   - syncStarter.js never starts a sync node at all (`if (!isAutomergeEngine()) return`), which
//     main.js's own startup condition and getSyncStatus are written to treat as healthy rather than
//     broken.
// The write itself still succeeds: the row lands in local SQLite and the op log exactly as before,
// and NOTHING replicates — no error, no warning, no degraded-mode notice anywhere. A device started
// with SHORESH_SYNC_ENGINE=oplog is a silent single-device island until the variable is unset and
// the app restarted, because the value is read once at import. The one legitimate remaining use is
// as a measurement arm that isolates the dual-write cost (scripts/electiveFreezePerf.mjs imports
// SYNC_ENGINE for exactly that, and main.js reports the resolved engine to the renderer). Removing
// the flag outright is a behaviour change and is deliberately not done here._
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
