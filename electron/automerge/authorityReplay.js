// T331 (docs/adr/2026-10-02-distributed-revocation-authority.md) — the causal-ancestor replay
// (`isValidAdminAt`) and quorum-threshold evaluation over `camp_authority_log`. Pure functions of
// an Automerge document's change set: no sequencer, no wall-clock, same answer on every peer
// regardless of merge order. org-source-verification: Automerge.getAllChanges/getChangesMetaSince
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

// Everything derived from a document's change set is cached per document object. One rotation
// check alone used to decode and replay the whole history four or more times (createVerifiedEntryTrust,
// revocationDigest, electedRotator, plus one decode per duplicate grant in isCausallyAtLeastAsLate);
// on an imported camp that hung startup. Contract: call these on the CURRENT document. Automerge
// keeps an outdated document object readable, but getAllChanges on it reports the newer history,
// so a cached result for an outdated object can disagree with what it shows.
const snapshotCache = new WeakMap()
function cacheFor(doc) {
  let entry = snapshotCache.get(doc)
  if (!entry) { entry = {}; snapshotCache.set(doc, entry) }
  return entry
}

// {hash, deps, actor, seq, startOp, maxOp} per change, in getAllChanges order, WITHOUT decoding
// ops. Imported camps store long strings as Automerge text, one op per character: the camp that
// hung had 229 changes holding 2.9 million ops, and decoding them cost 18s of CPU per call.
function changeMeta(automerge, doc) {
  const cache = cacheFor(doc)
  if (!cache.meta) cache.meta = automerge.getChangesMetaSince(doc, [])
  return cache.meta
}

function byHashOf(automerge, doc) {
  const cache = cacheFor(doc)
  if (!cache.byHash) cache.byHash = new Map(changeMeta(automerge, doc).map((c) => [c.hash, c]))
  return cache.byHash
}

// Reads the camp_authority_log collection as it stood at `heads`, straight from the document's
// backend: keys and values at historical heads, without materialising the document. Same
// result as listRecordIds/readRecord on the document at those heads, as far as isCompleteEntry
// can tell: the collection is the root key's winning object, a field's text is its string, and
// every other value maps to what the proxy would return (see PLAIN_SCALAR_TYPES).
// Value types the document proxy returns as the same JS primitive. Every other type (a raw
// 'str' is an ImmutableString object, a counter a Counter object, a timestamp a Date, bytes a
// Uint8Array, a map/list an object) is an object to the proxy: truthy and never a string, which
// is all isCompleteEntry can see of it.
const PLAIN_SCALAR_TYPES = new Set(['int', 'uint', 'f64', 'boolean'])
const NON_STRING_VALUE = Object.freeze({})

function authorityRowsAt(backend, heads) {
  const root = backend.getWithType('_root', AUTHORITY_LOG_ENTITY, heads)
  if (!root || (root[0] !== 'map' && root[0] !== 'table')) return new Map()
  const logId = root[1]
  const rows = new Map()
  for (const key of backend.keys(logId, heads)) {
    const parsed = splitRecordKey(key)
    if (!parsed) continue
    const value = backend.getWithType(logId, key, heads)
    if (!value) continue
    let field
    if (value[0] === 'text') field = backend.text(value[1], heads)
    else if (PLAIN_SCALAR_TYPES.has(value[0])) field = value[1]
    else if (value[0] === 'null') field = null
    else field = NON_STRING_VALUE
    if (!rows.has(parsed.entityId)) rows.set(parsed.entityId, {})
    rows.get(parsed.entityId)[parsed.field] = field
  }
  return rows
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

// Maps each COMPLETE camp_authority_log entry's stable id to the hash of the change that FIRST
// completed it (i.e. the change after which every required field is present), by reading the
// collection after each change in turn (see the loop below).
// Works for ANY peer's doc, not just the authoring device's — the only robust way to answer "which
// change authored this entry" without a self-reported field.
function buildEntryChangeIndexFrom(automerge, doc) {
  const cache = cacheFor(doc)
  if (cache.entryIndex) return cache.entryIndex
  const backend = automerge.getBackend(doc)
  const index = new Map()
  // The collection after the first i+1 changes is read at that prefix's heads: changes come in
  // causal order, so every prefix is causally closed and its heads name exactly that prefix.
  // Nothing is replayed or decoded. Rebuilding a scratch document cost 17s of applyChanges, and
  // decoding every change 18s, on the imported camp that hung (229 changes, 2.9 million ops).
  const heads = new Set()
  const seen = new Set()
  for (const change of changeMeta(automerge, doc)) {
    for (const dep of change.deps) {
      if (!seen.has(dep)) throw new Error('authority replay: change history is not in causal order')
      heads.delete(dep)
    }
    seen.add(change.hash)
    heads.add(change.hash)
    for (const [id, row] of authorityRowsAt(backend, [...heads])) {
      if (index.has(id)) continue
      if (isCompleteEntry(row)) index.set(id, change.hash)
    }
  }
  cache.entryIndex = index
  return index
}

// Used by resolveAuthorityPeerIds (now in this module; T335 factored it out of projector.js into the
// shared createVerifiedEntryTrust) (Code Reviewer MEDIUM, round-3 correction):
// when the SAME target_device_id has more than one genesis/grant entry (re-granted after a
// revoke+re-grant cycle, or a device that changed its own libp2p identity), picking "whichever
// this device's doc happens to iterate first" is not deterministic across merge order — the SAME
// non-canonical-ordering hazard `stateAt` above had to stop depending on. `isCausallyAtLeastAsLate`
// answers "is A causally at or after B" using the SAME deps-DAG ancestor query `stateAt` relies
// on (merge-order-independent by construction); concurrent entries (neither an ancestor of the
// other) are broken by comparing the raw hash strings, so every peer picks the identical winner.
export function isCausallyAtLeastAsLate(automerge, doc, hashA, hashB) {
  if (hashA === hashB) return true
  const byHash = byHashOf(automerge, doc)
  if (ancestorsOf(hashA, byHash).has(hashB)) return true
  if (ancestorsOf(hashB, byHash).has(hashA)) return false
  return hashA >= hashB // concurrent — deterministic, merge-order-independent tie-break
}

// Exposed so a caller (projector.js) can map an entry id to the change that completed it, without
// re-deriving the whole replay context — same index `createAuthorityReplayContext` builds
// internally.
export function entryChangeHashIndex(automerge, doc) {
  return new Map(buildEntryChangeIndexFrom(automerge, doc))
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
  const byHash = byHashOf(automerge, doc)
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
    // For the "current heads" case: the TRUE causal closure of the document's real heads
    // (headsClosure, above) — never getAllChanges's own iteration order (round-4 correction; see
    // headsClosure's comment for why the prior `new Set(byHash.keys())` shortcut was wrong even
    // though a Set itself has no order — the BUG was computing "every change" via an order-
    // dependent traversal in the first place, not merely iterating it in some order afterward).
    const ancestors = changeHash === FOUNDER_MARKER ? headsClosure(byHash) : ancestorsOf(changeHash, byHash)

    const grantedSet = new Set(resolvedFounderDeviceId != null ? [resolvedFounderDeviceId] : [])
    const grantHashesByTarget = new Map() // target -> Set<changeHash> of every valid grant for it
    // target -> Map<signer, Set<changeHash>> — EVERY valid vote-hash a signer cast against this
    // target, never last-write-wins. Round-4 correction (Red Hat): an honest device can author
    // MORE THAN ONE revoke entry against the same target across concurrent branches it never
    // synced before merging (a crash-and-restore, two offline sessions under the same identity
    // key — not only an adversary); which entry "survives" staleness filtering below must not
    // depend on which one a non-canonical ancestors-Set iteration happened to visit last
    // (`Map.set(signer, h)` last-write-wins was exactly that dependency). Grants stay simple and
    // unconditionally additive — they are not a competing "claim" with a signer's own votes; a
    // signer's grant-then-revoke-then-grant chain against the SAME target is a real temporal
    // sequence (each grant/vote evaluated on its own causal merits, not a register overwritten by
    // whichever is "latest"), which the existing stale-vote-after-regrant check below already
    // captures correctly for the SEQUENTIAL case.
    const voteHashesByTargetSigner = new Map()

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
        // revoke: record this vote-hash under (target, signer) — ALL of them, not just one.
        if (!voteHashesByTargetSigner.has(entry.target_device_id)) voteHashesByTargetSigner.set(entry.target_device_id, new Map())
        const bySigner = voteHashesByTargetSigner.get(entry.target_device_id)
        if (!bySigner.has(entry.signer_device_id)) bySigner.set(entry.signer_device_id, new Set())
        bySigner.get(entry.signer_device_id).add(h)
      }
    }

    // Drop stale vote-hashes: a vote at change V for target T is stale if the document ALSO
    // contains a 'grant' for T at a change that V causally precedes (i.e. the vote predates a
    // later re-grant — cast against a PRIOR tenure, not the current one). Order-independent:
    // purely an ancestor-set membership test, same primitive `isValidSignerAt` already relies on.
    // A signer whose EVERY vote-hash against a target turns out stale no longer counts as a
    // voter at all for it; one with at least one surviving hash counts exactly ONCE, regardless
    // of how many vote-hashes they cast or which one happened to be inserted "first."
    const votesByTarget = new Map() // target -> Map<signer, Set<survivingHash>>
    for (const [target, bySigner] of voteHashesByTargetSigner) {
      const grantHashes = grantHashesByTarget.get(target)
      for (const [signer, hashes] of bySigner) {
        const surviving = grantHashes
          ? new Set([...hashes].filter((v) => ![...grantHashes].some((gh) => gh !== v && ancestorsOf(gh, byHash).has(v))))
          : hashes
        if (surviving.size === 0) continue
        if (!votesByTarget.has(target)) votesByTarget.set(target, new Map())
        votesByTarget.get(target).set(signer, surviving)
      }
    }

    // Fixed point over admin/founder targets only (an ordinary, never-granted target is already
    // correctly "not admin" — a revoke against it changes nothing about grantedSet). Tally is the
    // number of DISTINCT SIGNERS with at least one surviving vote, never a per-hash count.
    let changed = true
    while (changed) {
      changed = false
      for (const [target, bySigner] of votesByTarget) {
        if (!grantedSet.has(target)) continue
        const threshold = quorumThreshold(grantedSet.size)
        if (bySigner.size >= threshold) {
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

// T335 gate finding (Security/Red Hat HIGH, round 2) — moved here from projector.js (where it was
// private/unexported) so the discovery path (rotatingDiscoveryTag.js) can use the EXACT same
// signature verification projector.js's upsertCampAuthorityLogEntity already relies on, rather
// than a second, looser definition. Resolves each target device's peer id from the causally LATEST
// genesis/grant entry naming it (never raw document iteration order — the same
// isCausallyAtLeastAsLate-based tie-break stateAt already needs for the same reason: a target
// re-granted after a revoke+re-grant cycle must resolve deterministically regardless of merge
// order).
export function resolveAuthorityPeerIds(automerge, doc) {
  const entryChangeHash = entryChangeHashIndex(automerge, doc)
  const winningHashByDevice = new Map()
  const peerIdByDevice = new Map()
  for (const id of listRecordIds(doc, AUTHORITY_LOG_ENTITY)) {
    const row = readRecord(doc, AUTHORITY_LOG_ENTITY, id)
    if (!row || (row.kind !== 'genesis' && row.kind !== 'grant')) continue
    if (!row.target_device_id || !row.target_peer_id) continue
    const h = entryChangeHash.get(id)
    if (!h) continue
    const incumbent = winningHashByDevice.get(row.target_device_id)
    if (incumbent != null && !isCausallyAtLeastAsLate(automerge, doc, h, incumbent)) continue
    winningHashByDevice.set(row.target_device_id, h)
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
