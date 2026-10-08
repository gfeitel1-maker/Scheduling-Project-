// T331 (docs/adr/2026-10-02-distributed-revocation-authority.md) — the causal-ancestor replay
// (`isValidAdminAt`) and quorum-threshold evaluation over `camp_authority_log`. Pure functions of
// an Automerge document's change set: no sequencer, no wall-clock, same answer on every peer
// regardless of merge order. org-source-verification: Automerge.getAllChanges/decodeChange
// confirmed against this repo's pinned @automerge/automerge (3.4.1) to return {hash, deps, actor,
// seq, ops} per change, with deps as content-hash strings forming a cryptographically chained DAG.
//
// Entry shapes (ADR): genesis is axiomatic (no signature); grant/revoke are each signed by the
// ACTING device (see authorityLog.js — there is no writer-chosen 'revoke-vote'; see
// campDocument.js's EXTRA_MODELED_ENTITIES comment for why that collapse is faithful to the ADR).
// Which shape a given (signer, target) entry COUNTS as is re-derived here from the target's OWN
// causal state at that point — never trusted from the entry's own `kind` label, per the ADR's
// "nothing about authority is ever trusted from a self-report" rule. Concretely: an entry
// targeting a device that was NOT a valid admin at its own causal point is an immediate
// grant/revoke; an entry targeting a device that WAS a valid admin is a vote toward quorum.
//
// Document shape: `camp_authority_log` entries live in the SAME flat per-field map every other
// MODELED_ENTITIES entity uses (campDocument.js's recordKey/readRecord/listRecordIds — NOT a plain
// array), so this module reads them the same way projector.js reads any other entity, rather than
// assuming a bespoke array shape.
import { decodeChange, getObjectId } from '@automerge/automerge'
import { listRecordIds, readRecord, splitRecordKey } from './campDocument.js'
import { verifyAuthorityEntry } from './authorityLogSignature.js'

export const AUTHORITY_LOG_ENTITY = 'camp_authority_log'

// A "complete" entry has the fields the CAUSAL/QUORUM replay needs (kind, target, signer) — this
// module does not check signatures at all; that is the SEPARATE authenticity concern
// authorityLogSignature.js/projector.js's upsertCampAuthorityLogEntity own (an entry's signature,
// when present, must be verified by the CALLER before this module is asked to replay it; an entry
// that merely lacks a `signature` field yet is still structurally complete by this module's own
// lights, matching the real write order in authorityLog.js where kind/target/signer land before
// the signature field in the SAME multi-field write but each field is its own change).
export function isCompleteEntry(row) {
  if (!row || !row.kind) return false
  if (row.kind === 'genesis') return typeof row.target_device_id === 'string' && row.target_device_id.length > 0
  return (
    typeof row.target_device_id === 'string' && row.target_device_id.length > 0 &&
    typeof row.signer_device_id === 'string' && row.signer_device_id.length > 0
  )
}

// --- change-graph plumbing ----------------------------------------------

function decodeAll(automerge, doc) {
  return automerge.getAllChanges(doc).map((c) => decodeChange(c))
}

// BFS over `deps`, transitively, EXCLUDING changeHash itself.
function ancestorsOf(changeHash, byHash) {
  const seen = new Set()
  const queue = [...(byHash.get(changeHash)?.deps ?? [])]
  while (queue.length > 0) {
    const h = queue.shift()
    if (seen.has(h)) continue
    seen.add(h)
    const deps = byHash.get(h)?.deps ?? []
    for (const d of deps) if (!seen.has(d)) queue.push(d)
  }
  return seen
}

// The TRUE causal closure for "current heads": every change the document holds that is NOT
// itself a dependency of some OTHER held change (Automerge's own definition of a head), union
// their ancestors AND the heads themselves. Round-4 correction (Red Hat): the previous shortcut,
// `new Set(byHash.keys())`, is "every known change" in `getAllChanges`'s OWN iteration order —
// which this file's own round-3 fix already proved is NOT canonical across merge orders for
// concurrent changes. Membership in this Set never depended on that order (a Set has no order),
// but nothing here actually required computing the FULL change set in the first place — the real
// heads' ancestor closure is both correct AND already order-independent by construction (pure
// graph reachability), so there is no reason to use the non-canonical shortcut at all.
function headsClosure(byHash) {
  const dependedOn = new Set()
  for (const change of byHash.values()) {
    for (const d of change.deps) dependedOn.add(d)
  }
  const closure = new Set()
  for (const hash of byHash.keys()) {
    if (dependedOn.has(hash)) continue // not a head — some other change depends on it
    closure.add(hash)
    for (const a of ancestorsOf(hash, byHash)) closure.add(a)
  }
  return closure
}

// Every change that COMPLETES a camp_authority_log entry, keyed by the entry's STABLE id. A change
// c completes entry E iff E is a complete entry in the causal closure {c} ∪ ancestors(c) but NOT in
// ancestors(c) alone — i.e. c is where E crosses from incomplete to complete along its causal
// history. A single-copy document (every ordinary pre-regeneration document) has exactly one
// completing change per entry; a document that merged a peer's ORIGINALS with this device's
// RE-AUTHORED COPIES (T342 Slice 0) has one completing change PER BRANCH, and the replay below keys
// on the stable entry id so every branch's copy counts as the SAME logical entry rather than a
// second, concurrent-and-therefore-invalid one.
//
// Attributed from the changes' OWN ops (each field write is one map-key op on the collection
// object — key `<entryId>\u0000<field>`), then propagated along the deps DAG as a field-presence
// set per change, so a completing change is detected without reconstructing a document per change.
// Cost is O(total-field-writes × entries) — bounded by the number of grant/revoke/purge events a
// camp ever records (admin-key events, not camper records), which stays small by design.
function buildCompletingHashesByEntry(automerge, doc) {
  const collectionId = getObjectId(doc[AUTHORITY_LOG_ENTITY])
  // Required fields per entry, by its kind (read from the assembled document). Only entries
  // isCompleteEntry already accepts are considered, so `kind` is always present for them.
  const requiredByEntry = new Map()
  for (const id of listRecordIds(doc, AUTHORITY_LOG_ENTITY)) {
    const row = readRecord(doc, AUTHORITY_LOG_ENTITY, id)
    if (!isCompleteEntry(row)) continue
    requiredByEntry.set(
      id,
      row.kind === 'genesis' ? ['kind', 'target_device_id'] : ['kind', 'target_device_id', 'signer_device_id']
    )
  }

  const ordered = decodeAll(automerge, doc) // causal (topological) order — a change never precedes its deps
  // (entryId, field) each change establishes.
  const writtenBy = new Map()
  for (const change of ordered) {
    const written = []
    for (const op of change.ops) {
      if (op.obj !== collectionId || typeof op.key !== 'string') continue
      const parsed = splitRecordKey(op.key)
      if (parsed) written.push(parsed)
    }
    writtenBy.set(change.hash, written)
  }

  const isComplete = (present, id) => {
    const req = requiredByEntry.get(id)
    const have = present.get(id)
    return !!req && !!have && req.every((f) => have.has(f))
  }

  const presentInClosure = new Map() // changeHash -> Map<entryId, Set<field>>  (closure = {c} ∪ ancestors)
  const byEntry = new Map()
  for (const change of ordered) {
    const closure = new Map()
    for (const dep of change.deps) {
      const depPresent = presentInClosure.get(dep)
      if (!depPresent) continue
      for (const [id, fields] of depPresent) {
        if (!closure.has(id)) closure.set(id, new Set())
        for (const f of fields) closure.get(id).add(f)
      }
    }
    // Entries already complete in the ancestors alone — so this change is credited only with the
    // entries IT completes.
    const completeBefore = new Set([...requiredByEntry.keys()].filter((id) => isComplete(closure, id)))
    for (const { entityId, field } of writtenBy.get(change.hash) ?? []) {
      if (!closure.has(entityId)) closure.set(entityId, new Set())
      closure.get(entityId).add(field)
    }
    for (const id of requiredByEntry.keys()) {
      if (completeBefore.has(id)) continue
      if (!isComplete(closure, id)) continue
      if (!byEntry.has(id)) byEntry.set(id, new Set())
      byEntry.get(id).add(change.hash)
    }
    presentInClosure.set(change.hash, closure)
  }
  return byEntry
}

// The entry-level causal graph the replay and peer-id resolution both key on. Entry X "causally
// precedes" entry Y iff ANY completing change of X lies in Y's causal past (the union of Y's
// completing changes' ancestors). Defined on the STABLE entry id, never a raw change hash, so a
// re-authored copy (T342 Slice 0) can never be mistaken for a different entry nor flip a comparison.
function buildEntryGraph(automerge, doc) {
  const byHash = new Map(decodeAll(automerge, doc).map((c) => [c.hash, c]))
  const completingHashesByEntry = buildCompletingHashesByEntry(automerge, doc)
  const pastCache = new Map()
  function causalPast(entryId) {
    if (pastCache.has(entryId)) return pastCache.get(entryId)
    const past = new Set()
    for (const h of completingHashesByEntry.get(entryId) ?? []) {
      for (const a of ancestorsOf(h, byHash)) past.add(a)
    }
    pastCache.set(entryId, past)
    return past
  }
  function precedes(x, y) {
    const past = causalPast(y)
    for (const h of completingHashesByEntry.get(x) ?? []) if (past.has(h)) return true
    return false
  }
  return { byHash, completingHashesByEntry, causalPast, precedes }
}

// "entry a is causally at least as late as entry b": b precedes a (a wins), or they are concurrent
// and a's stable id sorts >= b's. The tie-break is the STABLE ENTRY ID — never a raw change hash —
// so a re-authored copy cannot flip which genesis/grant entry resolves a device's peer id (T342
// Slice 0; replaces the former raw-hash isCausallyAtLeastAsLate tie-break).
function entryAtLeastAsLate(graph, a, b) {
  if (a === b) return true
  if (graph.precedes(b, a)) return true
  if (graph.precedes(a, b)) return false
  return a >= b
}

// T342 Slice 0 (seed.js's carryAuthorityLog): the entry-level causal partial order of a
// PRE-REGENERATION document — each complete entry id to { row, ancestorEntryIds } where E' is an
// ancestor of E iff E' causally precedes E. The carry re-authors each entry on a fork holding
// exactly its ancestor entries, reproducing this partial order (and its concurrency) in the
// regenerated document. Defined against a document that holds only originals (one completing change
// per entry), which is what a live document being regenerated is.
export function authorityEntryAncestry(automerge, doc) {
  const graph = buildEntryGraph(automerge, doc)
  const ids = [...graph.completingHashesByEntry.keys()]
  const out = new Map()
  for (const id of ids) {
    const row = readRecord(doc, AUTHORITY_LOG_ENTITY, id)
    const ancestorEntryIds = new Set(ids.filter((o) => o !== id && graph.precedes(o, id)))
    out.set(id, { row, ancestorEntryIds })
  }
  return out
}

// --- public replay API ---------------------------------------------------

const FOUNDER_MARKER = Symbol('founder')

/**
 * Builds a reusable replay context for one document snapshot. Memoizes admin-state computation
 * per change hash, so repeated isValidAdminAt/currentAuthorityState calls against the same doc
 * snapshot are cheap. Construct a fresh context whenever the document's change set changes.
 *
 * `founderDeviceId`, when omitted, is read from the document's own 'genesis' entry (there is
 * exactly one, written once at camp bootstrap — see authorityLog.js's mintGenesisEntry) rather
 * than requiring every caller to pass it in externally, so every peer computes the same founder
 * identity from the document alone.
 *
 * `isEntryTrusted(entry)` (optional, defaults to always-true): an AUTHENTICITY filter applied
 * before an entry is even considered by the causal/quorum replay below — this module's own scope
 * is the causal-ancestor/quorum MATH, not signature verification (authorityLogSignature.js owns
 * that). The real caller (projector.js's upsertCampAuthorityLogEntity) supplies a predicate that
 * verifies each entry's signature against its signer's peer id (resolved from an earlier
 * genesis/grant entry) — an entry that fails is dropped here, before it can ever contribute to
 * the derived admin/revoked state, exactly like a causally-invalid signer's entry is dropped by
 * the replay itself. The default (always-true) is for THIS module's own unit tests, which
 * exercise the causal/quorum math unsigned (see authorityReplay.test.js's header comment).
 */
export function createAuthorityReplayContext(automerge, doc, { founderDeviceId, isEntryTrusted = () => true } = {}) {
  const graph = buildEntryGraph(automerge, doc)
  const { byHash, completingHashesByEntry, precedes } = graph

  // Every COMPLETE entry, by stable id — applying the authenticity filter once here (genesis is
  // axiomatic, never filtered). Keyed by id, so a merge of a peer's originals with this device's
  // re-authored copies (T342 Slice 0) collapses both copies of an entry to ONE logical entry rather
  // than two concurrent ones.
  const rows = new Map()
  let resolvedFounderDeviceId = founderDeviceId ?? null
  for (const id of listRecordIds(doc, AUTHORITY_LOG_ENTITY)) {
    const row = readRecord(doc, AUTHORITY_LOG_ENTITY, id)
    if (!isCompleteEntry(row)) continue
    if (!completingHashesByEntry.has(id)) continue
    const entry = { id, ...row }
    if (entry.kind === 'genesis') {
      if (resolvedFounderDeviceId == null) resolvedFounderDeviceId = entry.target_device_id
    } else if (!isEntryTrusted(entry)) {
      continue
    }
    rows.set(id, entry)
  }

  const stateCache = new Map()

  // The admin state over an ancestor CHANGE SET — the causal past of some evaluation point (the
  // document's heads for the current state, or the ancestors of ONE specific completing change for
  // the recursive signer-validity sub-problem). Judging that sub-problem at a SPECIFIC completing
  // change — never over the UNION of ancestors across an entry's several completing changes — is
  // what makes a peer's extra, BACKDATED re-completion of an existing entry id unable to perturb a
  // legitimate change's validity math (T342 Slice 0 round 2, Red Hat CONFIRMED HIGH): a legitimate
  // completing change's ancestors are its own, so injected history on a sibling re-completion is not
  // among them. The entry MAP (`rows`) is still keyed by stable entry id, so a re-authored copy is
  // ONE logical entry, not two. Memoized by `key` (the evaluation point).
  //
  // Order-independence, by construction (unchanged from the T331 model):
  //   1. An entry counts only if its signer held a live admin grant at the causal ancestors of ONE
  //      specific in-scope completing change of the entry (signerValidAtSomeCompletingChange — a
  //      strictly smaller, memoized sub-problem) — never the UNION of ancestors across the entry's
  //      completing changes, and never what this accumulator holds yet.
  //   2. Grants are unconditionally additive: a plain Set union.
  //   3. A vote, once validated, counts PERMANENTLY — pinned to the signer's causal point, never
  //      re-filtered against the shrinking grantedSet.
  //   4. Removal depends on the CURRENT admin count N (recomputed fresh), a monotone fixed point.
  function stateAtKeyed(key, ancestorChanges) {
    if (stateCache.has(key)) return stateCache.get(key)
    const grantedSet = new Set(resolvedFounderDeviceId != null ? [resolvedFounderDeviceId] : [])
    const grantEntriesByTarget = new Map() // target -> Set<entryId>
    // target -> Map<signer, Set<entryId>> — EVERY valid revoke entry a signer cast against the
    // target (an honest device can author more than one across concurrent, never-synced branches),
    // keyed by entry id so a re-authored copy does not inflate the count.
    const voteEntriesByTargetSigner = new Map()

    for (const [id, entry] of rows) {
      if (entry.kind === 'genesis') continue // axiomatic, already seeded via resolvedFounderDeviceId
      if (entry.signer_device_id === entry.target_device_id) continue // never counts toward own removal
      // In scope AND signer-valid, judged together at ONE specific completing change of this entry —
      // never over the union across completing changes (that union is influenceable by a peer's added
      // re-completion, Red Hat HIGH round 1).
      if (!signerValidAtSomeCompletingChange(id, entry.signer_device_id, ancestorChanges)) continue
      if (entry.kind === 'grant') {
        grantedSet.add(entry.target_device_id)
        if (!grantEntriesByTarget.has(entry.target_device_id)) grantEntriesByTarget.set(entry.target_device_id, new Set())
        grantEntriesByTarget.get(entry.target_device_id).add(id)
        continue
      }
      if (!voteEntriesByTargetSigner.has(entry.target_device_id)) voteEntriesByTargetSigner.set(entry.target_device_id, new Map())
      const bySigner = voteEntriesByTargetSigner.get(entry.target_device_id)
      if (!bySigner.has(entry.signer_device_id)) bySigner.set(entry.signer_device_id, new Set())
      bySigner.get(entry.signer_device_id).add(id)
    }

    // Drop stale votes: a revoke entry V for target T is stale if the document ALSO holds a 'grant'
    // entry for T that V causally precedes (the vote predates a later re-grant — cast against a
    // PRIOR tenure). Entry-level precedence, so originals and re-authored copies agree. A signer
    // whose EVERY revoke entry against a target is stale no longer counts as a voter; one with at
    // least one surviving entry counts exactly ONCE.
    const votesByTarget = new Map() // target -> Map<signer, Set<survivingEntryId>>
    for (const [target, bySigner] of voteEntriesByTargetSigner) {
      const grantEntries = grantEntriesByTarget.get(target)
      for (const [signer, voteIds] of bySigner) {
        const surviving = grantEntries
          ? new Set([...voteIds].filter((v) => ![...grantEntries].some((g) => g !== v && precedes(v, g))))
          : voteIds
        if (surviving.size === 0) continue
        if (!votesByTarget.has(target)) votesByTarget.set(target, new Map())
        votesByTarget.get(target).set(signer, surviving)
      }
    }

    // Fixed point over admin/founder targets only. Tally = number of DISTINCT SIGNERS with at least
    // one surviving vote.
    let changed = true
    while (changed) {
      changed = false
      for (const [target, bySigner] of votesByTarget) {
        if (!grantedSet.has(target)) continue
        if (bySigner.size >= quorumThreshold(grantedSet.size)) {
          grantedSet.delete(target)
          changed = true
        }
      }
    }

    const result = { grantedSet, votes: votesByTarget }
    stateCache.set(key, result)
    return result
  }

  // A completing change c of `entryId` witnesses the entry iff c is itself in `ancestorChanges` (the
  // entry is causally in scope at this evaluation point) AND `deviceId` held a live admin grant among
  // c's OWN causal ancestors. Evaluated per specific completing change, never over the union across an
  // entry's completing changes: a merge holds the original completing change plus any re-authored
  // copies, and judging each change against its OWN ancestors means a peer's extra, backdated
  // re-completion cannot inject ancestry into a legitimate change's validity math (T342 Slice 0 round
  // 2, Red Hat CONFIRMED HIGH). The faithful carry re-authors each entry on a fork holding exactly its
  // original ancestor entries, so its copy witnesses validity identically to the original.
  function signerValidAtSomeCompletingChange(entryId, deviceId, ancestorChanges) {
    for (const h of completingHashesByEntry.get(entryId) ?? []) {
      if (!ancestorChanges.has(h)) continue
      if (isValidAdminAt(deviceId, h)) return true
    }
    return false
  }

  /** True iff `deviceId` held a live admin grant among the causal ancestors of `changeHash`. Also the
   *  per-completing-change building block signerValidAtSomeCompletingChange uses; exported as a
   *  convenience for callers that ask about an arbitrary change (no production caller does — the whole
   *  production surface asks only for the current-heads state). */
  function isValidAdminAt(deviceId, changeHash) {
    return stateAtKeyed(`change:${changeHash}`, ancestorsOf(changeHash, byHash)).grantedSet.has(deviceId)
  }

  /** The current ("at the document's own heads") admin/revoked state — the derived cache. */
  function currentState() {
    return stateAtKeyed(FOUNDER_MARKER, headsClosure(byHash))
  }

  return { isValidAdminAt, currentState, founderDeviceId: resolvedFounderDeviceId }
}

/** Convenience one-shot for callers that don't need to reuse a context across calls. */
export function isValidAdminAt(automerge, doc, deviceId, changeHash, { founderDeviceId } = {}) {
  return createAuthorityReplayContext(automerge, doc, { founderDeviceId }).isValidAdminAt(deviceId, changeHash)
}

/** The derived "currently granted admins" set + outstanding vote tallies, at the doc's own heads. */
export function currentAuthorityState(automerge, doc, { founderDeviceId } = {}) {
  const ctx = createAuthorityReplayContext(automerge, doc, { founderDeviceId })
  const { grantedSet, votes } = ctx.currentState()
  return { admins: grantedSet, votes }
}

export function quorumThreshold(n) {
  return Math.floor((n - 1) / 2) + 1
}

// T335 gate finding (Security/Red Hat HIGH, round 2) — moved here from projector.js (where it was
// private/unexported) so the discovery path (rotatingDiscoveryTag.js) can use the EXACT same
// signature verification projector.js's upsertCampAuthorityLogEntity already relies on, rather
// than a second, looser definition. Resolves each target device's peer id from the causally LATEST
// genesis/grant entry naming it (never raw document iteration order). The latest-ness tie-break for
// two CONCURRENT entries is the STABLE ENTRY ID (entryAtLeastAsLate), not a raw change hash, so a
// target re-granted after a revoke+re-grant cycle resolves deterministically regardless of merge
// order AND a re-authored copy of an entry (T342 Slice 0) can never flip which grant wins.
export function resolveAuthorityPeerIds(automerge, doc) {
  const graph = buildEntryGraph(automerge, doc)
  const winningEntryByDevice = new Map()
  const peerIdByDevice = new Map()
  for (const id of listRecordIds(doc, AUTHORITY_LOG_ENTITY)) {
    const row = readRecord(doc, AUTHORITY_LOG_ENTITY, id)
    if (!row || (row.kind !== 'genesis' && row.kind !== 'grant')) continue
    if (!row.target_device_id || !row.target_peer_id) continue
    if (!graph.completingHashesByEntry.has(id)) continue
    const incumbent = winningEntryByDevice.get(row.target_device_id)
    if (incumbent != null && !entryAtLeastAsLate(graph, id, incumbent)) continue
    winningEntryByDevice.set(row.target_device_id, id)
    peerIdByDevice.set(row.target_device_id, row.target_peer_id)
  }
  return peerIdByDevice
}

// The REAL `isEntryTrusted` predicate: an entry counts only if its signer's peer id can be
// resolved (from an already-causally-established genesis/grant entry) AND its signature verifies
// against that peer id. Shared by projector.js (the SQLite projection) and the discovery path
// (rotatingDiscoveryTag.js) — one definition of "trusted," so the two consumers cannot drift into
// disagreeing about which revoke entries count. A caller with no verified peer-id source at all
// (this module's own unit tests) uses the always-true default on createAuthorityReplayContext
// instead — this helper is for callers that DO have a real document to verify against, i.e. every
// production call site.
export function createVerifiedEntryTrust(automerge, doc) {
  const peerIdByDevice = resolveAuthorityPeerIds(automerge, doc)
  return function isEntryTrusted(entry) {
    const signerPeerId = peerIdByDevice.get(entry.signer_device_id)
    if (!signerPeerId) return false // signer's own identity never established — fail closed
    return verifyAuthorityEntry(
      signerPeerId,
      { id: entry.id, kind: entry.kind, target_device_id: entry.target_device_id, signer_device_id: entry.signer_device_id },
      entry.signature
    )
  }
}

// T335 (docs/work/specs/2026-10-03-t335-key-turning-rotating-discovery-tag-design.md §1.1) — the
// sorted set of device ids that have EVER been a valid admin/founder target but are NOT currently
// admin, i.e. "currently revoked." Built on the same stateAt/currentState machinery as
// currentAuthorityState above (merge-order-independent by construction — see that function's
// comment), so this is a pure, total function of the document's own causal state: no sequencer, no
// wall-clock. `isEntryTrusted` gates which entries count here EXACTLY as it gates grantedSet/votes
// in createAuthorityReplayContext — a target named only by an untrusted (unsigned/unverified)
// revoke entry never appears in the "ever targeted" set this function builds, so it never
// contributes to the result.
export function currentRevokedDeviceIds(automerge, doc, { founderDeviceId, isEntryTrusted = () => true } = {}) {
  const ctx = createAuthorityReplayContext(automerge, doc, { founderDeviceId, isEntryTrusted })
  const { grantedSet } = ctx.currentState()
  const everyTargetDeviceId = new Set(grantedSet)
  for (const id of listRecordIds(doc, AUTHORITY_LOG_ENTITY)) {
    const row = readRecord(doc, AUTHORITY_LOG_ENTITY, id)
    if (!isCompleteEntry(row)) continue
    const entry = { id, ...row }
    if (entry.kind !== 'genesis' && !isEntryTrusted(entry)) continue
    if (entry.target_device_id) everyTargetDeviceId.add(entry.target_device_id)
  }
  return [...everyTargetDeviceId].filter((id) => !grantedSet.has(id)).sort()
}
