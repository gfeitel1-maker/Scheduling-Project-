// Reconciling concurrent edits — docs/adr/2026-09-08-crdt-conflict-reconciliation.md.
//
// THE PROBLEM THIS SOLVES. Automerge converges, but "converged" is not the same
// as "kept everything a person did". Two devices editing concurrently produce
// conflicts that Automerge resolves by picking a deterministic winner and
// filing the loser under `A.getConflicts` — which, before this module, nothing
// in this codebase read. Both devices then agreed on the same wrong answer and
// nothing was shown to anyone. Measured: 400 merges of a concurrently-created
// record, not one preserved both sides
// (docs/work/evidence/2026-09-08-concurrent-entity-creation-loses-fields.md).
//
// THE OWNER'S RULE, which is the whole design:
//
//   "if they create the exact same record … it doesn't matter. the same idea
//    was generated." … "[if they differ] they are not the same and need to be
//    reconciled." … "flag it and make someone choose."
//
// So there are TWO jobs here, and they must not be collapsed into one:
//
//   1. Keys that do not overlap are UNIONED, silently. One device set an
//      activity's name, another set its location — nobody needs to adjudicate
//      that, and prompting for it would train a director to dismiss prompts.
//   2. A scalar field with two DIFFERENT values is SURFACED and never resolved
//      here. Group 1 / period 2 set to archery on one device and playground on
//      another is two people disagreeing. The app records it and shows it. It
//      does not pick.
//
// And the case that is neither: the same field set to the same value on both
// sides is agreement, not a collision, and must never reach a human.
//
// WHY BOTH DEVICES SEE THE SAME THING WITHOUT SYNCING ANYTHING. Conflicts are
// DERIVED from the merged document, never stored in it. Every device converges
// on the same document, so every device derives the same conflicts from the
// same bytes — the owner's "a choice that both need to see", for free, with no
// resolution state to replicate and no conflict-about-a-conflict. Resolution is
// an ordinary document write that causally dominates both values, so it clears
// everywhere by the same mechanism that raised it.
//
// WHY THIS NEVER REASSIGNS A RECORD KEY. Clearing a record-level conflict would
// mean assigning the collection key (`d[entity][id] = {...}`), which creates an
// op dominating both versions. That looks tidier and is wrong twice over: it
// would silently pick a value for any field the two versions disagree on (job 2,
// violated), and it would erase the evidence, so the conflict would stop being
// derivable and this module's own guarantee — that an unhandled conflict cannot
// exist unnoticed — would go with it. Instead the union writes only the MISSING
// fields onto the surviving record. The key-level conflict stays in history,
// where it is harmless once no data is lost, and stays derivable.
//
// IDEMPOTENCE IS LOAD-BEARING. This runs on every projection. A union is
// written only when the surviving record does not already have that field with
// that value, so a document that has already been reconciled produces no
// change and no new ops. Without that, two devices would write unions at each
// other forever.
import * as A from '@automerge/automerge'

// Ordering is part of the contract, not tidiness: two devices must produce
// byte-identical reconciliations from identical documents, and callers (the
// `conflicts` table) must get a stable order to write idempotently.
function sorted(keys) {
  return [...keys].sort()
}

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
  const pendingUnions = []

  for (const entity of sorted(Object.keys(doc))) {
    const collection = doc[entity]
    if (!collection || typeof collection !== 'object') continue

    for (const entityId of sorted(Object.keys(collection))) {
      const survivor = collection[entityId]
      if (!survivor || typeof survivor !== 'object') continue

      // --- Record-level: two devices independently created this same id. ---
      // Only reachable where ids are DERIVED rather than random (schedule
      // template ids, ingest paths, ensureExists upserts) — records minted with
      // crypto.randomUUID() can never collide, and two devices adding "the same"
      // activity produce two visible rows rather than one lossy one.
      const versions = conflictEntries(A.getConflicts(collection, entityId))
      if (versions.length > 1) {
        // Gather every field any version set, and what each version set it to.
        const byField = new Map()
        for (const [, version] of versions) {
          if (!version || typeof version !== 'object') continue
          for (const field of Object.keys(version)) {
            if (!byField.has(field)) byField.set(field, [])
            byField.get(field).push(version[field])
          }
        }

        for (const field of sorted(byField.keys())) {
          const values = byField.get(field)
          const disagrees = values.some((v) => !sameValue(v, values[0]))
          if (disagrees) {
            // Job 2 — a real disagreement inside a concurrently-created record.
            // Recorded, never unioned: unioning would mean choosing.
            //
            // These `versions` are IMMUTABLE HISTORY — what each device wrote,
            // unchanged by anything later. That is why resolving one of these
            // CANNOT be an ordinary field write: a field write lands inside the
            // surviving version and leaves the contest between versions
            // standing, so the conflict returns on the next projection, for
            // ever. resolveConflictInDoc below assigns the record key instead,
            // which is the only edit that dominates both versions. Found by
            // scenario 28, which failed ~50% of runs — exactly the runs where
            // this path, rather than the field-level one, was reporting.
            conflicts.push({
              entity,
              entityId,
              field,
              values: versions
                .filter(([, version]) => version && field in version)
                .map(([opId, version]) => ({ opId, value: version[field] })),
            })
            continue
          }
          // Job 1 — every version agrees (or only one set it). Recover it onto
          // the surviving record if it isn't already there. This is the
          // idempotence check that stops two devices writing at each other.
          if (!sameValue(survivor[field], values[0])) {
            pendingUnions.push({ entity, entityId, field, value: values[0] })
          }
        }
      }

      // --- Field-level: the ordinary case, and the one that matters. ---
      // Two people editing the same slot. Automerge already picked a winner;
      // the other person's decision is in getConflicts and would otherwise
      // vanish from a schedule that looks correct on both screens.
      for (const field of sorted(Object.keys(survivor))) {
        const fieldVersions = conflictEntries(A.getConflicts(survivor, field))
        if (fieldVersions.length < 2) continue
        const values = fieldVersions.map(([, value]) => value)
        // Same value from both sides is agreement, not a collision. Automerge
        // still records two ops for it; a director must never see a prompt
        // asking them to choose between archery and archery.
        if (!values.some((v) => !sameValue(v, values[0]))) continue
        conflicts.push({
          entity,
          entityId,
          field,
          values: fieldVersions.map(([opId, value]) => ({ opId, value })),
        })
      }
    }
  }

  if (pendingUnions.length === 0) {
    return { doc, conflicts, unioned: [] }
  }

  const next = A.change(doc, 'reconcile: recover non-overlapping fields', (d) => {
    for (const { entity, entityId, field, value } of pendingUnions) {
      d[entity][entityId][field] = value
    }
  })
  return { doc: next, conflicts, unioned: pendingUnions }
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
  const seen = new Set(recorded.map((c) => `${c.entity} ${c.entityId} ${c.field}`))
  const missing = conflicts.filter(
    (c) => !seen.has(`${c.entity} ${c.entityId} ${c.field}`)
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
  // Delete-then-set rather than a plain assignment, because a director's most
  // likely choice is the value already on their screen, and that is the one
  // shape where a plain assignment risks writing nothing at all. Both happen in
  // ONE change, so no peer ever observes the field absent.
  //
  // REJECTED, and it must stay rejected: resolving by reassigning the record
  // KEY (`d[entity][entityId] = union`). It is tempting because it is the only
  // edit that dominates two competing record VERSIONS, and it is what an
  // earlier revision of this function did. It reintroduces silent data loss in
  // a narrower window, which is the wrong direction on the exact axis this
  // whole module exists for. Measured:
  //
  //     resolution:      s1 = { name: 'archery' }        (key reassignment)
  //     concurrent edit: s1.notes = 'bring sunscreen'    (ordinary field write)
  //     merged:          { name: 'archery' }   -- notes GONE
  //     getConflicts:    0                     -- nothing to surface, ever
  //
  // A counselor adding a note while the director settles that cell loses the
  // note with no trace: the reassignment creates a new container, so a
  // concurrent write into the old one is discarded, and unlike the bug the
  // reassignment was meant to fix, this one is invisible. Loud-and-annoying is
  // a bad trade for silent-and-invisible.
  //
  // The consequence is a real, documented limitation rather than a hidden one:
  // a disagreement between two concurrently-CREATED versions of a record cannot
  // be cleared by this function, because nothing short of a key reassignment
  // dominates both versions. It stays surfaced until the record shape itself
  // changes (see the ADR's deferred "flatten the record shape" option, which
  // this is now direct evidence for). A conflict that will not clear is
  // annoying; an edit that vanishes is not recoverable.
  return A.change(doc, `resolve conflict: ${entity}.${field}`, (d) => {
    const record = d[entity]?.[entityId]
    if (!record) return
    delete record[field]
    record[field] = value
  })
}
