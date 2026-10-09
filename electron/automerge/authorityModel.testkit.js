// Test-support only (imported by authorityModel.test.js; nothing in production imports this).
// A pure, abstract model of the authority log used to compare today's T331 rule with the
// effective-grant rule of docs/adr/2026-10-09-host-succession-by-remint.md section 2.1 / 8.1.
//
// History: entries { id, kind: 'genesis'|'grant'|'revoke', signer, target, deps: [ids] } forming a
// DAG (Automerge-like causal order; every entry's ancestors are the transitive closure of deps).
// Signatures are assumed already verified. A genesis entry has signer null and target = founder.
import { quorumThreshold } from './authorityReplay.js'

export { quorumThreshold }

export function indexHistory(entries) {
  const byId = new Map(entries.map((e) => [e.id, e]))
  const ancMemo = new Map()
  function anc(id) {
    if (ancMemo.has(id)) return ancMemo.get(id)
    const out = new Set()
    for (const d of byId.get(id).deps) {
      out.add(d)
      for (const a of anc(d)) out.add(a)
    }
    ancMemo.set(id, out)
    return out
  }
  function heads() {
    const depended = new Set()
    for (const e of entries) for (const d of e.deps) depended.add(d)
    return entries.filter((e) => !depended.has(e.id)).map((e) => e.id)
  }
  const genesis = entries.find((e) => e.kind === 'genesis')
  return { entries, byId, anc, heads, founder: genesis ? genesis.target : null }
}

// ---------------------------------------------------------------------------------------------
// todayRule: faithful replica of authorityReplay.js stateAt (T331 as shipped).
//   - an entry counts iff its signer is in granted-set at the entry's OWN causal point
//   - grants add; a revoke is a vote; a vote is stale if a grant of the target has it as ancestor
//   - fixed point: target removed when distinct surviving voters >= quorumThreshold(|granted|)
//     with |granted| read at the evaluated point (heads), including the target
// ---------------------------------------------------------------------------------------------
export function todayRule(entries, { filterVotes = false } = {}) {
  const ix = indexHistory(entries)
  const memo = new Map()
  const ALL = '\u0000heads'

  function stateAt(key) {
    if (memo.has(key)) return memo.get(key)
    const P = key === ALL ? new Set(entries.map((e) => e.id)) : ix.anc(key)
    const granted = new Set(ix.founder != null ? [ix.founder] : [])
    const grantIds = new Map() // target -> Set<entryId>
    const voteIds = new Map() // target -> Map<signer, Set<entryId>>
    for (const id of P) {
      const e = ix.byId.get(id)
      if (e.kind === 'genesis') continue
      if (e.signer === e.target) continue
      if (!stateAt(id).granted.has(e.signer)) continue
      if (e.kind === 'grant') {
        granted.add(e.target)
        if (!grantIds.has(e.target)) grantIds.set(e.target, new Set())
        grantIds.get(e.target).add(id)
        continue
      }
      if (!voteIds.has(e.target)) voteIds.set(e.target, new Map())
      const bySigner = voteIds.get(e.target)
      if (!bySigner.has(e.signer)) bySigner.set(e.signer, new Set())
      bySigner.get(e.signer).add(id)
    }
    const votes = new Map()
    for (const [target, bySigner] of voteIds) {
      const gs = grantIds.get(target)
      for (const [signer, ids] of bySigner) {
        const surviving = gs ? [...ids].filter((v) => ![...gs].some((g) => g !== v && ix.anc(g).has(v))) : [...ids]
        if (surviving.length === 0) continue
        if (!votes.has(target)) votes.set(target, new Set())
        votes.get(target).add(signer)
      }
    }
    if (filterVotes) {
      // Sticky rounds. C = targets that reach the threshold when every remaining signer's vote counts.
      // A target in C may itself be a signer of votes that only exist because it is being removed
      // (a backdated vote), so a round removes only those t in C that STILL reach the threshold when
      // votes by members of C are dropped. If C is non-empty but nothing survives that test the round
      // removes nothing (a deadlock: safe, deterministic, label-free). No iteration order is consulted.
      const reach = (t, excluded) => {
        const th = quorumThreshold(granted.size)
        return [...votes.get(t)].filter((s) => granted.has(s) && !excluded.has(s)).length >= th
      }
      for (;;) {
        const C = new Set([...votes.keys()].filter((t) => granted.has(t) && reach(t, new Set())))
        const dead = [...C].filter((t) => reach(t, C))
        if (dead.length === 0) break
        for (const t of dead) granted.delete(t)
      }
    } else {
      let changed = true
      while (changed) {
        changed = false
        for (const [target, voters] of votes) {
          if (!granted.has(target)) continue
          if (voters.size >= quorumThreshold(granted.size)) {
            granted.delete(target)
            changed = true
          }
        }
      }
    }
    const result = { granted, votes }
    memo.set(key, result)
    return result
  }

  return { admins: stateAt(ALL).granted }
}

// todayRule(entries, { filterVotes: true }) is the T353 candidate: identical to today except a vote
// counts only while its signer is not removed (at heads, via sticky simultaneous rounds). Grant
// semantics are untouched.
// ---------------------------------------------------------------------------------------------
// effectiveSet: the effective-grant rule (ADR 2.1 / 8.1) as the fixed point reached by iterating
// UP from the genesis, so a grant is admitted only after its justification already holds.
//
// Everything below is a function of a candidate effective set E (a set of grant entry ids):
//
//  Adm_E(Q), Q a causally closed set of entries: { t : some g in E, g in Q, targets t } minus
//     Removed_E(Q). The genesis entry is the founder's grant.
//  Counted_E vote: revoke v (voter s, target t, s != t) is counted iff s in Adm_E(anc(v)) and
//     (t is the founder or some g in E, g in anc(v), targets t)   [voter is an effective admin at
//     its causal point; author saw an effective grant of t (ADR 8.1)].
//  Stale_E vote: some g in E targets t with v in anc(g) (unchanged T331 staleness; only EFFECTIVE
//     grants supersede, so a self-supporting re-grant cannot void the votes that kill its support).
//  Q(W), W counted votes by DISTINCT voters against t: |W| >= quorumThreshold(n_W) where
//     n_W = |Adm_E(J)|, J = union of anc(w), w in W  (keeper: n is read on the voters' JOINT causal
//     past, not at heads). J is a union of closed sets, hence closed; a vote that is an ancestor of
//     another vote stays in J (removing it would break closure).
//  Removed_E(Q): t (target of an E grant in Q) is removed iff some W drawn from the counted,
//     non-stale votes against t in Q satisfies Q(W).
//
//  F(E) = {genesis} union { g : g grant, signer s != target,
//     (i)  s in Adm_E(anc(g))                 signer admitted at the grant's own causal point, and
//     (ii) there is NO W, drawn only from counted non-stale votes against s whose own pasts do not
//          contain g, with Q(W) }              (ADR 2.1 branch 2: the removal of s needs no voter
//          that has seen g; a backdated grant by a removed signer fails exactly this)
//  The "alive signer, position irrelevant" branch 1 is NOT modelled (strictly safer; liveness cost
//  only: an admin signing on dependencies older than its own admission is not effective).
//
//  E* is reached by iterating E_0 = {genesis}, E_{k+1} = F(E_k). When F is monotone along the
//  chain this is the least fixed point and `monotone` stays true. F is not monotone in general
//  (a larger E can make more votes countable, which can kill a grant admitted earlier). If the
//  iteration ever drops a member, the model keeps going deterministically and, if the sequence
//  cycles, takes the intersection of the cycle (conservative); `monotone: false` flags it so a
//  test can report the history.
// ---------------------------------------------------------------------------------------------
export function effectiveSet(entries) {
  const ix = indexHistory(entries)
  const key = (ids) => [...ids].sort().join('|')
  const grantsAll = entries.filter((e) => e.kind !== 'revoke').map((e) => e.id)
  const genesisIds = entries.filter((e) => e.kind === 'genesis').map((e) => e.id)

  function evaluator(E) {
    const admMemo = new Map()
    const countedMemo = new Map()
    const nMemo = new Map()

    function removedIn(Q) {
      const removed = new Set()
      const targets = new Set([...E].filter((g) => Q.has(g)).map((g) => ix.byId.get(g).target))
      for (const t of targets) if (quorumExists(liveVotes(Q, t))) removed.add(t)
      return removed
    }

    function adm(Q) {
      const k = key(Q)
      if (admMemo.has(k)) return admMemo.get(k)
      const removed = removedIn(Q)
      const out = new Set(
        [...E].filter((g) => Q.has(g)).map((g) => ix.byId.get(g).target).filter((t) => !removed.has(t))
      )
      admMemo.set(k, out)
      return out
    }

    function counted(id) {
      if (countedMemo.has(id)) return countedMemo.get(id)
      const v = ix.byId.get(id)
      const past = ix.anc(id)
      const ok =
        v.signer !== v.target &&
        adm(past).has(v.signer) &&
        (v.target === ix.founder || [...E].some((g) => past.has(g) && ix.byId.get(g).target === v.target))
      countedMemo.set(id, ok)
      return ok
    }

    function liveVotes(Q, target) {
      const gs = [...E].filter((g) => Q.has(g) && ix.byId.get(g).target === target)
      const out = []
      for (const id of Q) {
        const v = ix.byId.get(id)
        if (v.kind !== 'revoke' || v.target !== target) continue
        if (!counted(id)) continue
        if (gs.some((g) => ix.anc(g).has(id))) continue
        out.push(v)
      }
      return out
    }

    function jointN(votes) {
      const J = new Set()
      for (const w of votes) for (const a of ix.anc(w.id)) J.add(a)
      const k = key(J)
      if (!nMemo.has(k)) nMemo.set(k, adm(J).size)
      return nMemo.get(k)
    }

    function quorumExists(candidates) {
      const byVoter = new Map()
      for (const v of candidates) {
        if (!byVoter.has(v.signer)) byVoter.set(v.signer, [])
        byVoter.get(v.signer).push(v)
      }
      const voters = [...byVoter.keys()]
      function dfs(i, chosen) {
        if (i === voters.length) return chosen.length > 0 && chosen.length >= quorumThreshold(jointN(chosen))
        if (dfs(i + 1, chosen)) return true
        for (const v of byVoter.get(voters[i])) {
          chosen.push(v)
          const hit = dfs(i + 1, chosen)
          chosen.pop()
          if (hit) return true
        }
        return false
      }
      return dfs(0, [])
    }

    function allQuorums(target) {
      const byVoter = new Map()
      for (const e of entries) {
        if (e.kind !== 'revoke' || e.target !== target || !counted(e.id)) continue
        if (!byVoter.has(e.signer)) byVoter.set(e.signer, [])
        byVoter.get(e.signer).push(e)
      }
      const voters = [...byVoter.keys()]
      const out = []
      ;(function dfs(i, chosen) {
        if (i === voters.length) {
          if (chosen.length > 0 && chosen.length >= quorumThreshold(jointN(chosen))) out.push([...chosen])
          return
        }
        dfs(i + 1, chosen)
        for (const v of byVoter.get(voters[i])) {
          chosen.push(v)
          dfs(i + 1, chosen)
          chosen.pop()
        }
      })(0, [])
      return out
    }

    return { adm, counted, liveVotes, quorumExists, allQuorums }
  }

  const ALL = new Set(entries.map((e) => e.id))

  function F(E) {
    const ev = evaluator(E)
    const next = new Set(genesisIds)
    for (const id of grantsAll) {
      const g = ix.byId.get(id)
      if (g.kind === 'genesis' || g.signer === g.target) continue
      if (!ev.adm(ix.anc(id)).has(g.signer)) continue
      const dead = ev.quorumExists(ev.liveVotes(ALL, g.signer).filter((w) => !ix.anc(w.id).has(id)))
      if (!dead) next.add(id)
    }
    return next
  }

  const sameSet = (a, b) => a.size === b.size && [...a].every((x) => b.has(x))
  let E = new Set(genesisIds)
  let monotone = true
  const seen = [E]
  for (let i = 0; i < grantsAll.length + 8; i++) {
    const next = F(E)
    if (sameSet(next, E)) break
    if ([...E].some((x) => !next.has(x))) monotone = false
    const loop = seen.findIndex((s) => sameSet(s, next))
    if (loop >= 0) {
      E = new Set([...next].filter((x) => seen.slice(loop).every((s) => s.has(x))))
      break
    }
    seen.push(next)
    E = next
  }

  const stable = sameSet(F(E), E)
  const ev = evaluator(E)
  const admins = ev.adm(ALL)
  const removed = new Set(
    [...E].map((g) => ix.byId.get(g).target).filter((t) => !admins.has(t))
  )
  return { admins, effective: E, removed, monotone, stable, historicQuorums: ev.allQuorums, countedVotes: ev.counted, ix }
}

// Remove every entry signed by `device` that is not in `keep`, rewiring dependents to the removed
// entry's own deps (so the causal order of what remains is preserved).
export function withoutSignerEntries(entries, device, keep = new Set()) {
  const byId = new Map(entries.map((e) => [e.id, e]))
  const gone = new Set(entries.filter((e) => e.signer === device && !keep.has(e.id)).map((e) => e.id))
  const expand = (d) => (gone.has(d) ? byId.get(d).deps.flatMap(expand) : [d])
  return entries
    .filter((e) => !gone.has(e.id))
    .map((e) => ({ ...e, deps: [...new Set(e.deps.flatMap(expand))] }))
}

export function history() {
  const entries = []
  const api = {
    entries,
    genesis(id, founder) {
      entries.push({ id, kind: 'genesis', signer: null, target: founder, deps: [] })
      return api
    },
    grant(id, signer, target, deps) {
      entries.push({ id, kind: 'grant', signer, target, deps })
      return api
    },
    revoke(id, signer, target, deps) {
      entries.push({ id, kind: 'revoke', signer, target, deps })
      return api
    },
  }
  return api
}

export function mulberry32(seed) {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

// Random small causal history. Entries depend on random existing entries; with probability ~.45 an
// entry takes ALL current heads (an honest author who has synced everything), otherwise a random
// older subset (stale authors and adversarial backdating).
export function randomHistory(seed) {
  const rnd = mulberry32(seed)
  const pick = (n) => Math.floor(rnd() * n)
  const nDev = 3 + pick(4)
  const devs = Array.from({ length: nDev }, (_, i) => 'D' + i)
  const total = 5 + pick(16)
  const entries = [{ id: 'e0', kind: 'genesis', signer: null, target: 'D0', deps: [] }]
  const everGranted = ['D0']
  for (let i = 1; i < total; i++) {
    const depended = new Set(entries.flatMap((e) => e.deps))
    const headIds = entries.filter((e) => !depended.has(e.id)).map((e) => e.id)
    let deps
    if (rnd() < 0.45) deps = headIds
    else {
      const k = 1 + pick(Math.min(3, entries.length))
      deps = [...new Set(Array.from({ length: k }, () => entries[pick(entries.length)].id))]
    }
    const kind = rnd() < 0.55 ? 'grant' : 'revoke'
    const signer = rnd() < 0.85 ? everGranted[pick(everGranted.length)] : devs[pick(nDev)]
    let target = devs[pick(nDev)]
    if (target === signer) target = devs[(devs.indexOf(signer) + 1) % nDev]
    entries.push({ id: 'e' + i, kind, signer, target, deps })
    if (kind === 'grant' && !everGranted.includes(target)) everGranted.push(target)
  }
  return entries
}

export function relabel(entries, rnd) {
  const ids = entries.map((e) => e.id)
  const shuffled = [...ids].sort(() => rnd() - 0.5)
  const map = new Map(ids.map((id, i) => [id, 'x' + shuffled.indexOf(id) + '_' + i]))
  const out = entries.map((e) => ({ ...e, id: map.get(e.id), deps: e.deps.map((d) => map.get(d)) }))
  return out.sort(() => rnd() - 0.5)
}
