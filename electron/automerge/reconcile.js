// Surfacing genuine disagreements between two people.
// docs/adr/2026-09-08-crdt-conflict-reconciliation.md (the rule) and
// docs/adr/2026-09-08-flat-record-shape.md (why this module is now small).
//
// THE OWNER'S RULE:
//
//   "if they create the exact same record … it doesn't matter. the same idea
//    was generated." … "[if they differ] they are not the same and need to be
//    reconciled." … "flag it and make someone choose. … a choice that both need
//    to see."
//
// This module used to do TWO jobs: union fields that nobody needed to
// adjudicate, and surface the ones somebody did. **The first job no longer
// exists**, and its disappearance is the point of the flat record shape rather
// than an optimisation of it. A field is its own document key, so two devices
// setting different fields of the same record write different keys and never
// collide — there is nothing to lose and so nothing to repair. Deleting that
// code is the evidence the class of bug is gone, not merely handled.
//
// What is left is the case the owner asked about: two people setting the SAME
// field to different values. That is a scalar conflict. It is recorded and
// shown; it is never resolved here.
//
// The case that is neither: the same field set to the same value on both sides.
// Automerge reports two concurrent OPERATIONS there, so the obvious
// `getConflicts(...).length > 1` test would ask a director to choose between
// archery and archery on a schedule that is already correct. Deduplicate by
// VALUE, not by operation count.
//
// WHY BOTH DEVICES SEE THE SAME THING WITHOUT SYNCING ANYTHING. Conflicts are
// DERIVED from the merged document, never stored in it. Every device converges
// on the same document, so every device derives the same conflicts from the
// same bytes — "a choice that both need to see", for free, with no resolution
// state to replicate. Resolution is an ordinary field write that dominates both
// values, so it clears everywhere by the mechanism that raised it.
import * as A from '@automerge/automerge'
import { splitRecordKey, recordKey, storedValue } from './campDocument.js'

// Ordering is part of the contract, not tidiness: two devices must produce
// byte-identical reconciliations from identical documents, and callers (the
// `conflicts` table) must get a stable order to write idempotently.
function sorted(keys) {
  return [...keys].sort()
}

// The machine-rotated rendezvous secrets tuple (electron/sync/automerge/rendezvousNamespace.js).
// Two devices rotating concurrently is not a disagreement between people: Automerge keeps one
// whole tuple, and showing the conflict would put raw secrets on ConflictsScreen.
const MACHINE_RESOLVED_CAMP_FIELD = 'rendezvousSecrets'

// Automerge hands conflicting values back keyed by op id. Sorting by that key
// gives every device the same order for the same document.
function conflictEntries(conflicts) {
  if (!conflicts) return []
  return sorted(Object.keys(conflicts)).map((opId) => [opId, conflicts[opId]])
}

// Scalars only — every field in PROJECTIONS is a scalar (text/integer/null).
// Object.is rather than === so NaN compares equal to itself and -0/+0 do not
// masquerade as a disagreement between two devices that both wrote zero.
function sameValue(x, y) {
  return Object.is(x, y)
}

/**
 * Derive every conflict in `doc`, and union the fields that nobody needs to
 * adjudicate.
 *
 * Returns `{ doc, conflicts, unioned }`:
 *   - `doc`     — the same document, or a new one if any union was written.
 *   - `conflicts` — `[{ entity, entityId, field, values: [{ opId, value }] }]`,
 *     deterministically ordered. Genuine disagreements only: never a field the
 *     two sides agree on, never a non-overlapping field.
 *   - `unioned` — `[{ entity, entityId, field, value }]`, what was recovered
 *     silently. Returned for tests and logging, not for showing to anyone.
 *
 * Pure with respect to SQLite, libp2p and the clock. Give it a document, get
 * the same answer on every device.
 */
export function reconcile(doc) {
  const conflicts = []

  for (const entity of sorted(Object.keys(doc))) {
    const collection = doc[entity]
    if (!collection || typeof collection !== 'object') continue

    for (const key of sorted(Object.keys(collection))) {
      // Each key is one field of one record. A conflict here is therefore
      // always a scalar disagreement — there is no record container that two
      // devices could have created concurrently, which is the whole reason this
      // function no longer has a second half.
      const parsed = splitRecordKey(key)
      if (!parsed) continue
      if (entity === 'camps' && parsed.field === MACHINE_RESOLVED_CAMP_FIELD) continue

      const versions = conflictEntries(A.getConflicts(collection, key))
      if (versions.length < 2) continue

      const values = versions.map(([, value]) => value)
      // Agreement, not a collision. Two people making the same move must never
      // produce a prompt.
      if (!values.some((v) => !sameValue(v, values[0]))) continue

      conflicts.push({
        entity,
        entityId: parsed.entityId,
        field: parsed.field,
        values: versions.map(([opId, value]) => ({ opId, value })),
      })
    }
  }

  // `doc` is returned unchanged and always will be: with nothing to union,
  // deriving conflicts is a pure read. Kept in the return shape because callers
  // adopt it, and because a future need to rewrite during reconciliation should
  // have to change this signature deliberately rather than by accident.
  return { doc, conflicts }
}

/**
 * The structural guarantee, and the reason this module is not merely a
 * function someone remembers to call.
 *
 * The requirement is NOT "the reconciler handles conflicts". It is that the
 * system **cannot be in a state where a conflict went unhandled**. The weak
 * version of this feature reads `getConflicts` correctly at one call site and
 * is then bypassed by some later path that writes the document without going
 * through it — and the symptom of that bypass is identical to the bug this
 * exists to fix: a director's decision silently discarded.
 *
 * So the check hangs off the one place a merged document becomes SQLite, and
 * throws rather than warns. A future path that merges without reconciling fails
 * loudly at a projection it has to perform anyway. This is the same shape as
 * campDocument.js's module-load subset guard: its strength was never its logic,
 * it was that there is no path around it.
 */
export function assertNoUnrecordedConflicts(doc, recorded) {
  const { conflicts } = reconcile(doc)
  const seen = new Set(recorded.map((c) => `${c.entity}\u0000${c.entityId}\u0000${c.field}`))
  const missing = conflicts.filter(
    (c) => !seen.has(`${c.entity}\u0000${c.entityId}\u0000${c.field}`)
  )
  if (missing.length > 0) {
    throw new Error(
      `reconcile: ${missing.length} conflict(s) in this document were never recorded, so nobody ` +
        `would be shown them — a director's edit would be silently discarded. First: ` +
        `${missing[0].entity}.${missing[0].field} on ${missing[0].entityId}. ` +
        `Every path that projects a merged document must reconcile it first ` +
        `(docs/adr/2026-09-08-crdt-conflict-reconciliation.md).`
    )
  }
}

/**
 * Resolve a conflict by writing the director's choice so that it **supersedes
 * every competing value** — including when their choice is the value their own
 * device was already showing.
 *
 * That case is not exotic; it is the most likely thing a person does. Two
 * directors disagree, one of them looks at the screen, sees archery, and says
 * "archery is right." A plain assignment there can be a no-op: Automerge sees
 * the register already materialising to `archery` and writes no set operation,
 * so both competing operations survive, the conflict never clears, and the
 * director's decision is silently discarded — the exact failure this whole ADR
 * exists to prevent, arriving through the resolution path instead of the merge
 * path. Found by scenario 28, which failed roughly half the time on precisely
 * the runs where the resolver's own value had won locally.
 *
 * Deleting the key first makes the following set unconditional, so the new
 * operation dominates every earlier one whatever the chosen value happens to
 * be. Both happen in ONE change, so no peer can ever observe the field absent.
 */
export function resolveConflictInDoc(doc, { entity, entityId, field, value }) {
  // Delete-then-set rather than a plain assignment: a director's most likely
  // choice is the value already on their screen, and that is the one shape
  // where a plain assignment risks writing no operation at all. Both happen in
  // ONE change, so no peer ever observes the field absent.
  //
  // Under the flat record shape this is all that is needed. An earlier revision
  // had a second branch that reassigned the whole RECORD when the record itself
  // was contested — the only edit that could dominate two competing containers.
  // It cleared the conflict and silently discarded any concurrent write into
  // the old container, with `getConflicts` returning nothing to surface. That
  // branch is gone along with the containers that made it necessary; a record
  // can no longer be contested, so there is nothing left to reach for it.
  const key = recordKey(entityId, field)
  return A.change(doc, `resolve conflict: ${entity}.${field}`, (d) => {
    const collection = d[entity]
    if (!collection || !(key in collection)) return
    delete collection[key]
    collection[key] = storedValue(entity, field, value)
  })
}
