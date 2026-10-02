// T331 (docs/adr/2026-10-02-distributed-revocation-authority.md) — the causal-ancestor replay
// (`isValidAdminAt`) and quorum-threshold evaluation over `camp_authority_log`. Pure functions of
// an Automerge document's change set: no sequencer, no wall-clock, same answer on every peer
// regardless of merge order. org-source-verification: Automerge.getAllChanges/decodeChange
// confirmed against this repo's pinned @automerge/automerge (3.4.1) to return {hash, deps, actor,
// seq, ops} per change, with deps as content-hash strings forming a cryptographically chained DAG.
//
// Entry shapes (ADR): genesis is axiomatic (no signature); grant/revoke/revoke-vote are each
// signed by the ACTING device. Which shape a given (signer, target) entry COUNTS as is re-derived
// here from the target's OWN causal state at that point — never trusted from the entry's own
// `kind` label, per the ADR's "nothing about authority is ever trusted from a self-report" rule.
// Concretely: an entry targeting a device that was NOT a valid admin at its own causal point is
// an immediate grant/revoke; an entry targeting a device that WAS a valid admin is a vote toward
// quorum (even if authored/labeled 'revoke').
import { getAllChanges, decodeChange } from '@automerge/automerge'

export const AUTHORITY_LOG_PATH = 'camp_authority_log'

// --- change-graph plumbing ----------------------------------------------

function decodeAll(doc) {
  return getAllChanges(doc).map((c) => decodeChange(c))
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

// Maps each `camp_authority_log` entry's stable id to the hash of the change that introduced it,
// by replaying changes one at a time onto a scratch doc and diffing the collection before/after
// each change. Works for ANY peer's doc, not just the authoring device's — the only robust way to
// answer "which change authored this entry" without a self-reported field. `automerge` is the
// real @automerge/automerge module, passed in by the caller rather than imported twice.
function buildEntryChangeIndexFrom(automerge, doc) {
  const { init, applyChanges, getAllChanges: getAll } = automerge
  const changes = getAll(doc)
  let scratch = init()
  const index = new Map()
  let prevEntries = new Map()
  for (const change of changes) {
    const decoded = decodeChange(change)
    ;[scratch] = applyChanges(scratch, [change])
    const list = scratch[AUTHORITY_LOG_PATH] ?? []
    const nextEntries = new Map(list.map((e) => [e.id, e]))
    for (const id of nextEntries.keys()) {
      if (!prevEntries.has(id) && !index.has(id)) {
        index.set(id, decoded.hash)
      }
    }
    prevEntries = nextEntries
  }
  return index
}

// --- public replay API ---------------------------------------------------

const FOUNDER_MARKER = Symbol('founder')

/**
 * Builds a reusable replay context for one document snapshot. Memoizes admin-state computation
 * per change hash, so repeated isValidAdminAt/currentAuthorityState calls against the same doc
 * snapshot are cheap. Construct a fresh context whenever the document's change set changes.
 */
export function createAuthorityReplayContext(automerge, doc, { founderDeviceId } = {}) {
  const changes = decodeAll(doc)
  const byHash = new Map(changes.map((c) => [c.hash, c]))
  const entryChangeHash = buildEntryChangeIndexFrom(automerge, doc)
  const entriesByChangeHash = new Map()
  for (const entry of doc[AUTHORITY_LOG_PATH] ?? []) {
    const h = entryChangeHash.get(entry.id)
    if (!h) continue
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

    const grantedSet = new Set(founderDeviceId != null ? [founderDeviceId] : [])
    const votes = new Map() // target -> Set<signer>

    for (const h of ordered) {
      const entries = entriesByChangeHash.get(h) ?? []
      for (const entry of entries) {
        if (entry.kind === 'genesis') continue // axiomatic, already seeded via founderDeviceId
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
    // revoke / revoke-vote: re-derive the real shape from the target's OWN current state —
    // never trust the entry's own kind label (ADR: "a receiver re-derives the same check
    // independently rather than trusting the sender's framing").
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
    const threshold = Math.floor((n - 1) / 2) + 1
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

  return { isValidAdminAt, currentState, entryChangeHash }
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
