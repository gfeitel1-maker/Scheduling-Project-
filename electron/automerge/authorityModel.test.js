// Pure-model evidence for docs/adr/2026-10-09-host-succession-by-remint.md section 2.1 / 8.1:
// todayRule replicates T331 as shipped (attacks succeed); effectiveSet is the proposed
// least-fixed-point effective-grant rule with the keeper's voters'-joint-past denominator.
import { describe, it, expect } from 'vitest'
import {
  todayRule,
  effectiveSet,
  history,
  randomHistory,
  relabel,
  mulberry32,
  withoutSignerEntries,
  quorumThreshold,
  seniority,
  currentGrants,
  indexHistory,
} from './authorityModel.testkit.js'

const sorted = (s) => [...s].sort()
const today = (h) => sorted(todayRule(h.entries).admins)
const eff = (h) => sorted(effectiveSet(h.entries).admins)

// A (founder), B, C granted by A in a chain; deps are the previous grant.
function camp(...members) {
  const h = history().genesis('g0', 'A')
  let prev = 'g0'
  for (const m of members) {
    h.grant('g' + m, 'A', m, [prev])
    prev = 'g' + m
  }
  return { h, last: prev }
}

describe('fixed attack cases', () => {
  it('challenge-3: quorum-removed pair M,T backdate a stand-in X who re-grants both', () => {
    const { h, last } = camp('B', 'M', 'T') // n=4, threshold 2
    h.revoke('vM1', 'A', 'M', [last]).revoke('vM2', 'B', 'M', [last])
    h.revoke('vT1', 'A', 'T', ['vM1', 'vM2']).revoke('vT2', 'B', 'T', ['vM1', 'vM2'])
    h.grant('gX', 'M', 'X', [last]) // backdated onto pre-removal heads
    h.grant('gM2', 'X', 'M', ['gX', 'vM1', 'vM2', 'vT1', 'vT2'])
    h.grant('gT2', 'X', 'T', ['gX', 'vM1', 'vM2', 'vT1', 'vT2'])
    expect(today(h)).toEqual(['A', 'B', 'M', 'T', 'X']) // attack succeeds today
    expect(eff(h)).toEqual(['A', 'B'])
  })

  it('challenge-4/5: one-hop stand-in X (M removed, backdated grant(X), X revokes B)', () => {
    const { h, last } = camp('B', 'M')
    h.revoke('v1', 'A', 'M', [last]).revoke('v2', 'B', 'M', [last])
    h.grant('gX', 'M', 'X', [last])
    h.revoke('vX', 'X', 'B', ['gX'])
    h.revoke('vM', 'M', 'B', [last]) // M's own backdated vote (counts at M's causal point, as in ADR 2.1)
    expect(today(h)).toEqual(['A', 'X']) // B removed by M + X at heads size 3 / threshold 2
    expect(eff(h)).toEqual(['A', 'B']) // X not admin; M's lone vote (n_W=3, threshold 2) is not a quorum
  })

  it('challenge-4/5 variant: stand-in X alone cannot revoke B (today also refuses; model must too)', () => {
    const { h, last } = camp('B', 'M')
    h.revoke('v1', 'A', 'M', [last]).revoke('v2', 'B', 'M', [last])
    h.grant('gX', 'M', 'X', [last])
    h.revoke('vX', 'X', 'B', ['gX'])
    expect(today(h)).toEqual(['A', 'B', 'X'])
    expect(eff(h)).toEqual(['A', 'B'])
  })

  it('two-hop M -> X -> Y: Y is not an admin and its vote does not count', () => {
    const { h, last } = camp('B', 'M')
    h.revoke('v1', 'A', 'M', [last]).revoke('v2', 'B', 'M', [last])
    h.grant('gX', 'M', 'X', [last])
    h.grant('gY', 'X', 'Y', ['gX'])
    h.revoke('vY', 'Y', 'B', ['gY'])
    h.revoke('vM', 'M', 'B', [last])
    expect(today(h)).toEqual(expect.arrayContaining(['X', 'Y'])) // attack gains two admins (and un-removes M via the heads denominator)
    expect(eff(h)).toEqual(['A', 'B'])
  })

  it('challenge-6: self-supporting cycle (X re-grants M after the votes) leaves M removed, X not admin', () => {
    const { h, last } = camp('B', 'M')
    h.revoke('v1', 'A', 'M', [last]).revoke('v2', 'B', 'M', [last])
    h.grant('gX', 'M', 'X', [last])
    h.grant('gM2', 'X', 'M', ['gX', 'v1', 'v2'])
    expect(today(h)).toEqual(['A', 'B', 'M', 'X']) // M readmitted today
    expect(eff(h)).toEqual(['A', 'B'])
    const m = effectiveSet(h.entries)
    expect(m.effective.has('gX')).toBe(false)
    expect(m.effective.has('gM2')).toBe(false)
  })
})

describe('denominators: stand-ins never change n or the outcome', () => {
  it('2 admins: after M is removed, A alone (threshold 1) removes B despite two backdated stand-ins', () => {
    const { h, last } = camp('B', 'M')
    h.revoke('v1', 'A', 'M', [last]).revoke('v2', 'B', 'M', [last])
    h.grant('gX1', 'M', 'X1', [last]).grant('gX2', 'M', 'X2', [last])
    h.revoke('vB', 'A', 'B', ['v1', 'v2'])
    expect(quorumThreshold(2)).toBe(1)
    expect(eff(h)).toEqual(['A'])
    // today's heads denominator (A,B,M,X1,X2 = 5, threshold 3) leaves M un-removed
    expect(today(h)).toContain('M')
  })

  it('3 admins: two votes remove C, one does not, with a stand-in present and voting', () => {
    const { h, last } = camp('B', 'C', 'M')
    h.revoke('v1', 'A', 'M', [last]).revoke('v2', 'B', 'M', [last])
    h.grant('gX', 'M', 'X', [last])
    const after = ['v1', 'v2']
    const two = history()
    two.entries.push(...h.entries)
    two.revoke('cA', 'A', 'C', after).revoke('cB', 'B', 'C', after)
    expect(eff(two)).toEqual(['A', 'B'])

    const one = history()
    one.entries.push(...h.entries)
    one.revoke('cA', 'A', 'C', after).revoke('cX', 'X', 'C', ['gX'])
    expect(eff(one)).toEqual(['A', 'B', 'C'])
  })
})

describe('legitimate paths still work', () => {
  it('2-device revoke of the founder by the remaining admin', () => {
    const { h, last } = camp('B')
    h.revoke('v', 'B', 'A', [last])
    expect(eff(h)).toEqual(['B'])
    expect(today(h)).toEqual(['B'])
  })

  it('blind vote (author saw no grant of the target) does not count; today removes', () => {
    const { h } = camp('B', 'C')
    h.grant('gT', 'C', 'T', ['gC'])
    h.revoke('vA', 'A', 'T', ['gC'])
    h.revoke('vB', 'B', 'T', ['gC'])
    expect(today(h)).toEqual(['A', 'B', 'C'])
    expect(eff(h)).toEqual(['A', 'B', 'C', 'T'])
  })

  it('honest admin granted by a signer later removed by voters who had not seen it loses status; a re-grant restores it', () => {
    const { h, last } = camp('B', 'M')
    h.grant('gH', 'M', 'H', [last])
    h.revoke('v1', 'A', 'M', [last]).revoke('v2', 'B', 'M', [last])
    expect(today(h)).toEqual(['A', 'B', 'H'])
    expect(eff(h)).toEqual(['A', 'B'])
    h.grant('gH2', 'A', 'H', ['gH', 'v1', 'v2'])
    expect(eff(h)).toEqual(['A', 'B', 'H'])
  })

  it('a grant the removing voters HAD seen survives its signer removal', () => {
    const { h, last } = camp('B', 'M')
    h.grant('gH', 'M', 'H', [last])
    h.revoke('v1', 'A', 'M', ['gH']).revoke('v2', 'B', 'M', ['gH'])
    expect(eff(h)).toEqual(['A', 'B', 'H'])
  })

  it('documented semantics: a stand-in the voters saw (granted by M before removal) may re-grant M, like any current admin', () => {
    const { h, last } = camp('B', 'M')
    h.grant('gX', 'M', 'X', [last])
    h.revoke('v1', 'A', 'M', ['gX']).revoke('v2', 'B', 'M', ['gX'])
    h.grant('gM2', 'X', 'M', ['v1', 'v2'])
    expect(eff(h)).toEqual(['A', 'B', 'M', 'X'])
  })
})

describe('property: random causal histories (seeded)', () => {
  const SEEDS = 500
  const fail = (seed, entries, msg) =>
    new Error(`seed ${seed}: ${msg}\n${JSON.stringify(entries)}`)

  it('order independence: array order and id labels do not change the admin set', () => {
    for (let seed = 1; seed <= SEEDS; seed++) {
      const base = randomHistory(seed)
      const want = sorted(effectiveSet(base).admins)
      const rnd = mulberry32(seed * 7919)
      for (let k = 0; k < 4; k++) {
        const got = sorted(effectiveSet(relabel(base, rnd)).admins)
        if (JSON.stringify(got) !== JSON.stringify(want)) throw fail(seed, base, `perm ${k}: ${got} != ${want}`)
      }
    }
  })

  it('well-founded: every admin is reachable from the founder through effective grants', () => {
    for (let seed = 1; seed <= SEEDS; seed++) {
      const entries = randomHistory(seed)
      const m = effectiveSet(entries)
      const byId = new Map(entries.map((e) => [e.id, e]))
      const reached = new Set(['D0'])
      for (let grew = true; grew; ) {
        grew = false
        for (const g of m.effective) {
          const e = byId.get(g)
          if (e.kind === 'genesis') continue
          if (reached.has(e.signer) && !reached.has(e.target)) {
            reached.add(e.target)
            grew = true
          }
        }
      }
      for (const a of m.admins) if (!reached.has(a)) throw fail(seed, entries, `${a} admin without a grounded chain`)
    }
  })

  it('no-readmission: an admin with a historic removal quorum was re-granted by a grant admitted without the voters-unseen entries of that device', () => {
    let exercised = 0
    for (let seed = 1; seed <= SEEDS; seed++) {
      const entries = randomHistory(seed)
      const m = effectiveSet(entries)
      for (const t of m.admins) {
        for (const W of m.historicQuorums(t)) {
          exercised++
          const ok = W.some((w) => {
            const seen = m.ix.anc(w.id)
            const keep = new Set([...seen])
            const reduced = effectiveSet(withoutSignerEntries(entries, t, keep))
            return [...m.effective].some((g) => {
              const e = m.ix.byId.get(g)
              return e.target === t && e.signer !== t && m.ix.anc(g).has(w.id) && reduced.effective.has(g)
            })
          })
          if (!ok) throw fail(seed, entries, `${t} is admin despite a historic removal quorum with no independent re-grant`)
        }
      }
    }
    expect(exercised).toBeGreaterThan(0)
  })

  it('no stand-in gain: appending a backdated grant by a removed device never adds an admin', () => {
    let exercised = 0
    for (let seed = 1; seed <= SEEDS; seed++) {
      const entries = randomHistory(seed)
      const m = effectiveSet(entries)
      const removed = [...m.removed]
      if (removed.length === 0) continue
      const rnd = mulberry32(seed * 104729)
      const M = removed[Math.floor(rnd() * removed.length)]
      const ownGrant = entries.find((e) => e.kind === 'grant' && e.target === M && m.effective.has(e.id))
      if (!ownGrant) continue
      exercised++
      const withStand = [
        ...entries,
        { id: 'zX', kind: 'grant', signer: M, target: 'ZZ', deps: [ownGrant.id] },
        { id: 'zY', kind: 'grant', signer: 'ZZ', target: 'ZY', deps: ['zX'] },
        { id: 'zV', kind: 'revoke', signer: 'ZY', target: 'D0', deps: ['zY'] },
      ]
      const after = effectiveSet(withStand)
      for (const a of after.admins) {
        if (a === 'ZZ' || a === 'ZY') throw fail(seed, withStand, `stand-in ${a} became admin`)
      }
    }
    expect(exercised).toBeGreaterThan(0)
  })
})

const KNOWN_UNSTABLE_SEEDS = [209, 467]

describe('construction: fixed point stability', () => {
  it('KNOWN GAP: the bottom-up iteration is not monotone in general (a grant admitted early can be dropped once more votes become countable), but still lands on the right set', () => {
    // D0 (founder) grants D2; D0 revokes D1; D2 revokes the founder; D0 then grants D1 on pre-removal deps.
    const h = history().genesis('e0', 'D0')
      .grant('e1', 'D0', 'D2', ['e0'])
      .revoke('e2', 'D0', 'D1', ['e1'])
      .revoke('e3', 'D2', 'D0', ['e2'])
      .grant('e4', 'D0', 'D1', ['e3'])
    const m = effectiveSet(h.entries)
    expect(m.monotone).toBe(false)
    expect(m.stable).toBe(true)
    expect(sorted(m.admins)).toEqual(['D2'])
  })

  const unstable = () => {
    const out = []
    for (let seed = 1; seed <= 500; seed++) if (!effectiveSet(randomHistory(seed)).stable) out.push(seed)
    return out
  }

  // KNOWN FAILURE (not weakened): the bottom-up iteration can enter a 2-cycle instead of reaching a
  // fixed point. The model then returns the intersection of the cycle (conservative). Seed 209's
  // 20-entry history is the smallest found; printed by the pinned test below.
  it.fails('the final effective set is a stable fixed point (F(E) = E) on every random history', () => {
    expect(unstable()).toEqual([])
  })

  it('pins the seeds that currently end on a cycle (update deliberately when the model changes)', () => {
    expect(unstable()).toEqual(KNOWN_UNSTABLE_SEEDS)
  })
})

describe('differential vs todayRule on linear (concurrency-free) chains', () => {
  it('reports divergences instead of assuming agreement', () => {
    const diffs = []
    for (let seed = 1; seed <= 300; seed++) {
      const rnd = mulberry32(seed)
      const pick = (n) => Math.floor(rnd() * n)
      const devs = ['D0', 'D1', 'D2', 'D3', 'D4']
      const entries = [{ id: 'c0', kind: 'genesis', signer: null, target: 'D0', deps: [] }]
      let admins = ['D0']
      for (let i = 1; i < 10; i++) {
        const signer = admins[pick(admins.length)]
        let target = devs[pick(devs.length)]
        if (target === signer) continue
        const kind = rnd() < 0.5 ? 'grant' : 'revoke'
        entries.push({ id: 'c' + entries.length, kind, signer, target, deps: ['c' + (entries.length - 1)] })
        admins = [...todayRule(entries).admins]
      }
      const a = sorted(todayRule(entries).admins)
      const b = sorted(effectiveSet(entries).admins)
      if (JSON.stringify(a) !== JSON.stringify(b)) diffs.push({ seed, today: a, eff: b })
    }
    expect(diffs.length).toBeLessThan(300)
    if (diffs.length) console.log('chain divergences', diffs.length, JSON.stringify(diffs[0]))
  })
})

// T353: a removed admin can author a BACKDATED revoke vote (deps on pre-removal heads). T331's stateAt
// counts it because the signer was a valid admin at the vote's own causal point.
const variant = (entries) => todayRule(entries, { filterVotes: true })
const vAdmins = (entries) => sorted(variant(entries).admins)

describe('T353 backdated votes by removed admins (todayRule demonstrates the bug)', () => {
  it('2 admins: A votes M out, M backdates a vote against A -> today leaves NO admins (mutual removal)', () => {
    const { h, last } = camp('M')
    h.revoke('vA', 'A', 'M', [last]).revoke('vM', 'M', 'A', [last])
    expect(today(h)).toEqual([])
    expect(sorted(todayRule([...h.entries].reverse()).admins)).toEqual([])
  })

  it('2 admins, A already acted after removing M: M still backdates and undoes A', () => {
    const { h, last } = camp('M')
    h.revoke('vA', 'A', 'M', [last]).revoke('vZ', 'A', 'Z', ['vA'])
    h.revoke('vM', 'M', 'A', [last]) // deps pre-date vA and vZ
    expect(today(h)).toEqual([])
  })

  it('4 admins: A,B remove M; M + D (backdated M vote) then remove B -> today lets the removed M decide', () => {
    const { h, last } = camp('B', 'M', 'D')
    h.revoke('v1', 'A', 'M', [last]).revoke('v2', 'B', 'M', [last])
    h.revoke('b1', 'M', 'B', ['gM']).revoke('b2', 'D', 'B', [last])
    expect(today(h)).toEqual(['A', 'D'])
  })

  it('without M\'s backdated vote the same history keeps B (the vote is what decides it)', () => {
    const { h, last } = camp('B', 'M', 'D')
    h.revoke('v1', 'A', 'M', [last]).revoke('v2', 'B', 'M', [last])
    h.revoke('b2', 'D', 'B', [last])
    expect(today(h)).toEqual(['A', 'B', 'D'])
  })
})

describe('T353 candidate: todayRule + vote filter (no grant-semantics change)', () => {
  it('5 admins: A,B,D remove M; M\'s backdated vote + E would remove B only after M is gone -> filtered, B survives', () => {
    const { h, last } = camp('B', 'M', 'D', 'E')
    h.revoke('v1', 'A', 'M', [last]).revoke('v2', 'B', 'M', [last]).revoke('v3', 'D', 'M', [last])
    h.revoke('b1', 'M', 'B', ['gM']).revoke('b2', 'E', 'B', [last])
    expect(today(h)).toEqual(['A', 'D', 'E'])
    expect(vAdmins(h.entries)).toEqual(['A', 'B', 'D', 'E'])
  })

  it('n=3 lone backdated vote: M (removed by A,B) plus nobody cannot remove A', () => {
    const { h, last } = camp('B', 'M')
    h.revoke('v1', 'A', 'M', [last]).revoke('v2', 'B', 'M', [last])
    h.revoke('vM', 'M', 'A', [last])
    expect(vAdmins(h.entries)).toEqual(['A', 'B'])
  })

  it('KNOWN LIMIT: truly symmetric 2-admin mutual votes deadlock (both stay) instead of both being removed', () => {
    const { h, last } = camp('M')
    h.revoke('vA', 'A', 'M', [last]).revoke('vM', 'M', 'A', [last])
    expect(vAdmins(h.entries)).toEqual(['A', 'M'])
  })

  it('KNOWN LIMIT: 4 admins split 2 v 2 (A,B vs M,D) is structurally symmetric: nobody is removed (today: attackers win)', () => {
    const { h, last } = camp('B', 'M', 'D')
    h.revoke('v1', 'A', 'M', [last]).revoke('v2', 'B', 'M', [last])
    h.revoke('b1', 'M', 'B', ['gM']).revoke('b2', 'D', 'B', [last])
    expect(vAdmins(h.entries)).toEqual(['A', 'B', 'D', 'M'])
  })

  const SEEDS = 500
  const seeds = [...Array.from({ length: SEEDS }, (_, i) => i + 1), 209]

  it('unique + order independent: array order and id labels never change the result (500 seeds + 209, 6 perms each)', () => {
    let checked = 0
    for (const seed of seeds) {
      const base = randomHistory(seed)
      const want = vAdmins(base)
      const rnd = mulberry32(seed * 104729)
      for (let k = 0; k < 6; k++) {
        const got = vAdmins(relabel(base, rnd))
        if (JSON.stringify(got) !== JSON.stringify(want)) throw new Error(`seed ${seed} perm ${k}: ${got} != ${want}`)
        checked++
      }
    }
    expect(checked).toBe(seeds.length * 6)
  })

  it('differential: where no removed admin authored a vote and no two devices voted on each other the result equals todayRule', () => {
    let same = 0
    let skipped = 0
    for (const seed of seeds) {
      const e = randomHistory(seed)
      const t = todayRule(e).admins
      const votes = e.filter((x) => x.kind === 'revoke' && x.signer !== x.target)
      const authorsRemoved = votes.some((x) => !t.has(x.signer))
      const mutual = votes.some((x) => votes.some((y) => y.signer === x.target && y.target === x.signer))
      if (authorsRemoved || mutual) {
        skipped++
        continue
      }
      expect(vAdmins(e), `seed ${seed}`).toEqual(sorted(t))
      same++
    }
    expect(same).toBeGreaterThan(50)
    console.log('T353 differential: equal on', same, 'seeds; skipped (removed vote author or mutual voting present)', skipped)
  })

  it('appended backdated votes: a device the variant removed never changes the outcome by voting on pre-removal heads', () => {
    let tried = 0
    let mutual = 0
    const moved = []
    for (const seed of seeds) {
      const e = randomHistory(seed)
      const admins = variant(e).admins
      const ever = new Set(e.filter((x) => x.kind !== 'revoke').map((x) => x.target))
      for (const d of ever) {
        if (admins.has(d)) continue
        const g = e.find((x) => x.kind !== 'revoke' && x.target === d)
        for (const t of admins) {
          // t having voted against d makes d <-> t mutual: structurally symmetric (KNOWN LIMIT above)
          if (e.some((x) => x.kind === 'revoke' && x.signer === t && x.target === d)) {
            mutual++
            continue
          }
          const extra = { id: 'bd', kind: 'revoke', signer: d, target: t, deps: [g.id] }
          tried++
          if (JSON.stringify(vAdmins([...e, extra])) !== JSON.stringify(sorted(admins))) moved.push(seed + ':' + d + '>' + t)
        }
      }
    }
    expect(tried).toBeGreaterThan(100)
    console.log('T353 appended-backdated tried', tried, 'skipped-mutual', mutual, 'moved', moved.length, moved.slice(0, 10).join(','))
    expect(moved).toEqual([])
  })
})

// T353 keeper ruling: NEVER zero admins; a 2-admin camp must be able to remove a compromised admin.
const attackHistories = () => {
  const out = []
  {
    const { h, last } = camp('B', 'M', 'T')
    h.revoke('vM1', 'A', 'M', [last]).revoke('vM2', 'B', 'M', [last])
    h.revoke('vT1', 'A', 'T', ['vM1', 'vM2']).revoke('vT2', 'B', 'T', ['vM1', 'vM2'])
    h.grant('gX', 'M', 'X', [last]).grant('gM2', 'X', 'M', ['gX', 'vM1', 'vM2', 'vT1', 'vT2'])
    h.grant('gT2', 'X', 'T', ['gX', 'vM1', 'vM2', 'vT1', 'vT2'])
    out.push(h.entries)
  }
  {
    const { h, last } = camp('B', 'M')
    h.revoke('v1', 'A', 'M', [last]).revoke('v2', 'B', 'M', [last])
    h.grant('gX', 'M', 'X', [last]).revoke('vX', 'X', 'B', ['gX']).revoke('vM', 'M', 'B', [last])
    out.push(h.entries)
  }
  {
    const { h, last } = camp('B', 'M')
    h.revoke('v1', 'A', 'M', [last]).revoke('v2', 'B', 'M', [last])
    h.grant('gX', 'M', 'X', [last]).revoke('vX', 'X', 'B', ['gX'])
    out.push(h.entries)
  }
  {
    const { h, last } = camp('B', 'M')
    h.revoke('v1', 'A', 'M', [last]).revoke('v2', 'B', 'M', [last])
    h.grant('gX', 'M', 'X', [last]).grant('gY', 'X', 'Y', ['gX'])
    h.revoke('vY', 'Y', 'B', ['gY']).revoke('vM', 'M', 'B', [last])
    out.push(h.entries)
  }
  {
    const { h, last } = camp('B', 'M')
    h.revoke('v1', 'A', 'M', [last]).revoke('v2', 'B', 'M', [last])
    h.grant('gX', 'M', 'X', [last]).grant('gM2', 'X', 'M', ['gX', 'v1', 'v2'])
    out.push(h.entries)
  }
  {
    const { h, last } = camp('B', 'M', 'D')
    h.revoke('v1', 'A', 'M', [last]).revoke('v2', 'B', 'M', [last])
    h.revoke('b1', 'M', 'B', ['gM']).revoke('b2', 'D', 'B', [last])
    out.push(h.entries)
  }
  return out
}

describe.each([['concurrent'], ['seniority']])('T353 keeper ruling variant: tieBreak=%s', (tieBreak) => {
  const rule = (e) => todayRule(e, { tieBreak })
  const ad = (e) => sorted(rule(e).admins)
  const seeds = [...Array.from({ length: 500 }, (_, i) => i + 1), 209]
  const report = {}
  const expectPass = tieBreak === 'seniority'
  const check = (name, failures) => {
    report[name] = failures.length
    console.log(`T353 ${tieBreak} ${name}: failures ${failures.length}`, failures.slice(0, 2).join(' ; '))
    if (expectPass) expect(failures).toEqual([])
  }

  it('unique + order independent (500 seeds + 209, 6 perms each)', () => {
    const bad = []
    let relabelDiffs = 0
    const check1 = (label, base, seed) => {
      const want = ad(base)
      const rnd = mulberry32(seed * 104729)
      for (let k = 0; k < 6; k++) {
        // seniority hashes entry ids (concurrent-grant tie), so ids are content: permute ARRAY ORDER only
        const perm = [...base].sort(() => rnd() - 0.5)
        const got = ad(perm)
        if (JSON.stringify(got) !== JSON.stringify(want)) bad.push(`${label} perm ${k}: ${got} != ${want}`)
        if (JSON.stringify(ad(relabel(base, rnd))) !== JSON.stringify(want)) relabelDiffs++
      }
    }
    for (const s of seeds) check1('seed ' + s, randomHistory(s), s)
    attackHistories().forEach((e, i) => check1('attack ' + i, e, 7000 + i))
    console.log(`T353 ${tieBreak} id-relabel outcome differences (hash tie-break on ids; informational): ${relabelDiffs}`)
    check('order-independence', bad)
  })

  it('never zero admins (500 seeds + 209 + attacks + appended backdated votes)', () => {
    const bad = []
    const all = [...seeds.map((s) => [`seed ${s}`, randomHistory(s)]), ...attackHistories().map((e, i) => [`attack ${i}`, e])]
    for (const [label, e] of all) {
      if (ad(e).length === 0) bad.push(label)
      const admins = rule(e).admins
      const ever = new Set(e.filter((x) => x.kind !== 'revoke').map((x) => x.target))
      for (const d of ever) {
        if (admins.has(d)) continue
        const g = e.find((x) => x.kind !== 'revoke' && x.target === d)
        for (const t of admins) {
          if (ad([...e, { id: 'bd', kind: 'revoke', signer: d, target: t, deps: [g.id] }]).length === 0) bad.push(`${label} bd ${d}>${t}`)
        }
      }
    }
    check('never-zero', bad)
  })

  it('2 admins: backdated counter-vote, post-revoke counter-vote, simultaneous mutual', () => {
    const { h, last } = camp('M')
    // F = A here is the founder and the revoker; M counters
    h.revoke('vA', 'A', 'M', [last]).revoke('vM', 'M', 'A', [last])
    const backdated = ad(h.entries)
    const h2 = camp('M')
    h2.h.revoke('vA', 'A', 'M', [h2.last]).revoke('vM', 'M', 'A', [h2.last, 'vA'])
    const after = ad(h2.h.entries)
    // genuine mutual: same DAG shape as the backdated case (each vote concurrent with the other)
    console.log(`T353 ${tieBreak} 2-admin: backdated=[${backdated}] after-revoke=[${after}] (mutual is the same DAG as backdated)`)
    // non-founder revoker: B (granted after A) revokes the founder A; A counters backdated
    const h3 = camp('B')
    h3.h.revoke('vB', 'B', 'A', [h3.last]).revoke('vA', 'A', 'B', [h3.last])
    const founderCounter = ad(h3.h.entries)
    console.log(`T353 ${tieBreak} 2-admin, junior revokes founder, founder counters: [${founderCounter}]`)
    expect(after).toEqual(['A'])
    if (expectPass) {
      expect(backdated).toEqual(['A'])
      expect(founderCounter).toEqual(['A'])
    }
  })

  it('k-v-k splits (2v2, 3v3 and 1v1 camps) never leave zero admins', () => {
    const bad = []
    for (const [k, members] of [[2, ['B', 'M', 'D']], [3, ['B', 'C', 'M', 'D', 'E']]]) {
      const { h, last } = camp(...members)
      const ids = ['A', ...members]
      const left = ids.slice(0, k)
      const right = ids.slice(k)
      left.forEach((s, i) => right.forEach((t, j) => h.revoke(`l${i}_${j}`, s, t, [last])))
      right.forEach((s, i) => left.forEach((t, j) => h.revoke(`r${i}_${j}`, s, t, [last])))
      const got = ad(h.entries)
      console.log(`T353 ${tieBreak} ${k}v${ids.length - k}: [${got}]`)
      if (got.length === 0) bad.push(`${k}v${ids.length - k}`)
    }
    check('k-v-k', bad)
  })

  it('differential vs todayRule on uncontested histories', () => {
    let same = 0
    const bad = []
    for (const seed of seeds) {
      const e = randomHistory(seed)
      const t = todayRule(e).admins
      const votes = e.filter((x) => x.kind === 'revoke' && x.signer !== x.target)
      if (votes.some((x) => !t.has(x.signer)) || votes.some((x) => votes.some((y) => y.signer === x.target && y.target === x.signer))) continue
      same++
      if (JSON.stringify(ad(e)) !== JSON.stringify(sorted(t))) bad.push('seed ' + seed)
    }
    console.log(`T353 ${tieBreak} differential: compared ${same} uncontested seeds`)
    check('differential', bad)
  })
})

describe('T353 Part A: seniority from CURRENT grants, partial order, tie-break hash', () => {
  const seeds = [...Array.from({ length: 500 }, (_, i) => i + 1), 209]

  it('standoff removes only those the winner voted against: B, whom A never voted on, stays', () => {
    const { h, last } = camp('B', 'M', 'D')
    // 2v2: A,B vote M,D; M,D vote A,B. Everyone is in the standoff; the founder wins.
    ;[['A', 'M'], ['A', 'D'], ['B', 'M'], ['B', 'D'], ['M', 'A'], ['M', 'B'], ['D', 'A'], ['D', 'B']].forEach(([s, t], i) => h.revoke('x' + i, s, t, [last]))
    const got = sorted(todayRule(h.entries, { tieBreak: 'seniority' }).admins)
    console.log('T353 A.1 2v2 standoff:', got)
    expect(got).toEqual(['A', 'B'])
  })

  it('current grant, not an older one: a removed-and-re-granted device is junior to one granted in between', () => {
    // A founder; A grants B, M; B,A remove M... use: C granted early, removed, re-granted late; D granted mid.
    const h = history().genesis('g0', 'A')
    h.grant('gC1', 'A', 'C', ['g0']).grant('gD', 'A', 'D', ['gC1'])
    h.revoke('r1', 'A', 'C', ['gD']).revoke('r2', 'D', 'C', ['gD'])
    h.grant('gC2', 'A', 'C', ['r1', 'r2'])
    const ix = indexHistory(h.entries)
    const cur = (d) => currentGrants(ix, h.entries.filter((e) => e.kind === 'grant' && e.target === d).map((e) => e.id))
    expect(cur('C')).toEqual(['gC2'])
    const { earlier } = seniority(ix, cur)
    expect(earlier('D', 'C')).toBe(true)
    expect(earlier('C', 'D')).toBe(false)
  })

  it('earlier() is a strict partial order (irreflexive, asymmetric, transitive) over random histories', () => {
    let triples = 0
    const bad = []
    for (const seed of seeds) {
      const e = randomHistory(seed)
      const ix = indexHistory(e)
      const devs = [...new Set(e.filter((x) => x.kind !== 'revoke').map((x) => x.target))]
      const cur = (d) => currentGrants(ix, e.filter((x) => x.kind !== 'revoke' && x.target === d).map((x) => x.id))
      const { earlier } = seniority(ix, cur)
      for (const a of devs) {
        if (earlier(a, a)) bad.push(`${seed} irreflexive ${a}`)
        for (const b of devs) {
          if (earlier(a, b) && earlier(b, a)) bad.push(`${seed} asym ${a} ${b}`)
          for (const c of devs) {
            if (earlier(a, b) && earlier(b, c)) {
              triples++
              if (!earlier(a, c)) bad.push(`${seed} trans ${a}<${b}<${c}`)
            }
          }
        }
      }
    }
    console.log(`T353 A.3 partial-order: ${triples} transitive triples checked, ${bad.length} failures`, bad.slice(0, 3).join(';'))
    expect(bad).toEqual([])
  })

  it('senior pick is order-independent over random device subsets (orders of devices and of entries)', () => {
    let picks = 0
    let ties = 0
    const bad = []
    for (const seed of seeds) {
      const e = randomHistory(seed)
      const rnd = mulberry32(seed * 31)
      const devs = [...new Set(e.filter((x) => x.kind !== 'revoke').map((x) => x.target))]
      for (let k = 0; k < 4 && devs.length > 1; k++) {
        const subset = devs.filter(() => rnd() < 0.7)
        if (subset.length < 2) continue
        const results = new Set()
        for (let p = 0; p < 6; p++) {
          const ent = [...e].sort(() => rnd() - 0.5)
          const ix = indexHistory(ent)
          const cur = (d) => currentGrants(ix, ent.filter((x) => x.kind !== 'revoke' && x.target === d).map((x) => x.id))
          const stats = {}
          results.add(seniority(ix, cur).pick([...subset].sort(() => rnd() - 0.5), 'camp', stats))
          if (stats.hashTies && p === 0) ties++
        }
        picks++
        if (results.size !== 1) bad.push(`seed ${seed} subset ${subset}: ${[...results]}`)
      }
    }
    console.log(`T353 A.3 senior-pick: ${picks} subsets x6 orders, ${ties} used the hash tie-break, ${bad.length} failures`, bad.slice(0, 3).join(';'))
    expect(bad).toEqual([])
  })

  it('concurrent grants: tie-break depends on (grant ids + camp id), not device ids', () => {
    const h = history().genesis('g0', 'A').grant('gB', 'A', 'B', ['g0']).grant('gC', 'A', 'C', ['g0'])
    const ix = indexHistory(h.entries)
    const cur = (d) => currentGrants(ix, h.entries.filter((e) => e.kind === 'grant' && e.target === d).map((e) => e.id))
    const { pick } = seniority(ix, cur)
    const stats = {}
    const w1 = pick(['B', 'C'], 'camp-1', stats)
    const w2 = pick(['C', 'B'], 'camp-1', stats)
    expect(w1).toBe(w2)
    expect(stats.hashTies).toBe(2)
    const seen = new Set(Array.from({ length: 30 }, (_, i) => pick(['B', 'C'], 'camp-' + i)))
    expect(seen.size).toBe(2)
  })

  it('seniority tie-break stats over random corpus', () => {
    const stats = {}
    for (const s of seeds) todayRule(randomHistory(s), { tieBreak: 'seniority', stats })
    console.log('T353 A random corpus hash tie-breaks used:', stats.hashTies || 0)
  })
})

// ---------------------------------------------------------------------------------------------
// T354 Part B: sock-puppet grants
// ---------------------------------------------------------------------------------------------
describe.each([['plain', {}], ['seniority', { tieBreak: 'seniority' }]])('T354 sock-puppet candidate (%s)', (_n, base) => {
  const seeds = [...Array.from({ length: 500 }, (_, i) => i + 1), 209]
  const withSock = (e) => todayRule(e, { ...base, sockFilter: true })
  const sad = (e) => sorted(withSock(e).admins)

  // 4-admin camp A,B,M then S: A founder grants B, M; M grants S AFTER A's revoke vote against M.
  const probe = (sockBeforeVote) => {
    const { h, last } = camp('B', 'M')
    if (sockBeforeVote) {
      h.grant('gS', 'M', 'S', [last])
      h.revoke('vA', 'A', 'M', ['gS'])
      h.revoke('bM', 'M', 'B', ['gS']).revoke('bS', 'S', 'B', ['gS'])
    } else {
      h.revoke('vA', 'A', 'M', [last])
      h.grant('gS', 'M', 'S', ['vA'])
      h.revoke('bM', 'M', 'B', ['gS']).revoke('bS', 'S', 'B', ['gS'])
    }
    h.revoke('aM2', 'A', 'M', ['bM', 'bS']).revoke('aS', 'A', 'S', ['bM', 'bS'])
    return h.entries
  }

  it('probe: M grants S after A voted against M; M+S revoke B -> honest B survives (no filter: B removed)', () => {
    const e = probe(false)
    const without = sorted(todayRule(e, base).admins)
    const withF = sad(e)
    console.log(`T354 probe(${_n}) post-vote sock: without filter [${without}], with filter [${withF}]`)
    expect(without).not.toContain('B')
    expect(withF).toContain('B')
    expect(withF).toContain('A')
  })

  it('RESIDUAL: sock granted BEFORE any vote against M still defeats the filter', () => {
    const e = probe(true)
    const withF = sad(e)
    console.log(`T354 residual(${_n}) pre-vote sock: with filter [${withF}]`)
    expect(withF).not.toContain('B')
  })

  it('unique + order independent (500 seeds + 209, 6 perms each)', () => {
    let bad = 0
    for (const s of seeds) {
      const b = randomHistory(s)
      const want = JSON.stringify(sad(b))
      const rnd = mulberry32(s * 7)
      for (let k = 0; k < 6; k++) if (JSON.stringify(sad([...b].sort(() => rnd() - 0.5))) !== want) bad++
    }
    console.log(`T354 order-independence(${_n}): ${bad} failures over ${seeds.length * 6} runs`)
    expect(bad).toBe(0)
  })

  it('never zero admins (500 seeds + 209)', () => {
    const bad = seeds.filter((s) => sad(randomHistory(s)).length === 0)
    const baseline = seeds.filter((s) => sorted(todayRule(randomHistory(s), base).admins).length === 0)
    console.log(`T354 never-zero(${_n}): ${bad.length} failures (same rule without sockFilter: ${baseline.length})`, bad.slice(0, 5))
    expect(bad.filter((s) => !baseline.includes(s))).toEqual([])
    if (base.tieBreak) expect(bad).toEqual([])
  })

  it('differential: equal to the unfiltered rule on histories with no grant after a vote against its signer', () => {
    let same = 0
    let diff = 0
    let skipped = 0
    const bad = []
    for (const s of seeds) {
      const e = randomHistory(s)
      const ix = indexHistory(e)
      const tainted = e.some(
        (g) =>
          g.kind === 'grant' &&
          [...ix.anc(g.id)].some((v) => ix.byId.get(v).kind === 'revoke' && ix.byId.get(v).target === g.signer)
      )
      if (tainted) {
        skipped++
        continue
      }
      same++
      if (JSON.stringify(sad(e)) !== JSON.stringify(sorted(todayRule(e, base).admins))) bad.push(s)
    }
    for (const s of seeds) if (JSON.stringify(sad(randomHistory(s))) !== JSON.stringify(sorted(todayRule(randomHistory(s), base).admins))) diff++
    console.log(`T354 differential(${_n}): ${same} untainted seeds compared, ${bad.length} differ; ${skipped} tainted skipped; overall ${diff} seeds differ`)
    expect(bad).toEqual([])
  })
})
