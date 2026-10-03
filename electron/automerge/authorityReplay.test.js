// T331 battle tests (docs/adr/2026-10-02-distributed-revocation-authority.md) for the pure
// causal-ancestor/quorum replay. These operate on real @automerge/automerge documents, through the
// SAME flat per-field document shape every other MODELED_ENTITIES entity uses (createEmptyDoc/
// applyWrite) — the causal-ancestor rule is specifically about Automerge's real change/deps graph,
// so a hand-rolled fake graph would not actually exercise it (mocks hid the T329 defect; the same
// risk applies here). Entries are written field-by-field with no signature — signature
// authenticity is a separate, already-built concern (authorityLogSignature.js), wired together in
// projector.js's upsertCampAuthorityLogEntity; these tests exercise the causal-ancestor/quorum MATH
// only, matching this module's own scope (see authorityLog.test.js for the signed, end-to-end
// write path, and projector.test.js for the verify-and-replay integration).
import * as Automerge from '@automerge/automerge'
import { describe, expect, it } from 'vitest'
import { createEmptyDoc, applyWrite } from './campDocument.js'
import { createAuthorityReplayContext, currentAuthorityState, quorumThreshold } from './authorityReplay.js'

let nextId = 0
function uid() {
  return `e${nextId++}`
}

function initDoc() {
  return createEmptyDoc()
}

function pushEntry(doc, entry) {
  const id = uid()
  let d = doc
  for (const [field, value] of Object.entries(entry)) {
    d = applyWrite(d, { entity: 'camp_authority_log', entity_id: id, field, value })
  }
  return d
}

describe('quorumThreshold', () => {
  it('matches the ADR N=1..5 table (threshold = floor((N-1)/2)+1, N incl. target)', () => {
    expect(quorumThreshold(2)).toBe(1) // N=2, 1 other -> 1
    expect(quorumThreshold(3)).toBe(2) // N=3, 2 others -> 2
    expect(quorumThreshold(4)).toBe(2) // N=4, 3 others -> 2
    expect(quorumThreshold(5)).toBe(3) // N=5, 4 others -> 3
  })
})

describe('battle test 1 — quorum reached removes; one short does not', () => {
  it('N=4: 2 of 3 others removes; 1 of 3 does not', () => {
    let doc = initDoc()
    doc = pushEntry(doc, { kind: 'grant', target_device_id: 'A', signer_device_id: 'FOUNDER' })
    doc = pushEntry(doc, { kind: 'grant', target_device_id: 'B', signer_device_id: 'FOUNDER' })
    doc = pushEntry(doc, { kind: 'grant', target_device_id: 'C', signer_device_id: 'FOUNDER' })
    // admins now: FOUNDER, A, B, C (N=4). Target C; others FOUNDER, A, B.
    doc = pushEntry(doc, { kind: 'revoke', target_device_id: 'C', signer_device_id: 'FOUNDER' })
    {
      const ctx = createAuthorityReplayContext(Automerge, doc, { founderDeviceId: 'FOUNDER' })
      expect(ctx.currentState().grantedSet.has('C')).toBe(true) // 1 vote, threshold 2 — not yet
    }
    doc = pushEntry(doc, { kind: 'revoke', target_device_id: 'C', signer_device_id: 'A' })
    {
      const ctx = createAuthorityReplayContext(Automerge, doc, { founderDeviceId: 'FOUNDER' })
      expect(ctx.currentState().grantedSet.has('C')).toBe(false) // 2 of 3 — reached
    }
  })
})

describe('battle test 2 — a removed admin\'s new revoke is dropped, not applied', () => {
  it('S, validly revoked by T, later signs a revoke of a fourth device — that revoke never applies', () => {
    let doc = initDoc()
    doc = pushEntry(doc, { kind: 'grant', target_device_id: 'S', signer_device_id: 'FOUNDER' })
    doc = pushEntry(doc, { kind: 'grant', target_device_id: 'T', signer_device_id: 'FOUNDER' })
    doc = pushEntry(doc, { kind: 'grant', target_device_id: 'D4', signer_device_id: 'FOUNDER' })
    // S is an ordinary admin here w.r.t. being revoked by a single admin T is fine since S isn't
    // being targeted by a quorum case — S is removed by one admin (T) acting alone is only valid
    // for a NON-admin target. S IS an admin, so revoking S needs quorum. Use FOUNDER+T (2 of the
    // 3 others: FOUNDER, T — wait S's others are FOUNDER, T, D4, so N=4, threshold=2).
    doc = pushEntry(doc, { kind: 'revoke', target_device_id: 'S', signer_device_id: 'FOUNDER' })
    doc = pushEntry(doc, { kind: 'revoke', target_device_id: 'S', signer_device_id: 'T' })
    {
      const ctx = createAuthorityReplayContext(Automerge, doc, { founderDeviceId: 'FOUNDER' })
      expect(ctx.currentState().grantedSet.has('S')).toBe(false) // S is now removed
    }
    // S (still holding its own key) now signs a revoke of D4, citing the state it had before.
    doc = pushEntry(doc, { kind: 'revoke', target_device_id: 'D4', signer_device_id: 'S' })
    const ctx = createAuthorityReplayContext(Automerge, doc, { founderDeviceId: 'FOUNDER' })
    expect(ctx.currentState().grantedSet.has('D4')).toBe(true) // S's revoke never counted
    expect(ctx.currentState().grantedSet.has('S')).toBe(false)
  })
})

describe('battle test 3 — concurrent mutual revocation converges symmetrically', () => {
  it('two admins concurrently revoke each other (non-admin shape, both removed either merge order)', () => {
    let base = initDoc()
    base = pushEntry(base, { kind: 'grant', target_device_id: 'A', signer_device_id: 'FOUNDER' })
    base = pushEntry(base, { kind: 'grant', target_device_id: 'B', signer_device_id: 'FOUNDER' })
    // Fork into two concurrent branches from the same base.
    let branchAB = Automerge.clone(base)
    let branchBA = Automerge.clone(base)
    branchAB = pushEntry(branchAB, { kind: 'revoke', target_device_id: 'B', signer_device_id: 'A' })
    branchBA = pushEntry(branchBA, { kind: 'revoke', target_device_id: 'A', signer_device_id: 'B' })

    const mergedOrder1 = Automerge.merge(Automerge.clone(branchAB), branchBA)
    const mergedOrder2 = Automerge.merge(Automerge.clone(branchBA), branchAB)

    // A and B each had exactly one OTHER admin besides FOUNDER (N=3, threshold=2 for an admin
    // target). Each revoke here is a lone vote — below threshold, so neither removal actually
    // completes by itself; the point of this test is CONVERGENCE (identical result regardless of
    // merge order), asserted below.
    // Convergence: both merge orders produce byte-identical derived state.
    const s1 = createAuthorityReplayContext(Automerge, mergedOrder1, { founderDeviceId: 'FOUNDER' }).currentState()
    const s2 = createAuthorityReplayContext(Automerge, mergedOrder2, { founderDeviceId: 'FOUNDER' }).currentState()
    expect([...s1.grantedSet].sort()).toEqual([...s2.grantedSet].sort())
  })

  // RED HAT HIGH (round-3 correction) — the ADR's CANONICAL N=2 case: founder F and admin A are
  // the ONLY two admins. Each, concurrently, revokes the other. At N=2 a single vote already
  // meets the threshold (floor((2-1)/2)+1 = 1), so BOTH revocations should independently complete
  // — symmetric mutual destruction, not a race either side can win. The bug this test catches:
  // vote-counting that re-filters a voter against a SHARED, iteration-order-mutated grantedSet
  // (instead of each voter's OWN per-vote causal validity) makes whichever revoke is PROCESSED
  // FIRST "win" (its voter is still in the live set) while the other's voter has already been
  // evicted by the time its own vote is tallied — giving a DIFFERENT survivor depending on merge
  // order. Both merge orders must converge to the SAME outcome: both removed.
  it('N=2 canonical case: founder F and admin A revoke each other concurrently — BOTH removed, identically in both merge orders', () => {
    let base = initDoc()
    base = pushEntry(base, { kind: 'grant', target_device_id: 'A', signer_device_id: 'FOUNDER' })
    // N=2 (FOUNDER, A). threshold for an admin target = quorumThreshold(2) = 1 — the one other
    // admin's vote alone suffices.
    let branchFA = Automerge.clone(base)
    let branchAF = Automerge.clone(base)
    branchFA = pushEntry(branchFA, { kind: 'revoke', target_device_id: 'A', signer_device_id: 'FOUNDER' })
    branchAF = pushEntry(branchAF, { kind: 'revoke', target_device_id: 'FOUNDER', signer_device_id: 'A' })

    const mergeOrder1 = Automerge.merge(Automerge.clone(branchFA), branchAF)
    const mergeOrder2 = Automerge.merge(Automerge.clone(branchAF), branchFA)

    for (const merged of [mergeOrder1, mergeOrder2]) {
      const state = createAuthorityReplayContext(Automerge, merged, { founderDeviceId: 'FOUNDER' }).currentState()
      expect(state.grantedSet.has('FOUNDER')).toBe(false)
      expect(state.grantedSet.has('A')).toBe(false)
    }
  })

  it('two admins concurrently revoke each other and BOTH actually complete removal (N=2 others each)', () => {
    // F, A, B, C: target A and target B are each revoked by a THIRD admin concurrently with each
    // other's own single-signer attempt, reaching quorum on both sides — the ADR's symmetric
    // mutual-destruction case, concretely at a quorum that completes.
    let base = initDoc()
    base = pushEntry(base, { kind: 'grant', target_device_id: 'A', signer_device_id: 'FOUNDER' })
    base = pushEntry(base, { kind: 'grant', target_device_id: 'B', signer_device_id: 'FOUNDER' })
    // N=3 (FOUNDER, A, B) at this point. threshold for an admin target = 2 (of FOUNDER+other).
    let branch1 = Automerge.clone(base)
    let branch2 = Automerge.clone(base)
    // Branch 1: FOUNDER + B both vote to revoke A (reaches 2-of-2 others).
    branch1 = pushEntry(branch1, { kind: 'revoke', target_device_id: 'A', signer_device_id: 'FOUNDER' })
    branch1 = pushEntry(branch1, { kind: 'revoke', target_device_id: 'A', signer_device_id: 'B' })
    // Branch 2 (concurrent): FOUNDER + A both vote to revoke B.
    branch2 = pushEntry(branch2, { kind: 'revoke', target_device_id: 'B', signer_device_id: 'FOUNDER' })
    branch2 = pushEntry(branch2, { kind: 'revoke', target_device_id: 'B', signer_device_id: 'A' })

    const mergedOrder1 = Automerge.merge(Automerge.clone(branch1), branch2)
    const mergedOrder2 = Automerge.merge(Automerge.clone(branch2), branch1)
    for (const merged of [mergedOrder1, mergedOrder2]) {
      const ctx = createAuthorityReplayContext(Automerge, merged, { founderDeviceId: 'FOUNDER' })
      const state = ctx.currentState()
      expect(state.grantedSet.has('A')).toBe(false)
      expect(state.grantedSet.has('B')).toBe(false)
      expect(state.grantedSet.has('FOUNDER')).toBe(true)
    }
  })
})

describe('battle test 5 — the founder is removable by a quorum', () => {
  it('a non-founder admin, with quorum, removes the founder', () => {
    let doc = initDoc()
    doc = pushEntry(doc, { kind: 'grant', target_device_id: 'A', signer_device_id: 'FOUNDER' })
    doc = pushEntry(doc, { kind: 'grant', target_device_id: 'B', signer_device_id: 'FOUNDER' })
    // N=3 (FOUNDER, A, B); target FOUNDER; others A, B; threshold 2.
    doc = pushEntry(doc, { kind: 'revoke', target_device_id: 'FOUNDER', signer_device_id: 'A' })
    doc = pushEntry(doc, { kind: 'revoke', target_device_id: 'FOUNDER', signer_device_id: 'B' })
    const ctx = createAuthorityReplayContext(Automerge, doc, { founderDeviceId: 'FOUNDER' })
    expect(ctx.currentState().grantedSet.has('FOUNDER')).toBe(false)
  })
})

describe('battle test 7 (N=2/N=3 degradation)', () => {
  it('N=2: the one other admin suffices to remove the target', () => {
    let doc = initDoc()
    doc = pushEntry(doc, { kind: 'grant', target_device_id: 'A', signer_device_id: 'FOUNDER' })
    doc = pushEntry(doc, { kind: 'revoke', target_device_id: 'A', signer_device_id: 'FOUNDER' })
    const ctx = createAuthorityReplayContext(Automerge, doc, { founderDeviceId: 'FOUNDER' })
    expect(ctx.currentState().grantedSet.has('A')).toBe(false)
  })

  it('N=3: one of two others is insufficient; both are required', () => {
    let doc = initDoc()
    doc = pushEntry(doc, { kind: 'grant', target_device_id: 'A', signer_device_id: 'FOUNDER' })
    doc = pushEntry(doc, { kind: 'grant', target_device_id: 'B', signer_device_id: 'FOUNDER' })
    doc = pushEntry(doc, { kind: 'revoke', target_device_id: 'A', signer_device_id: 'FOUNDER' })
    {
      const ctx = createAuthorityReplayContext(Automerge, doc, { founderDeviceId: 'FOUNDER' })
      expect(ctx.currentState().grantedSet.has('A')).toBe(true) // 1 of 2 — not enough
    }
    doc = pushEntry(doc, { kind: 'revoke', target_device_id: 'A', signer_device_id: 'B' })
    const ctx = createAuthorityReplayContext(Automerge, doc, { founderDeviceId: 'FOUNDER' })
    expect(ctx.currentState().grantedSet.has('A')).toBe(false) // both — now removed
  })

  it('N=4 tolerates one of three others being offline (never signs)', () => {
    let doc = initDoc()
    doc = pushEntry(doc, { kind: 'grant', target_device_id: 'A', signer_device_id: 'FOUNDER' })
    doc = pushEntry(doc, { kind: 'grant', target_device_id: 'B', signer_device_id: 'FOUNDER' })
    doc = pushEntry(doc, { kind: 'grant', target_device_id: 'C', signer_device_id: 'FOUNDER' })
    // target C; others FOUNDER, A, B (D/offline admin never exists here — simulate "never signs"
    // by simply never authoring an entry from a device that nonetheless counts toward N via grant).
    doc = pushEntry(doc, { kind: 'revoke', target_device_id: 'C', signer_device_id: 'FOUNDER' })
    doc = pushEntry(doc, { kind: 'revoke', target_device_id: 'C', signer_device_id: 'A' })
    // B never signs at all — removal still completes with FOUNDER + A (2 of 3).
    const ctx = createAuthorityReplayContext(Automerge, doc, { founderDeviceId: 'FOUNDER' })
    expect(ctx.currentState().grantedSet.has('C')).toBe(false)
  })
})

describe('battle test — an ordinary (non-admin) device is removed by any one admin', () => {
  it('a device with no admin grant is removed immediately by a single admin signature', () => {
    let doc = initDoc()
    // 'device-1' never received a grant — it's an ordinary device, not in the admin set at all.
    doc = pushEntry(doc, { kind: 'revoke', target_device_id: 'device-1', signer_device_id: 'FOUNDER' })
    const ctx = createAuthorityReplayContext(Automerge, doc, { founderDeviceId: 'FOUNDER' })
    // Removing an already-absent admin is a no-op on the admin set itself (nothing to remove),
    // but the entry must not spuriously grant admin or otherwise corrupt state.
    expect(ctx.currentState().grantedSet.has('device-1')).toBe(false)
    expect(ctx.currentState().grantedSet.has('FOUNDER')).toBe(true)
  })
})

describe('battle test 12 — a shrinking admin denominator never blocks an in-progress vote', () => {
  it('a vote cast while N=5 still counts, and threshold drops as N shrinks, never rises', () => {
    let doc = initDoc()
    doc = pushEntry(doc, { kind: 'grant', target_device_id: 'TARGET', signer_device_id: 'FOUNDER' })
    doc = pushEntry(doc, { kind: 'grant', target_device_id: 'X1', signer_device_id: 'FOUNDER' })
    doc = pushEntry(doc, { kind: 'grant', target_device_id: 'X2', signer_device_id: 'FOUNDER' })
    doc = pushEntry(doc, { kind: 'grant', target_device_id: 'X3', signer_device_id: 'FOUNDER' })
    // N=5 (FOUNDER, TARGET, X1, X2, X3); threshold for TARGET = floor(4/2)+1 = 3.
    doc = pushEntry(doc, { kind: 'revoke', target_device_id: 'TARGET', signer_device_id: 'FOUNDER' })
    {
      const ctx = createAuthorityReplayContext(Automerge, doc, { founderDeviceId: 'FOUNDER' })
      expect(ctx.currentState().grantedSet.has('TARGET')).toBe(true) // 1 of 3 needed — not enough
    }
    // X3 (a non-voting, non-target admin) is itself removed. At this point TARGET is still
    // admin, so N=5 and X3's own removal needs 3 of its 4 others (FOUNDER, TARGET, X1, X2).
    doc = pushEntry(doc, { kind: 'revoke', target_device_id: 'X3', signer_device_id: 'FOUNDER' })
    doc = pushEntry(doc, { kind: 'revoke', target_device_id: 'X3', signer_device_id: 'X1' })
    doc = pushEntry(doc, { kind: 'revoke', target_device_id: 'X3', signer_device_id: 'TARGET' })
    {
      const ctx = createAuthorityReplayContext(Automerge, doc, { founderDeviceId: 'FOUNDER' })
      expect(ctx.currentState().grantedSet.has('X3')).toBe(false)
      expect(ctx.currentState().grantedSet.has('TARGET')).toBe(true) // still only 1 vote on TARGET
    }
    // The ALREADY-CAST vote (FOUNDER, above) plus one more (X2) now meets the lowered threshold.
    doc = pushEntry(doc, { kind: 'revoke', target_device_id: 'TARGET', signer_device_id: 'X2' })
    const ctx = createAuthorityReplayContext(Automerge, doc, { founderDeviceId: 'FOUNDER' })
    expect(ctx.currentState().grantedSet.has('TARGET')).toBe(false)
  })
})

describe('isEntryTrusted — authenticity filter', () => {
  it('drops an entry the predicate rejects, before it can affect the replay', () => {
    let doc = initDoc()
    doc = pushEntry(doc, { kind: 'grant', target_device_id: 'A', signer_device_id: 'FOUNDER' })
    doc = pushEntry(doc, { kind: 'grant', target_device_id: 'FORGED', signer_device_id: 'FOUNDER' })
    const isEntryTrusted = (entry) => entry.target_device_id !== 'FORGED'
    const ctx = createAuthorityReplayContext(Automerge, doc, { founderDeviceId: 'FOUNDER', isEntryTrusted })
    expect(ctx.currentState().grantedSet.has('A')).toBe(true)
    expect(ctx.currentState().grantedSet.has('FORGED')).toBe(false)
  })

  it('defaults to always-true when omitted (no behavior change for existing callers)', () => {
    let doc = initDoc()
    doc = pushEntry(doc, { kind: 'grant', target_device_id: 'A', signer_device_id: 'FOUNDER' })
    const ctx = createAuthorityReplayContext(Automerge, doc, { founderDeviceId: 'FOUNDER' })
    expect(ctx.currentState().grantedSet.has('A')).toBe(true)
  })
})

describe('currentAuthorityState', () => {
  it('exposes admins and votes', () => {
    let doc = initDoc()
    doc = pushEntry(doc, { kind: 'grant', target_device_id: 'A', signer_device_id: 'FOUNDER' })
    const { admins } = currentAuthorityState(Automerge, doc, { founderDeviceId: 'FOUNDER' })
    expect(admins.has('A')).toBe(true)
    expect(admins.has('FOUNDER')).toBe(true)
  })
})

// RED HAT round-4 reproduction (against the real module, no mocks) — a NEW instance of the
// order-dependence class round-3 missed: the CURRENT-HEADS query path (currentState/
// currentAuthorityState — the path projector.js actually calls on every projection pass) used
// `getAllChanges`'s own iteration order to build "every known change" instead of a true ancestor
// closure, AND a signer with MORE THAN ONE entry against the SAME target (reachable by an honest
// device forking its own history — crash+restore, two offline sessions under one identity key,
// not only an adversary) resolved to "whichever entry a non-canonical iteration visited last."
describe('round-4 correction — same-signer, same-target entries across concurrent branches converge regardless of merge order', () => {
  it("Red Hat's exact topology: FOUNDER's lone revoke-vote on one branch vs FOUNDER's own revoke-then-regrant cycle on a concurrent, never-synced branch", () => {
    let base = initDoc()
    base = pushEntry(base, { kind: 'grant', target_device_id: 'X', signer_device_id: 'FOUNDER' })
    // N=2 (FOUNDER, X). Two branches fork from `base` and are NEVER synced with each other before
    // the merges below.
    let branchVote = Automerge.clone(base)
    let branchCycle = Automerge.clone(base)
    // branchVote: FOUNDER casts one revoke of X.
    branchVote = pushEntry(branchVote, { kind: 'revoke', target_device_id: 'X', signer_device_id: 'FOUNDER' })
    // branchCycle (concurrent): FOUNDER revokes X, then re-grants X — a full cycle, entirely on
    // its own branch, never seeing branchVote's entry.
    branchCycle = pushEntry(branchCycle, { kind: 'revoke', target_device_id: 'X', signer_device_id: 'FOUNDER' })
    branchCycle = pushEntry(branchCycle, { kind: 'grant', target_device_id: 'X', signer_device_id: 'FOUNDER' })

    const mergeOrder1 = Automerge.merge(Automerge.clone(branchVote), branchCycle)
    const mergeOrder2 = Automerge.merge(Automerge.clone(branchCycle), branchVote)

    const result1 = createAuthorityReplayContext(Automerge, mergeOrder1, { founderDeviceId: 'FOUNDER' }).currentState().grantedSet.has('X')
    const result2 = createAuthorityReplayContext(Automerge, mergeOrder2, { founderDeviceId: 'FOUNDER' }).currentState().grantedSet.has('X')
    expect(result1).toBe(result2)
  })

  it('a signer with 3 mutually-concurrent entries against the same target still resolves identically regardless of merge order', () => {
    // Three-way fork, all from the same base, all never synced with each other before merging —
    // FOUNDER signs a DIFFERENT entry on each branch, all mutually concurrent.
    let base = initDoc()
    base = pushEntry(base, { kind: 'grant', target_device_id: 'X', signer_device_id: 'FOUNDER' })
    let b1 = pushEntry(Automerge.clone(base), { kind: 'revoke', target_device_id: 'X', signer_device_id: 'FOUNDER' })
    let b2 = pushEntry(Automerge.clone(base), { kind: 'grant', target_device_id: 'X', signer_device_id: 'FOUNDER' })
    let b3 = pushEntry(Automerge.clone(base), { kind: 'revoke', target_device_id: 'X', signer_device_id: 'FOUNDER' })

    const orderA = Automerge.merge(Automerge.merge(Automerge.clone(b1), b2), b3)
    const orderB = Automerge.merge(Automerge.merge(Automerge.clone(b3), b1), b2)
    const orderC = Automerge.merge(Automerge.merge(Automerge.clone(b2), b3), b1)

    const a = createAuthorityReplayContext(Automerge, orderA, { founderDeviceId: 'FOUNDER' }).currentState().grantedSet.has('X')
    const b = createAuthorityReplayContext(Automerge, orderB, { founderDeviceId: 'FOUNDER' }).currentState().grantedSet.has('X')
    const c = createAuthorityReplayContext(Automerge, orderC, { founderDeviceId: 'FOUNDER' }).currentState().grantedSet.has('X')
    expect(a).toBe(b)
    expect(b).toBe(c)
  })
})

// CRITICAL (round-4) — property-based convergence: hand-picked topologies have now missed this
// divergence class TWICE. Generate many random concurrent authority-log DAGs and assert merging
// the same branch set in different orders always converges to the IDENTICAL final admin state.
// Deterministic seed (a simple xorshift-style PRNG, no external dependency) so a failure
// reproduces exactly from the printed seed.
describe('round-4 CRITICAL — property-based convergence over random concurrent DAGs', () => {
  function mulberry32(seed) {
    let a = seed
    return function () {
      a |= 0
      a = (a + 0x6d2b79f5) | 0
      let t = Math.imul(a ^ (a >>> 15), 1 | a)
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296
    }
  }

  const SEED = 331044
  const CASES = 60
  const DEVICES = ['FOUNDER', 'A', 'B', 'C']
  const BRANCH_COUNT = 3
  const OPS_PER_BRANCH = 3

  // Builds one random concurrent DAG: FOUNDER + some devices granted on a shared base, then
  // BRANCH_COUNT branches fork from that base and NEVER see each other's writes before the test
  // merges them — each branch gets a short random sequence of grant/revoke ops from random
  // signers against random targets (deliberately including the SAME signer acting on multiple
  // branches, and the SAME target across branches, to hit both round-4 root causes).
  function buildRandomDag(rng) {
    const pick = (arr) => arr[Math.floor(rng() * arr.length)]
    let base = initDoc()
    base = pushEntry(base, { kind: 'grant', target_device_id: 'FOUNDER', signer_device_id: 'FOUNDER' })
    // Pre-grant a random subset of the other devices on the shared base, so branches have more
    // than one admin to work with.
    for (const d of DEVICES) {
      if (d !== 'FOUNDER' && rng() < 0.7) base = pushEntry(base, { kind: 'grant', target_device_id: d, signer_device_id: 'FOUNDER' })
    }
    const branches = []
    for (let b = 0; b < BRANCH_COUNT; b++) {
      let branch = Automerge.clone(base)
      for (let i = 0; i < OPS_PER_BRANCH; i++) {
        const kind = rng() < 0.5 ? 'grant' : 'revoke'
        const signer = pick(DEVICES)
        const target = pick(DEVICES)
        if (signer === target) continue // never a valid entry; skip rather than waste an op
        branch = pushEntry(branch, { kind, target_device_id: target, signer_device_id: signer })
      }
      branches.push(branch)
    }
    return branches
  }

  function finalAdmins(doc) {
    return [...createAuthorityReplayContext(Automerge, doc, { founderDeviceId: 'FOUNDER' }).currentState().grantedSet].sort()
  }

  // Merges a list of branches in the given permutation of indices, pairwise, left to right.
  function mergeInOrder(branches, order) {
    let acc = Automerge.clone(branches[order[0]])
    for (let i = 1; i < order.length; i++) acc = Automerge.merge(acc, branches[order[i]])
    return acc
  }

  function permutations(n) {
    if (n <= 1) return [[0]]
    const rest = permutations(n - 1)
    const out = []
    for (const perm of rest) {
      for (let i = 0; i < n; i++) {
        out.push([...perm.slice(0, i), n - 1, ...perm.slice(i)])
      }
    }
    return out
  }

  it(`${CASES} random concurrent DAGs (seed ${SEED}) all converge to the identical admin set regardless of merge order`, () => {
    const rng = mulberry32(SEED)
    const orders = permutations(BRANCH_COUNT) // all 3! = 6 merge orders for 3 branches
    let casesChecked = 0
    for (let c = 0; c < CASES; c++) {
      const branches = buildRandomDag(rng)
      const results = orders.map((order) => finalAdmins(mergeInOrder(branches, order)))
      const canonical = JSON.stringify(results[0])
      for (let i = 1; i < results.length; i++) {
        expect(
          JSON.stringify(results[i]),
          `case ${c} (seed ${SEED}): merge order ${JSON.stringify(orders[i])} gave ${JSON.stringify(results[i])}, ` +
            `but merge order ${JSON.stringify(orders[0])} gave ${canonical} — divergent final admin set for the SAME change set.`
        ).toBe(canonical)
      }
      casesChecked++
    }
    expect(casesChecked).toBe(CASES)
  })
})
