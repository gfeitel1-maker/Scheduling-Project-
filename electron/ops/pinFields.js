// Fields whose raw op.value must never leave the main process.
//
// Extracted from electron/main.js so the two boundaries that need it —
// op-applied/op-conflict IPC pushes (main.js) and per-record history reads
// (ops/trash.js) — filter against ONE list rather than two copies that can
// drift. A user's history is the read-boundary twin of the restore allowlist:
// without this, `getEntityHistory('users', …)` would hand a scrypt digest and
// its salt to any authenticated caller
// (docs/adr/2026-07-30-restore-deleted-records-from-the-op-log.md §6).
export const IPC_PIN_FIELDS = new Set(['pin_hash', 'pin_salt'])

export function isPinField(entity, field) {
  return entity === 'users' && IPC_PIN_FIELDS.has(field)
}
