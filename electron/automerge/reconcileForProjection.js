// The single place that turns "a document that may carry an unhandled conflict" into "a document
// that is safe to hand to projectAll/projectEntity" — derive both conflict shapes and record them,
// so assertConflictsRecorded (projector.js) finds what it expects instead of throwing.
//
// Extracted from syncNode.js's own reconcileForProjection (T235/T242 finding 2): every OTHER
// caller of projectAll that projects a document loaded from disk — rather than one this same
// module just reconciled inline — skipped this step entirely. A fresh rebuild, a purge, and a
// post-key-recovery reproject each called projectAll directly against a document that can
// perfectly well carry a live hard-set collision, and assertConflictsRecorded's unique guard (by
// design, see projector.js) throws for exactly that document. That turned three disaster-recovery
// commands into "permanently refuses to run whenever a camp has an outstanding conflict the app
// already told the director about" — the opposite of what a recovery tool is for. Fix here, once,
// so every projectAll caller shares the same guarantee syncNode's merge path already had.
import { reconcile } from './reconcile.js'
import { deriveUniqueConflicts } from './uniqueConflicts.js'
import {
  recordConflicts,
  clearResolvedConflicts,
  recordUniqueConflicts,
  clearResolvedUniqueConflicts,
} from './conflictStore.js'

// Two jobs, deliberately different: fields nobody needs to adjudicate are unioned silently, and a
// genuine disagreement (scalar field conflict, or a hard-set UNIQUE collision between two whole
// records) is recorded for a human to settle. Returns the reconciled doc — the caller must adopt
// it (not the doc it passed in), or a recovered field would be written to SQLite and then lost
// again (docs/adr/2026-09-08-crdt-conflict-reconciliation.md).
export function reconcileAndRecordConflicts(db, doc) {
  const { doc: reconciled, conflicts } = reconcile(doc)
  recordConflicts(db, conflicts)
  clearResolvedConflicts(db, conflicts)

  const uniqueConflicts = deriveUniqueConflicts(reconciled)
  recordUniqueConflicts(db, uniqueConflicts)
  clearResolvedUniqueConflicts(db, uniqueConflicts)

  return reconciled
}
