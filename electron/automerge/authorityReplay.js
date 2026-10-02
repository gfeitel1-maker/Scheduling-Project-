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
  // getAllChanges returns changes in a valid topological (deps-respecting) order for a merged
  // Automerge document — this is a backend guarantee (a change cannot be stored before its deps
  // are), so iterating in that order is a valid causal replay order.
  const causalOrder = changes.map((c) => c.hash)
  const causalIndex = new Map(causalOrder.map((h, i) => [h, i]))

  const stateCache = new Map() // changeHash -> { grantedSet: Set<deviceId>, votes: Map<target, Set<signer>> }

  // Computes the full admin state as of (NOT including) `changeHash`'s own entry — i.e. replaying
  // every authority-log entry whose authoring change is a strict causal ancestor of `changeHash`.
  function stateAt(changeHash) {
    if (stateCache.has(changeHash)) return stateCache.get(changeHash)
    const ancestors = changeHash === FOUNDER_MARKER ? new Set(causalOrder) : ancestorsOf(changeHash, byHash)
    const ordered = [...ancestors].sort((a, b) => (causalIndex.get(a) ?? -1) - (causalIndex.get(b) ?? -1))

    const grantedSet = new Set(resolvedFounderDeviceId != null ? [resolvedFounderDeviceId] : [])
    const votes = new Map() // target -> Set<signer>

    for (const h of ordered) {
      const entries = entriesByChangeHash.get(h) ?? []
      for (const entry of entries) {
        if (entry.kind === 'genesis') continue // axiomatic, already seeded via resolvedFounderDeviceId
        const signerValid = isValidSignerAt(entry.signer_device_id, h)
        if (!signerValid) continue
        if (entry.signer_device_id === entry.target_device_id) continue // never counts toward own removal
        applyEntry(grantedSet, votes, entry)
      }
    }
    const result = { grantedSet, votes }
    stateCache.set(changeHash, result)
    return result
  }

  function isValidSignerAt(deviceId, changeHash) {
    return stateAt(changeHash).grantedSet.has(deviceId)
  }

  function applyEntry(grantedSet, votes, entry) {
    const { kind, target_device_id: target } = entry
    if (kind === 'grant') {
      grantedSet.add(target)
      votes.delete(target)
      return
    }
    // revoke: re-derive the real shape from the target's OWN current state — never trust the
    // entry's own kind label (ADR: "a receiver re-derives the same check independently rather
    // than trusting the sender's framing").
    const targetIsAdmin = grantedSet.has(target)
    if (!targetIsAdmin) {
      // Ordinary (non-admin) device target: any one valid admin removes immediately. No-op if
      // already not admin.
      grantedSet.delete(target)
      votes.delete(target)
      return
    }
    // Admin/founder target: quorum of the OTHER currently-valid admins.
    const voteSet = votes.get(target) ?? new Set()
    voteSet.add(entry.signer_device_id)
    votes.set(target, voteSet)
    const n = grantedSet.size // includes the target
    const threshold = quorumThreshold(n)
    const validVotes = [...voteSet].filter((v) => v !== target && grantedSet.has(v))
    if (validVotes.length >= threshold) {
      grantedSet.delete(target)
      votes.delete(target)
    }
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
