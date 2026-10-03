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
import { decodeChange } from '@automerge/automerge'
import { listRecordIds, readRecord } from './campDocument.js'

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

// Maps each COMPLETE camp_authority_log entry's stable id to the hash of the change that FIRST
// completed it (i.e. the change after which every required field is present), by replaying changes
// one at a time onto a scratch doc built from the SAME automerge module the caller passed in.
// Works for ANY peer's doc, not just the authoring device's — the only robust way to answer "which
// change authored this entry" without a self-reported field.
function buildEntryChangeIndexFrom(automerge, doc) {
  const { init, applyChanges } = automerge
  const changes = automerge.getAllChanges(doc)
  let scratch = init()
  const index = new Map()
  for (const change of changes) {
    const decoded = decodeChange(change)
    ;[scratch] = applyChanges(scratch, [change])
    for (const id of listRecordIds(scratch, AUTHORITY_LOG_ENTITY)) {
      if (index.has(id)) continue
      const row = readRecord(scratch, AUTHORITY_LOG_ENTITY, id)
      if (isCompleteEntry(row)) index.set(id, decoded.hash)
    }
  }
  return index
}

// Exposed for projector.js's resolveAuthorityPeerIds (Code Reviewer MEDIUM, round-3 correction):
// when the SAME target_device_id has more than one genesis/grant entry (re-granted after a
// revoke+re-grant cycle, or a device that changed its own libp2p identity), picking "whichever
// this device's doc happens to iterate first" is not deterministic across merge order — the SAME
// non-canonical-ordering hazard `stateAt` above had to stop depending on. `isCausallyAtLeastAsLate`
// answers "is A causally at or after B" using the SAME deps-DAG ancestor query `stateAt` relies
// on (merge-order-independent by construction); concurrent entries (neither an ancestor of the
// other) are broken by comparing the raw hash strings, so every peer picks the identical winner.
export function isCausallyAtLeastAsLate(automerge, doc, hashA, hashB) {
  if (hashA === hashB) return true
  const changes = decodeAll(automerge, doc)
  const byHash = new Map(changes.map((c) => [c.hash, c]))
  if (ancestorsOf(hashA, byHash).has(hashB)) return true
  if (ancestorsOf(hashB, byHash).has(hashA)) return false
  return hashA >= hashB // concurrent — deterministic, merge-order-independent tie-break
}

// Exposed so a caller (projector.js) can map an entry id to the change that completed it, without
// re-deriving the whole replay context — same index `createAuthorityReplayContext` builds
// internally.
export function entryChangeHashIndex(automerge, doc) {
  return buildEntryChangeIndexFrom(automerge, doc)
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
  const changes = decodeAll(automerge, doc)
  const byHash = new Map(changes.map((c) => [c.hash, c]))
  const entryChangeHash = buildEntryChangeIndexFrom(automerge, doc)
  const entriesByChangeHash = new Map()
  let resolvedFounderDeviceId = founderDeviceId ?? null
  for (const id of listRecordIds(doc, AUTHORITY_LOG_ENTITY)) {
    const row = readRecord(doc, AUTHORITY_LOG_ENTITY, id)
    if (!isCompleteEntry(row)) continue
    const h = entryChangeHash.get(id)
    if (!h) continue
    const entry = { id, ...row }
    if (entry.kind === 'genesis' && resolvedFounderDeviceId == null) {
      resolvedFounderDeviceId = entry.target_device_id
    }
    if (entry.kind !== 'genesis' && !isEntryTrusted(entry)) continue
    if (!entriesByChangeHash.has(h)) entriesByChangeHash.set(h, [])
    entriesByChangeHash.get(h).push(entry)
  }
  // RED HAT HIGH / round-3 correction: `getAllChanges` does NOT give a merge-order-independent
  // sequence for changes that are mutually concurrent (org-source-verification, confirmed
  // empirically against this repo's pinned @automerge/automerge 3.4.1 — two independently-merged
  // orderings of the SAME two concurrent changes came back in opposite relative order; there is
  // no documented or observed canonical-order guarantee across concurrent nodes). `stateAt` below
  // is therefore a PURE function of the ancestor SET, never of any iteration order over it — see
  // its own comment for why that is suffient, not merely "ordered one way instead of another."
  const stateCache = new Map() // changeHash -> { grantedSet: Set<deviceId>, votes: Map<target, Set<signer>> }

  // Computes the full admin state as of (NOT including) `changeHash`'s own entry — i.e. replaying
  // every authority-log entry whose authoring change is a strict causal ancestor of `changeHash`.
  //
  // Order-independence, by construction:
  //   1. Grant validity and vote validity are each decided by `isValidSignerAt(signer, h)` —
  //      the SIGNER's OWN causal-ancestor state (a strictly smaller, memoized sub-problem), never
  //      by what has or hasn't been folded into THIS function's running accumulator yet. Two
  //      concurrent entries can therefore never see each other's effect, by definition (neither is
  //      in the other's ancestor set) — this was already true before this fix.
  //   2. Grants are unconditionally additive (same target granted twice is idempotent; two
  //      different targets never conflict) — a plain Set union, order-independent.
  //   3. A vote, once validated per (1), counts PERMANENTLY — never re-filtered against the
  //      grantedSet as it shrinks. The ADR is explicit that a vote's validity is pinned to the
  //      signer's own causal point, not to what happens to the signer afterward (the former bug:
  //      re-checking `grantedSet.has(signer)` against the SAME shared, mutating accumulator meant
  //      whichever of two concurrent revokes was folded in FIRST evicted the other's voter before
  //      that voter's own vote was ever tallied — a textbook order dependency).
  //   4. Whether an admin/founder target is actually removed depends on the CURRENT admin count N
  //      (recomputed fresh, per the ADR's case (c)) — a target can cross threshold only once
  //      enough OTHER admins are themselves removed. This is a monotone fixed point (removing an
  //      admin only ever LOWERS other targets' thresholds, never raises one), computed by
  //      iterating to a fixed point rather than a single pass — confluent regardless of which
  //      pending target is evaluated first in a given sweep, because a removal this sweep can only
  //      ever enable a removal next sweep, never undo one already decided.
  function stateAt(changeHash) {
    if (stateCache.has(changeHash)) return stateCache.get(changeHash)
    // For the "current heads" case there is no single entry to exclude — every known change is
    // in scope. Order is irrelevant (a plain Set), by the whole-function comment above.
    const ancestors = changeHash === FOUNDER_MARKER ? new Set(byHash.keys()) : ancestorsOf(changeHash, byHash)

    const grantedSet = new Set(resolvedFounderDeviceId != null ? [resolvedFounderDeviceId] : [])
    const grantHashesByTarget = new Map() // target -> Set<changeHash> of every valid grant for it
    const votesByTarget = new Map() // target -> Map<signer, changeHash> — voters validated at THEIR OWN causal point

    for (const h of ancestors) {
      for (const entry of entriesByChangeHash.get(h) ?? []) {
        if (entry.kind === 'genesis') continue // axiomatic, already seeded via resolvedFounderDeviceId
        if (entry.signer_device_id === entry.target_device_id) continue // never counts toward own removal
        if (!isValidSignerAt(entry.signer_device_id, h)) continue // signer's OWN ancestor-relative state
        if (entry.kind === 'grant') {
          grantedSet.add(entry.target_device_id)
          if (!grantHashesByTarget.has(entry.target_device_id)) grantHashesByTarget.set(entry.target_device_id, new Set())
          grantHashesByTarget.get(entry.target_device_id).add(h)
          continue
        }
        // revoke: register as a vote, keyed by its OWN change hash too — a re-grant after a prior
        // revocation (round-3 correction: a straightforward omission caught by this fix's own
        // test suite, not a new architecture question) must not let a vote cast BEFORE that
        // re-grant keep counting against the target's NEW tenure. Resolved below, once every
        // entry is classified, by dropping any vote that is a causal ANCESTOR of a later grant
        // for the same target.
        if (!votesByTarget.has(entry.target_device_id)) votesByTarget.set(entry.target_device_id, new Map())
        votesByTarget.get(entry.target_device_id).set(entry.signer_device_id, h)
      }
    }

    // Drop stale votes: a vote at change V for target T is stale if the document ALSO contains a
    // 'grant' for T at a change that V causally precedes (i.e. the vote predates a later re-grant
    // — it was cast against a PRIOR tenure, not the current one). Order-independent: purely an
    // ancestor-set membership test, same primitive `isValidSignerAt` already relies on.
    for (const [target, voterHashes] of votesByTarget) {
      const grantHashes = grantHashesByTarget.get(target)
      if (!grantHashes) continue
      for (const [voter, voteHash] of [...voterHashes]) {
        const stale = [...grantHashes].some((gh) => gh !== voteHash && ancestorsOf(gh, byHash).has(voteHash))
        if (stale) voterHashes.delete(voter)
      }
    }

    // Fixed point over admin/founder targets only (an ordinary, never-granted target is already
    // correctly "not admin" — a revoke against it changes nothing about grantedSet).
    let changed = true
    while (changed) {
      changed = false
      for (const [target, voterHashes] of votesByTarget) {
        if (!grantedSet.has(target)) continue
        const threshold = quorumThreshold(grantedSet.size)
        if (voterHashes.size >= threshold) {
          grantedSet.delete(target)
          changed = true
        }
      }
    }

    const result = { grantedSet, votes: votesByTarget }
    stateCache.set(changeHash, result)
    return result
  }

  function isValidSignerAt(deviceId, changeHash) {
    return stateAt(changeHash).grantedSet.has(deviceId)
  }

  /** True iff `deviceId` held a live admin grant among the causal ancestors of `changeHash`. */
  function isValidAdminAt(deviceId, changeHash) {
    return stateAt(changeHash).grantedSet.has(deviceId)
  }

  /** The current ("at the document's own heads") admin/revoked state — the derived cache. */
  function currentState() {
    return stateAt(FOUNDER_MARKER)
  }

  return { isValidAdminAt, currentState, entryChangeHash, founderDeviceId: resolvedFounderDeviceId }
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
