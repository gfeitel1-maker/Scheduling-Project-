// T196 — the elective assignment engine.
//
// Built against ADR D14's rewritten premise: preferences are ranked GLOBALLY,
// so a camper takes a choice at most once across the week and occurrences are
// coupled. Owner rulings R3 (never unplaced — assign best available and flag)
// and R4 (fairness NOT modeled in this pass).
import { describe, it, expect } from 'vitest'
import { buildElectiveAssignments } from './buildElectiveAssignments.js'

// Two occurrences, three activities, capacity 1 each unless overridden.
const occ = (id) => ({ id })
const offering = (occurrence_id, labelKey, activity_id, capacity = 1) =>
  ({ occurrence_id, labelKey, activity_id, capacity })
const pref = (camper_id, labelKey, rank) => ({ camper_id, labelKey, rank })
// T247 linked-choice inputs, mirroring elective_choices / elective_choice_offerings.
const choice = (id, labelKey, is_linked = 0) => ({ id, labelKey, is_linked })
const member = (choice_id, occurrence_id, activity_id) => ({ choice_id, occurrence_id, activity_id })

describe('buildElectiveAssignments', () => {
  it('gives every camper their first choice when there is room', () => {
    const out = buildElectiveAssignments({
      campers: [{ id: 'c1' }, { id: 'c2' }],
      occurrences: [occ('o1')],
      offerings: [offering('o1', 'archery', 'a-arch'), offering('o1', 'gaga', 'a-gaga')],
      preferences: [pref('c1', 'archery', 1), pref('c2', 'gaga', 1)],
    })
    expect(out.assignments.map((a) => [a.camper_id, a.activity_id, a.preference_rank]))
      .toEqual([['c1', 'a-arch', 1], ['c2', 'a-gaga', 1]])
    expect(out.assignments.every((a) => a.flags.length === 0)).toBe(true)
  })

  // R3: never unplaced. A camper bumped off their #1 is still placed, and the
  // slot carries a flag so staff can see it was not a top pick.
  it('places a bumped camper in their next choice and flags it', () => {
    const out = buildElectiveAssignments({
      campers: [{ id: 'c1' }, { id: 'c2' }],
      occurrences: [occ('o1')],
      offerings: [offering('o1', 'archery', 'a-arch', 1), offering('o1', 'gaga', 'a-gaga', 1)],
      preferences: [
        pref('c1', 'archery', 1), pref('c1', 'gaga', 2),
        pref('c2', 'archery', 1), pref('c2', 'gaga', 2),
      ],
    })
    const ranks = out.assignments.map((a) => a.preference_rank).sort()
    expect(ranks).toEqual([1, 2])
    const bumped = out.assignments.find((a) => a.preference_rank === 2)
    expect(bumped.flags).toContain('NOT_TOP_CHOICE')
  })

  // Owner ruling 2026-09-18: repeats ARE normal — a camper swims twice a week.
  // An earlier build forbade them, inferring "the preference is consumed" from
  // D14 to mean "the camper may never attend again". Those are different rules,
  // and collapsing them left 332 of 2550 camper-slots unfillable on a
  // 100-camper fixture, because with 4 offerings per period a camper ran out of
  // choices they had not already used. This test replaces the one that asserted
  // the opposite; the old behaviour is in git history, not silently dropped.
  it('allows a camper the same choice in more than one period', () => {
    const out = buildElectiveAssignments({
      campers: [{ id: 'c1' }],
      occurrences: [occ('o1'), occ('o2')],
      offerings: [offering('o1', 'archery', 'a-arch'), offering('o2', 'archery', 'a-arch')],
      preferences: [pref('c1', 'archery', 1)],
    })
    expect(out.assignments).toHaveLength(2)
    expect(out.assignments.every((a) => a.activity_id === 'a-arch')).toBe(true)
    expect(out.assignments.every((a) => a.preference_rank === 1)).toBe(true)
    expect(out.findings).toEqual([])
  })

  // R3 again, at its hardest: nothing the camper ranked is left.
  it('places a camper into something they never asked for rather than leaving them out', () => {
    const out = buildElectiveAssignments({
      campers: [{ id: 'c1' }],
      occurrences: [occ('o1'), occ('o2')],
      offerings: [
        offering('o1', 'archery', 'a-arch'), offering('o2', 'woodworking', 'a-wood'),
      ],
      preferences: [pref('c1', 'archery', 1)],
    })
    expect(out.assignments).toHaveLength(2)
    const unranked = out.assignments.find((a) => a.labelKey === 'woodworking')
    expect(unranked.preference_rank).toBeNull()
    expect(unranked.flags).toContain('NOT_REQUESTED')
  })

  it('leaves a camper unplaced only when no offering has room, and says so', () => {
    const out = buildElectiveAssignments({
      campers: [{ id: 'c1' }, { id: 'c2' }],
      occurrences: [occ('o1')],
      offerings: [offering('o1', 'archery', 'a-arch', 1)],
      preferences: [pref('c1', 'archery', 1), pref('c2', 'archery', 1)],
    })
    expect(out.assignments).toHaveLength(1)
    expect(out.findings).toContainEqual(
      expect.objectContaining({ kind: 'NO_CAPACITY', occurrence_id: 'o1', camper_ids: ['c2'] })
    )
  })

  // THE test that distinguishes a real min-cost assignment from greedy-by-rank.
  //
  // Greedy sorted by (rank, camper) assigns c1->archery (its only #1), which
  // leaves c2 — whose only options are archery(1) and gaga(3) — on gaga, for a
  // total of 1+3 = 4. The optimal assignment gives archery to c2 and gaga to
  // c1, total 2+1 = 3. A greedy implementation passes every other test here
  // and fails this one.
  it('finds the lower-total-cost assignment that greedy-by-rank misses', () => {
    const out = buildElectiveAssignments({
      campers: [{ id: 'c1' }, { id: 'c2' }],
      occurrences: [occ('o1')],
      offerings: [offering('o1', 'archery', 'a-arch', 1), offering('o1', 'gaga', 'a-gaga', 1)],
      preferences: [
        pref('c1', 'archery', 1), pref('c1', 'gaga', 2),
        pref('c2', 'archery', 1), pref('c2', 'gaga', 3),
      ],
    })
    const total = out.assignments.reduce((s, a) => s + a.preference_rank, 0)
    expect(total).toBe(3)
    expect(out.assignments.find((a) => a.camper_id === 'c2').activity_id).toBe('a-arch')
  })

  // Determinism is the property buildSchedule is held to, for the same reason:
  // a director regenerating must not get a different week.
  it('is deterministic regardless of input array order', () => {
    const inputs = {
      campers: [{ id: 'c1' }, { id: 'c2' }, { id: 'c3' }],
      occurrences: [occ('o1'), occ('o2')],
      offerings: [
        offering('o1', 'archery', 'a-arch', 2), offering('o1', 'gaga', 'a-gaga', 2),
        offering('o2', 'archery', 'a-arch', 2), offering('o2', 'gaga', 'a-gaga', 2),
      ],
      preferences: [
        pref('c1', 'archery', 1), pref('c1', 'gaga', 2),
        pref('c2', 'archery', 1), pref('c2', 'gaga', 2),
        pref('c3', 'gaga', 1), pref('c3', 'archery', 2),
      ],
    }
    const shuffled = {
      ...inputs,
      campers: [...inputs.campers].reverse(),
      offerings: [...inputs.offerings].reverse(),
      preferences: [...inputs.preferences].reverse(),
    }
    const key = (o) => o.assignments.map((a) => `${a.occurrence_id}:${a.camper_id}:${a.activity_id}`).sort().join('|')
    expect(key(buildElectiveAssignments(inputs))).toBe(key(buildElectiveAssignments(shuffled)))
  })

  // T231 — an occurrence nobody can attend, or with nothing on offer, used to
  // `continue` with no finding at all. Found by a real-data probe against a
  // camp database: a malformed attendance map made every camper ineligible and
  // the engine returned `{assignments: [], findings: []}` — a clean, empty,
  // successful-looking result. Silence is the wrong answer here: a director
  // whose division names do not match their tier names gets an empty schedule
  // and no reason for it.
  it('reports an occurrence nobody is eligible for, instead of skipping it silently', () => {
    const out = buildElectiveAssignments({
      campers: [{ id: 'c1' }],
      occurrences: [occ('o1')],
      offerings: [offering('o1', 'archery', 'a-arch')],
      preferences: [pref('c1', 'archery', 1)],
      attendance: {}, // nobody attends anything — the shape a wrapper-passing caller produces
    })
    expect(out.assignments).toEqual([])
    expect(out.findings).toContainEqual(
      expect.objectContaining({ kind: 'NO_CAMPERS', occurrence_id: 'o1' })
    )
  })

  it('reports an occurrence with no offerings, instead of skipping it silently', () => {
    const out = buildElectiveAssignments({
      campers: [{ id: 'c1' }],
      occurrences: [occ('o1'), occ('o2')],
      offerings: [offering('o1', 'archery', 'a-arch')],
      preferences: [pref('c1', 'archery', 1)],
    })
    expect(out.findings).toContainEqual(
      expect.objectContaining({ kind: 'NO_OFFERINGS', occurrence_id: 'o2' })
    )
  })

  // ---- T246: locked seats survive regeneration and pre-consume capacity.
  //
  // `lockedAssignments` is camelCase while the rest of the engine's inputs are
  // snake_case; that is the ticket's chosen shape (T246 Scope), pinned here so
  // nobody "normalizes" it away.
  const locked = (camperId, occurrenceId, activityId) => ({ camperId, occurrenceId, activityId })

  it('never re-decides a locked seat, whatever the preferences and offering order say', () => {
    const solve = (preferences, offerings) =>
      buildElectiveAssignments({
        campers: [{ id: 'c1' }],
        occurrences: [occ('o1')],
        offerings,
        preferences,
        lockedAssignments: [locked('c1', 'o1', 'a-arch')],
      })
    const a = solve(
      [pref('c1', 'gaga', 1), pref('c1', 'archery', 2)],
      [offering('o1', 'archery', 'a-arch'), offering('o1', 'gaga', 'a-gaga')]
    )
    const b = solve(
      [pref('c1', 'gaga', 1)],
      [offering('o1', 'gaga', 'a-gaga'), offering('o1', 'archery', 'a-arch')]
    )
    expect(a.assignments.map((x) => [x.camper_id, x.activity_id, x.source, x.locked]))
      .toEqual([['c1', 'a-arch', 'manual', true]])
    // Compared on the decision, not on preference_rank — the two solves were
    // handed different preference inputs, which is the point.
    expect(b.assignments.map((x) => [x.camper_id, x.activity_id, x.source, x.locked]))
      .toEqual([['c1', 'a-arch', 'manual', true]])
  })

  it('makes a locked seat\u2019s capacity unavailable to another camper in the same solve', () => {
    const out = buildElectiveAssignments({
      campers: [{ id: 'c1' }, { id: 'c2' }, { id: 'c3' }],
      occurrences: [occ('o1')],
      // Archery holds 2. c1's locked seat takes one, so only ONE of c2/c3 can
      // have it — without the subtraction all three would be seated there.
      offerings: [offering('o1', 'archery', 'a-arch', 2), offering('o1', 'gaga', 'a-gaga', 5)],
      preferences: [
        pref('c2', 'archery', 1), pref('c2', 'gaga', 2),
        pref('c3', 'archery', 1), pref('c3', 'gaga', 2),
      ],
      lockedAssignments: [locked('c1', 'o1', 'a-arch')],
    })
    expect(out.assignments.filter((a) => a.activity_id === 'a-arch').length).toBe(2)
    // And the locked camper is one of them, never re-decided into Gaga.
    expect(out.assignments.find((a) => a.camper_id === 'c1').activity_id).toBe('a-arch')
  })

  // The locked-seat / linked-choice contract this ticket owns (T246 Scope).
  // T247's tier-1 bipartite solve must consume this function's
  // lockedAssignments-ADJUSTED remaining capacity, where a linked choice's
  // capacity is min() over its member occurrences. Expressed here as the
  // engine-level property that contract rests on, on observable output: a
  // locked seat in ONE member occurrence lowers that member's remaining
  // capacity, hence the min() across a two-member linked choice, hence what
  // tier 1 could place into the choice as a whole.
  it('reduces a two-member linked choice\u2019s min() capacity by a locked seat in one member', () => {
    // o1 and o2 are the two member occurrences of a linked choice; each offers
    // Archery at capacity 2, so min() over the members is 2 before any lock.
    // c1 prefers Gaga, so the ONLY thing c1's lock changes is o1's Archery
    // capacity — not who wanted what.
    const input = {
      campers: [{ id: 'c1' }, { id: 'c2' }, { id: 'c3' }],
      occurrences: [occ('o1'), occ('o2')],
      offerings: [
        offering('o1', 'archery', 'a-arch', 2), offering('o1', 'gaga', 'a-gaga', 5),
        offering('o2', 'archery', 'a-arch', 2), offering('o2', 'gaga', 'a-gaga', 5),
      ],
      preferences: [
        pref('c1', 'gaga', 1),
        pref('c2', 'archery', 1), pref('c2', 'gaga', 2),
        pref('c3', 'archery', 1), pref('c3', 'gaga', 2),
      ],
    }
    const freeCampersInBothMembers = (out) =>
      ['c2', 'c3'].filter((id) =>
        out.assignments.filter((a) => a.camper_id === id && a.activity_id === 'a-arch').length === 2
      )

    // Unlocked: min() is 2, and two free campers hold Archery in both members.
    expect(freeCampersInBothMembers(buildElectiveAssignments(input))).toEqual(['c2', 'c3'])

    // One locked seat in o1 only. o1's Archery remaining drops to 1 while o2's
    // stays 2, so min() across the linked choice is 1 — exactly one free camper
    // can hold Archery in BOTH members, which is what a tier-1 linked-choice
    // solve reading this adjusted capacity would be able to place.
    const after = buildElectiveAssignments({
      ...input,
      lockedAssignments: [locked('c1', 'o1', 'a-arch')],
    })
    expect(freeCampersInBothMembers(after).length).toBe(1)
    // The locked seat still occupies o1's Archery: 1 locked + 1 free = 2.
    expect(after.assignments.filter((a) => a.occurrence_id === 'o1' && a.activity_id === 'a-arch').length).toBe(2)
  })

  it('produces identical output however lockedAssignments is ordered', () => {
    const base = {
      campers: [{ id: 'c1' }, { id: 'c2' }, { id: 'c3' }],
      occurrences: [occ('o1'), occ('o2')],
      offerings: [
        offering('o1', 'archery', 'a-arch', 2), offering('o1', 'gaga', 'a-gaga', 2),
        offering('o2', 'archery', 'a-arch', 2), offering('o2', 'gaga', 'a-gaga', 2),
      ],
      preferences: [pref('c1', 'archery', 1), pref('c2', 'gaga', 1), pref('c3', 'archery', 1)],
    }
    const set = [
      locked('c2', 'o1', 'a-arch'),
      locked('c1', 'o2', 'a-gaga'),
      locked('c3', 'o1', 'a-gaga'),
    ]
    const first = buildElectiveAssignments({ ...base, lockedAssignments: set })
    expect(first.assignments.filter((a) => a.locked).length).toBe(3)
    const shuffled = buildElectiveAssignments({ ...base, lockedAssignments: [set[2], set[0], set[1]] })
    const reversed = buildElectiveAssignments({ ...base, lockedAssignments: [...set].reverse() })
    expect(shuffled).toEqual(first)
    expect(reversed).toEqual(first)
  })

  it('ignores a locked row naming an unknown occurrence or a non-offered activity', () => {
    const out = buildElectiveAssignments({
      campers: [{ id: 'c1' }],
      occurrences: [occ('o1')],
      offerings: [offering('o1', 'archery', 'a-arch', 1)],
      preferences: [pref('c1', 'archery', 1)],
      lockedAssignments: [locked('c9', 'o-gone', 'a-arch')],
    })
    expect(out.assignments.map((a) => [a.camper_id, a.activity_id])).toEqual([['c1', 'a-arch']])
  })

  // Both early-exit guards below `continue`, so a locked seat is only emitted
  // if the emission runs ABOVE them. These two pin that, and the second is a
  // regression guard for T231's NO_CAMPERS diagnostic, which must keep firing
  // on a malformed attendance map even when one locked seat exists.
  it('emits a locked seat in an occurrence with no offerings, and still reports NO_OFFERINGS', () => {
    const out = buildElectiveAssignments({
      campers: [{ id: 'c1' }],
      occurrences: [occ('o1')],
      offerings: [],
      preferences: [pref('c1', 'archery', 1)],
      lockedAssignments: [locked('c1', 'o1', 'a-arch')],
    })
    expect(out.assignments.map((a) => [a.camper_id, a.activity_id, a.source, a.locked]))
      .toEqual([['c1', 'a-arch', 'manual', true]])
    expect(out.findings).toContainEqual(
      expect.objectContaining({ kind: 'NO_OFFERINGS', occurrence_id: 'o1' })
    )
  })

  it('still reports NO_CAMPERS when every camper is ineligible but one seat is locked', () => {
    const out = buildElectiveAssignments({
      campers: [{ id: 'c1' }, { id: 'c2' }],
      occurrences: [occ('o1')],
      offerings: [offering('o1', 'archery', 'a-arch')],
      preferences: [pref('c1', 'archery', 1)],
      attendance: {}, // malformed map — nobody is eligible for anything
      lockedAssignments: [locked('c1', 'o1', 'a-arch')],
    })
    expect(out.findings).toContainEqual(
      expect.objectContaining({ kind: 'NO_CAMPERS', occurrence_id: 'o1' })
    )
    expect(out.assignments.map((a) => [a.camper_id, a.activity_id, a.locked]))
      .toEqual([['c1', 'a-arch', true]])
  })

  it('behaves exactly as before when lockedAssignments is omitted', () => {
    const out = buildElectiveAssignments({
      campers: [{ id: 'c1' }, { id: 'c2' }],
      occurrences: [occ('o1')],
      offerings: [offering('o1', 'archery', 'a-arch'), offering('o1', 'gaga', 'a-gaga')],
      preferences: [pref('c1', 'archery', 1), pref('c2', 'gaga', 1)],
    })
    expect(out.assignments.map((a) => [a.camper_id, a.activity_id, a.preference_rank]))
      .toEqual([['c1', 'a-arch', 1], ['c2', 'a-gaga', 1]])
    expect(out.assignments.some((a) => a.locked)).toBe(false)
  })

  // The empty-input case must stay quiet — no occurrences means no work, not a
  // problem to report. Without this the fix would make every empty preview
  // shout.
  it('returns empty rather than throwing on empty input', () => {
    const out = buildElectiveAssignments({ campers: [], occurrences: [], offerings: [], preferences: [] })
    expect(out.assignments).toEqual([])
    expect(out.findings).toEqual([])
  })

  // ---- T247: linked choices via the tier-1 choice-level bipartite pass.
  //
  // A choice is LINKED for tier-1 purposes when `choiceOfferings` gives it more
  // than one member occurrence — the member count, not the `is_linked` column
  // (which nothing writes as 1 today). Tier 1 places a camper into the choice as
  // a whole; tier 2 then runs per occurrence against the reduced capacity.

  // THE ADR's WORKED EXAMPLE, VERBATIM (2026-09-23 decision (c)).
  //
  // capacity(o1) = capacity(o2) = 15, choice C = {o1, o2}, two campers both
  // ranking C. The rejected chain construction placed ONE camper camp-wide and
  // reported the second NO_CAPACITY with 14 seats open at each occurrence. Tier
  // 1 is an ordinary bipartite match with capacity[C] = min(15, 15) = 15, so it
  // places both, and each occurrence must show 13 seats left afterwards.
  //
  // The 13 is asserted OBSERVABLY, not by reading an internal: 20 further
  // campers who ranked NOTHING are in the run, archery is the only offering, so
  // R3 seats as many of them as capacity allows — exactly 13 per occurrence,
  // with 7 reported unplaced. The fillers deliberately have no preference: any
  // camper who ranks archery necessarily ranks the linked CHOICE (the choice is
  // what the label resolves to), so a ranked filler would be a tier-1 row and
  // could not stand in for tier-2 demand.
  //
  // NOT a tier-1 discriminator, and it is not claimed as one: with one offering
  // per period these counts are the same whether tier 1 runs or not. It is the
  // ADR's correctness claim, pinned. The test below it ('keeps a linked choice
  // whole …') is the one that fails without tier 1.
  it('places both campers of the ADR worked example and leaves 13 seats in each member', () => {
    const fillers = Array.from({ length: 20 }, (_, i) => `f${String(i).padStart(2, '0')}`)
    const out = buildElectiveAssignments({
      campers: [{ id: 'alice' }, { id: 'bob' }, ...fillers.map((id) => ({ id }))],
      occurrences: [occ('o1'), occ('o2')],
      offerings: [offering('o1', 'archery', 'a-arch', 15), offering('o2', 'archery', 'a-arch', 15)],
      preferences: [pref('alice', 'archery', 5), pref('bob', 'archery', 5)],
      choices: [choice('C', 'archery')],
      choiceOfferings: [member('C', 'o1', 'a-arch'), member('C', 'o2', 'a-arch')],
    })

    // Atomic expansion: each linked camper holds the choice in BOTH members.
    for (const id of ['alice', 'bob']) {
      expect(out.assignments.filter((a) => a.camper_id === id).map((a) => a.occurrence_id))
        .toEqual(['o1', 'o2'])
      expect(out.assignments.filter((a) => a.camper_id === id).every((a) => a.activity_id === 'a-arch'))
        .toBe(true)
    }
    // 2 linked + 13 filler = 15, the real capacity, in each member.
    for (const occurrenceId of ['o1', 'o2']) {
      expect(out.assignments.filter((a) => a.occurrence_id === occurrenceId).length).toBe(15)
      const noCapacity = out.findings.find(
        (f) => f.kind === 'NO_CAPACITY' && f.occurrence_id === occurrenceId
      )
      expect(noCapacity.camper_ids.length).toBe(7)
    }
  })

  // THE test that distinguishes tier 1 from tier 2 alone — the atomicity
  // property, on a shape where independent per-occurrence solving provably
  // SPLITS the linked set between two campers.
  //
  // Global ranks mean two occurrences offering the same menu always seat the
  // same camper, so a split needs the menus to differ: o1 offers archery+gaga,
  // o2 offers archery+woodworking, all capacity 1. A ranks gaga above
  // woodworking; B ranks woodworking above gaga. Tier 2 on its own minimises
  // each period separately and hands o1's archery to B (1+3 beats 2+1... the
  // cheaper pairing is A→gaga, B→archery) and o2's archery to A — neither
  // camper ends up holding the linked set. Tier 1 solves the choice first
  // (capacity min(1,1) = 1), gives the whole set to one camper, and leaves the
  // other to tier 2.
  it('keeps a linked choice whole where per-occurrence solving would split it', () => {
    const base = {
      campers: [{ id: 'a' }, { id: 'b' }],
      occurrences: [occ('o1'), occ('o2')],
      offerings: [
        offering('o1', 'archery', 'a-arch', 1), offering('o1', 'gaga', 'a-gaga', 1),
        offering('o2', 'archery', 'a-arch', 1), offering('o2', 'woodworking', 'a-wood', 1),
      ],
      preferences: [
        pref('a', 'archery', 1), pref('a', 'gaga', 2), pref('a', 'woodworking', 3),
        pref('b', 'archery', 1), pref('b', 'woodworking', 2), pref('b', 'gaga', 3),
      ],
    }
    const archeryPeriods = (out, camperId) =>
      out.assignments.filter((x) => x.camper_id === camperId && x.activity_id === 'a-arch')
        .map((x) => x.occurrence_id)

    // Tier 2 alone splits the set: one period each, nobody holds both.
    const without = buildElectiveAssignments(base)
    expect(archeryPeriods(without, 'a')).toEqual(['o2'])
    expect(archeryPeriods(without, 'b')).toEqual(['o1'])

    // Tier 1 keeps it whole.
    const withTier1 = buildElectiveAssignments({
      ...base,
      choices: [choice('C', 'archery')],
      choiceOfferings: [member('C', 'o1', 'a-arch'), member('C', 'o2', 'a-arch')],
    })
    expect(archeryPeriods(withTier1, 'a')).toEqual(['o1', 'o2'])
    expect(archeryPeriods(withTier1, 'b')).toEqual([])
  })

  it('emits a tier-1 placement as ordinary solver output, not as a manual locked row', () => {
    const out = buildElectiveAssignments({
      campers: [{ id: 'c1' }],
      occurrences: [occ('o1'), occ('o2')],
      offerings: [offering('o1', 'archery', 'a-arch', 5), offering('o2', 'archery', 'a-arch', 5)],
      preferences: [pref('c1', 'archery', 2)],
      choices: [choice('C', 'archery')],
      choiceOfferings: [member('C', 'o1', 'a-arch'), member('C', 'o2', 'a-arch')],
    })
    expect(out.assignments).toHaveLength(2)
    for (const a of out.assignments) {
      expect(a.source).toBeUndefined()
      expect(a.locked).toBeUndefined()
      expect(a.labelKey).toBe('archery')
      expect(a.preference_rank).toBe(2)
      expect(a.flags).toEqual(['NOT_TOP_CHOICE'])
    }
  })

  it('resolves a preference that names choice_id instead of labelKey', () => {
    const out = buildElectiveAssignments({
      campers: [{ id: 'c1' }],
      occurrences: [occ('o1'), occ('o2')],
      offerings: [offering('o1', 'archery', 'a-arch', 5), offering('o2', 'archery', 'a-arch', 5)],
      preferences: [{ camper_id: 'c1', choice_id: 'C', rank: 1 }],
      choices: [choice('C', 'archery')],
      choiceOfferings: [member('C', 'o1', 'a-arch'), member('C', 'o2', 'a-arch')],
    })
    expect(out.assignments.map((a) => [a.occurrence_id, a.activity_id, a.preference_rank]))
      .toEqual([['o1', 'a-arch', 1], ['o2', 'a-arch', 1]])
  })

  // Clause 3 — a choice with exactly ONE member offering is not linked, so tier
  // 1 never sees it and the result must be identical to the same fixture run
  // with no choice inputs at all.
  it('leaves a single-member choice entirely to tier 2, byte-identical to no choice input', () => {
    const base = {
      campers: [{ id: 'c1' }, { id: 'c2' }, { id: 'c3' }],
      occurrences: [occ('o1'), occ('o2')],
      offerings: [
        offering('o1', 'archery', 'a-arch', 2), offering('o1', 'gaga', 'a-gaga', 2),
        offering('o2', 'archery', 'a-arch', 2), offering('o2', 'gaga', 'a-gaga', 2),
      ],
      preferences: [
        pref('c1', 'archery', 1), pref('c1', 'gaga', 2),
        pref('c2', 'archery', 1), pref('c2', 'gaga', 2),
        pref('c3', 'gaga', 1), pref('c3', 'archery', 2),
      ],
    }
    const withChoices = buildElectiveAssignments({
      ...base,
      choices: [choice('C-arch', 'archery'), choice('C-gaga', 'gaga')],
      choiceOfferings: [member('C-arch', 'o1', 'a-arch'), member('C-gaga', 'o2', 'a-gaga')],
    })
    expect(withChoices).toEqual(buildElectiveAssignments(base))
  })

  // UNSUPPORTED_LINKED_CHOICE case (a) — a member names an occurrence the run
  // does not contain. A data problem, and it reads as one.
  it('reports UNSUPPORTED_LINKED_CHOICE when a member names an occurrence outside the run', () => {
    const out = buildElectiveAssignments({
      campers: [{ id: 'c1' }],
      occurrences: [occ('o1')],
      offerings: [offering('o1', 'archery', 'a-arch', 5)],
      preferences: [pref('c1', 'archery', 1)],
      choices: [choice('C', 'archery')],
      choiceOfferings: [member('C', 'o1', 'a-arch'), member('C', 'o-gone', 'a-arch')],
    })
    expect(out.findings).toContainEqual(
      expect.objectContaining({ kind: 'UNSUPPORTED_LINKED_CHOICE', choice_ids: ['C'] })
    )
    // Refused from tier 1, not mis-solved: the camper is still placed by tier 2.
    expect(out.assignments.map((a) => [a.occurrence_id, a.activity_id])).toEqual([['o1', 'a-arch']])
  })

  // Case (b) — the camper does not attend every member occurrence.
  it('reports UNSUPPORTED_LINKED_CHOICE for a camper ineligible for a member occurrence', () => {
    const out = buildElectiveAssignments({
      campers: [{ id: 'c1' }, { id: 'c2' }],
      occurrences: [occ('o1'), occ('o2')],
      offerings: [offering('o1', 'archery', 'a-arch', 5), offering('o2', 'archery', 'a-arch', 5)],
      preferences: [pref('c1', 'archery', 1), pref('c2', 'archery', 1)],
      attendance: { c1: ['o1'], c2: ['o1', 'o2'] },
      choices: [choice('C', 'archery')],
      choiceOfferings: [member('C', 'o1', 'a-arch'), member('C', 'o2', 'a-arch')],
    })
    expect(out.findings).toContainEqual(
      expect.objectContaining({
        kind: 'UNSUPPORTED_LINKED_CHOICE', choice_ids: ['C'], camper_ids: ['c1'],
      })
    )
    // c1 falls through to tier 2 and is still placed where they do attend.
    expect(out.assignments.filter((a) => a.camper_id === 'c1').map((a) => a.occurrence_id))
      .toEqual(['o1'])
    // c2 is unaffected and still placed atomically across both members.
    expect(out.assignments.filter((a) => a.camper_id === 'c2').map((a) => a.occurrence_id))
      .toEqual(['o1', 'o2'])
  })

  // Case (c) — the NEW case. Two linked choices sharing a member occurrence is
  // an implementation limit of the two-tier construction, not bad data.
  it('refuses two linked choices that share a member occurrence, naming the limitation', () => {
    const out = buildElectiveAssignments({
      campers: [{ id: 'c1' }, { id: 'c2' }],
      occurrences: [occ('o1'), occ('o2'), occ('o3')],
      offerings: [
        offering('o1', 'archery', 'a-arch', 5),
        offering('o2', 'archery', 'a-arch', 5), offering('o2', 'gaga', 'a-gaga', 5),
        offering('o3', 'gaga', 'a-gaga', 5),
      ],
      preferences: [pref('c1', 'archery', 1), pref('c2', 'gaga', 1)],
      choices: [choice('C1', 'archery'), choice('C2', 'gaga')],
      choiceOfferings: [
        member('C1', 'o1', 'a-arch'), member('C1', 'o2', 'a-arch'),
        member('C2', 'o2', 'a-gaga'), member('C2', 'o3', 'a-gaga'),
      ],
    })
    const finding = out.findings.find((f) => f.kind === 'UNSUPPORTED_LINKED_CHOICE')
    expect(finding.choice_ids).toEqual(['C1', 'C2'])
    expect(finding.occurrence_id).toBe('o2')
    expect(finding.message).toMatch(/limit of the scheduler/)
    // Both choices are refused from tier 1, and their campers fall through to
    // tier 2 as ordinary per-occurrence rows — never a silently wrong placement.
    expect(out.assignments.every((a) => a.source === undefined)).toBe(true)
    expect(out.assignments.filter((a) => a.camper_id === 'c1').length).toBeGreaterThan(0)
  })

  // Ordinary capacity infeasibility is NOT this finding — it stays an ordinary
  // unassigned/NO_CAPACITY outcome, per the ADR's scope line.
  it('does not report UNSUPPORTED_LINKED_CHOICE when a linked choice is merely full', () => {
    const out = buildElectiveAssignments({
      campers: [{ id: 'c1' }, { id: 'c2' }],
      occurrences: [occ('o1'), occ('o2')],
      offerings: [offering('o1', 'archery', 'a-arch', 1), offering('o2', 'archery', 'a-arch', 1)],
      preferences: [pref('c1', 'archery', 1), pref('c2', 'archery', 1)],
      choices: [choice('C', 'archery')],
      choiceOfferings: [member('C', 'o1', 'a-arch'), member('C', 'o2', 'a-arch')],
    })
    expect(out.findings.some((f) => f.kind === 'UNSUPPORTED_LINKED_CHOICE')).toBe(false)
    // One camper held the choice atomically; the other competed per occurrence
    // in tier 2 and found no room, which is the ordinary outcome.
    expect(out.assignments).toHaveLength(2)
    expect(out.findings.filter((f) => f.kind === 'NO_CAPACITY').length).toBe(2)
  })

  // HIGH 2 (round-2 review), confirmed by execution before it was fixed: a
  // camper holding a T246 locked seat at o1 was still placed into a linked
  // choice whose member set includes o1, so the engine emitted TWO rows for
  // (camper, o1) — the locked one and a tier-1 one. That breaks constraint 1 in
  // this module's header, and at the persistence layer it is worse than a
  // duplicate: deriveElectiveAssignmentId excludes activity_id, so both rows
  // collide on one derived id and both are skipped, while the camper's OTHER
  // member row is written normally — half a linked choice, and a consumed seat,
  // with no finding at all.
  it('refuses a linked choice for a camper who already holds a locked seat in one of its periods', () => {
    const out = buildElectiveAssignments({
      campers: [{ id: 'x' }],
      occurrences: [occ('o1'), occ('o2')],
      offerings: [
        offering('o1', 'gaga', 'a-gaga', 5), offering('o1', 'archery', 'a-arch', 5),
        offering('o2', 'archery', 'a-arch', 5),
      ],
      preferences: [pref('x', 'archery', 1)],
      lockedAssignments: [locked('x', 'o1', 'a-gaga')],
      choices: [choice('C', 'archery')],
      choiceOfferings: [member('C', 'o1', 'a-arch'), member('C', 'o2', 'a-arch')],
    })
    expect(out.findings).toContainEqual(
      expect.objectContaining({
        kind: 'UNSUPPORTED_LINKED_CHOICE', choice_ids: ['C'], camper_ids: ['x'],
      })
    )
    expect(out.findings.find((f) => f.kind === 'UNSUPPORTED_LINKED_CHOICE').message)
      .toMatch(/by hand/)
    // The lock stands and wins; exactly one row per (camper, occurrence).
    expect(out.assignments.map((a) => [a.occurrence_id, a.activity_id, a.source ?? 'solver']))
      .toEqual([['o1', 'a-gaga', 'manual'], ['o2', 'a-arch', 'solver']])
  })

  // THE GENERAL INVARIANT, not a case test. Constraint 1 of this module's
  // header — each (camper, occurrence) gets exactly one activity — is what
  // protects deriveElectiveAssignmentId's (run, camper, occurrence) key. Its
  // absence is why HIGH 2 shipped, so it is asserted over a fixture that
  // combines locks, TWO linked choices and ordinary preferences at once.
  it('never emits two rows for one (camper, occurrence), across locks and two linked choices', () => {
    const out = buildElectiveAssignments({
      campers: [{ id: 'c1' }, { id: 'c2' }, { id: 'c3' }, { id: 'c4' }],
      occurrences: [occ('o1'), occ('o2'), occ('o3'), occ('o4')],
      offerings: [
        offering('o1', 'archery', 'a-arch', 2), offering('o1', 'craft', 'a-craft', 2),
        offering('o2', 'archery', 'a-arch', 2), offering('o2', 'craft', 'a-craft', 2),
        offering('o3', 'boating', 'a-boat', 2), offering('o3', 'craft', 'a-craft', 2),
        offering('o4', 'boating', 'a-boat', 2), offering('o4', 'craft', 'a-craft', 2),
      ],
      preferences: ['c1', 'c2', 'c3', 'c4'].flatMap((id) => [
        pref(id, 'archery', 1), pref(id, 'boating', 2), pref(id, 'craft', 3),
      ]),
      lockedAssignments: [
        locked('c1', 'o1', 'a-craft'),   // a member period, a DIFFERENT activity
        locked('c2', 'o3', 'a-boat'),    // a member period, the SAME activity
        locked('c3', 'o2', 'a-arch'),    // the other choice's member period
      ],
      // Two linked choices, deliberately sharing no occurrence so both survive
      // case (c) and both actually reach the tier-1 solve.
      choices: [choice('C-arch', 'archery'), choice('C-boat', 'boating')],
      choiceOfferings: [
        member('C-arch', 'o1', 'a-arch'), member('C-arch', 'o2', 'a-arch'),
        member('C-boat', 'o3', 'a-boat'), member('C-boat', 'o4', 'a-boat'),
      ],
    })
    const seen = new Set()
    const duplicates = []
    for (const a of out.assignments) {
      const key = `${a.camper_id}@${a.occurrence_id}`
      if (seen.has(key)) duplicates.push(key)
      seen.add(key)
    }
    expect(duplicates).toEqual([])
    // Non-vacuous: the fixture must actually exercise tier 1 and the locks.
    expect(out.assignments.filter((a) => a.locked).length).toBe(3)
    expect(out.assignments.length).toBeGreaterThan(3)
  })

  it('is deterministic regardless of the order of choices and choiceOfferings', () => {
    const base = {
      campers: [{ id: 'c1' }, { id: 'c2' }, { id: 'c3' }],
      occurrences: [occ('o1'), occ('o2'), occ('o3')],
      offerings: [
        offering('o1', 'archery', 'a-arch', 1), offering('o1', 'gaga', 'a-gaga', 2),
        offering('o2', 'archery', 'a-arch', 1), offering('o2', 'gaga', 'a-gaga', 2),
        offering('o3', 'archery', 'a-arch', 2), offering('o3', 'gaga', 'a-gaga', 2),
      ],
      preferences: [
        pref('c1', 'archery', 1), pref('c1', 'gaga', 2),
        pref('c2', 'archery', 1), pref('c2', 'gaga', 2),
        pref('c3', 'gaga', 1), pref('c3', 'archery', 2),
      ],
    }
    const choices = [choice('C-arch', 'archery'), choice('C-gaga', 'gaga')]
    const offeringsOfChoices = [
      member('C-arch', 'o1', 'a-arch'), member('C-arch', 'o2', 'a-arch'),
      member('C-gaga', 'o1', 'a-gaga'), member('C-gaga', 'o3', 'a-gaga'),
    ]
    const first = buildElectiveAssignments({ ...base, choices, choiceOfferings: offeringsOfChoices })
    expect(first.assignments.length).toBeGreaterThan(0)
    const reversed = buildElectiveAssignments({
      ...base,
      campers: [...base.campers].reverse(),
      preferences: [...base.preferences].reverse(),
      choices: [...choices].reverse(),
      choiceOfferings: [...offeringsOfChoices].reverse(),
    })
    expect(reversed).toEqual(first)
  })
})

// ---- T247 clause 7: the 100-camper fixture's REPORTED repeat distribution.
//
// Owner ruling Q3 (2026-09-23) scores repeats independently per occurrence and
// reserves the right to revisit AFTER SEEING REAL OUTPUT. This block exists to
// make that revisit trigger observable: the figure is PRINTED on every ordinary
// `vitest run`, not merely computable by hand from an assignment dump. If it is
// not reported, the ruling silently becomes permanent.
//
// Camper names are obviously synthetic (Camper 001, …) — owner ruling Q4, real
// camper data stays refused until at-rest encryption ships.
describe('buildElectiveAssignments — 100-camper repeat distribution (Q3 revisit trigger)', () => {
  const CAMPERS = 100
  const OCCURRENCES = 25
  const ACTIVITIES = 25
  const PER_OCCURRENCE = 4

  const labelOf = (i) => `act${String(i).padStart(2, '0')}`
  const activityOf = (i) => `a-${labelOf(i)}`
  // Two deliberately scarce activities, so the fixture also produces campers
  // who ranked something and received none of it — the other half of the Q3
  // figure. 104 seats per occurrence still seats all 100 campers.
  const capacityOf = (i) => (i < 2 ? 2 : 50)

  // Deterministic per-camper preference order — a fixed LCG, no Math.random,
  // so the printed figure is the same on every run and in CI.
  const permutation = (seed) => {
    const order = Array.from({ length: ACTIVITIES }, (_, i) => i)
    let s = seed
    for (let i = order.length - 1; i > 0; i--) {
      s = (s * 1103515245 + 12345) & 0x7fffffff
      const j = s % (i + 1)
      ;[order[i], order[j]] = [order[j], order[i]]
    }
    return order
  }

  const buildFixture = () => {
    const campers = Array.from({ length: CAMPERS }, (_, i) => ({
      id: `camper-${String(i + 1).padStart(3, '0')}`,
      display_name: `Camper ${String(i + 1).padStart(3, '0')}`,
    }))
    const occurrences = Array.from({ length: OCCURRENCES }, (_, i) => occ(`occ-${String(i).padStart(2, '0')}`))
    const offerings = []
    for (let o = 0; o < OCCURRENCES; o++) {
      for (let k = 0; k < PER_OCCURRENCE; k++) {
        const a = (o * PER_OCCURRENCE + k) % ACTIVITIES
        offerings.push(offering(occurrences[o].id, labelOf(a), activityOf(a), capacityOf(a)))
      }
    }
    const preferences = []
    campers.forEach((c, i) => {
      permutation(i + 1).forEach((a, rank) => preferences.push(pref(c.id, labelOf(a), rank + 1)))
    })
    const choices = Array.from({ length: ACTIVITIES }, (_, i) => choice(`choice-${labelOf(i)}`, labelOf(i)))
    // One multi-member linked choice: the first two occurrences that offer
    // act10, so tier 1 actually runs on this fixture.
    const linkedActivity = 10
    const linkedOccurrences = offerings
      .filter((o) => o.activity_id === activityOf(linkedActivity))
      .map((o) => o.occurrence_id)
      .sort()
      .slice(0, 2)
    expect(linkedOccurrences).toHaveLength(2)
    const choiceOfferings = linkedOccurrences.map((occurrenceId) =>
      ({ choice_id: `choice-${labelOf(linkedActivity)}`, occurrence_id: occurrenceId, activity_id: activityOf(linkedActivity) })
    )
    return { campers, occurrences, offerings, preferences, choices, choiceOfferings }
  }

  // Exists to satisfy the Q3 revisit trigger: the owner accepted per-occurrence
  // independent scoring on the condition that the real distribution be visible.
  //
  // THE CROSS-TAB IS KEYED ON THE CAMPER, not on an activity set. Round-2
  // review caught the first version keying on activities — it filtered the whole
  // fixture's shut-out list by "activities some camper anywhere reached k", sets
  // that overlap heavily across k, so the x2 row printed the entire overall
  // total and the column summed to 2.6x the truth. The ruling's words are "how
  // many ranked-but-unplaced campers that COINCIDED with", and a camper is the
  // thing that coincides: a row's shut-out figures are held by that row's own
  // campers and by nobody else.
  //
  // Rows OVERLAP by construction — one camper can hold one activity twice and
  // another four times, so they appear in two rows. That is disclosed in the
  // printed note rather than hidden behind a tidy partition that would lie.
  function summariseRepeats({ assignments, campers, preferences, offerings }) {
    const activityByLabel = new Map(offerings.map((o) => [o.labelKey, o.activity_id]))
    const counts = new Map() // `${camperId}\u0000${activityId}` -> occurrences held
    for (const a of assignments) {
      const key = `${a.camper_id}\u0000${a.activity_id}`
      counts.set(key, (counts.get(key) ?? 0) + 1)
    }
    const shutOut = [] // ranked the activity, received none of its occurrences
    for (const p of preferences) {
      const activityId = activityByLabel.get(p.labelKey)
      if (!activityId) continue
      if (!counts.has(`${p.camper_id}\u0000${activityId}`)) shutOut.push({ camper_id: p.camper_id, activity_id: activityId })
    }
    const levels = new Map()
    for (const [key, k] of counts) {
      if (k < 2) continue
      const [camperId] = key.split('\u0000')
      if (!levels.has(k)) levels.set(k, { pairs: 0, campers: new Set() })
      const bucket = levels.get(k)
      bucket.pairs += 1
      bucket.campers.add(camperId)
    }
    const rows = [...levels.keys()].sort((a, b) => a - b).map((k) => {
      const bucket = levels.get(k)
      const mine = shutOut.filter((s) => bucket.campers.has(s.camper_id))
      return {
        repeats: k,
        pairs: bucket.pairs,
        campers: bucket.campers.size,
        shutOutCampers: new Set(mine.map((s) => s.camper_id)).size,
        shutOutPairs: mine.length,
      }
    })
    return {
      rows,
      totalAssignments: assignments.length,
      totalCounted: [...counts.values()].reduce((s, k) => s + k, 0),
      totalShutOut: shutOut.length,
      campersShutOutAtLeastOnce: new Set(shutOut.map((s) => s.camper_id)).size,
      totalCampers: campers.length,
    }
  }

  it('reports the per-camper repeat distribution and the ranked-but-unplaced cross-tab', () => {
    const fixture = buildFixture()
    const startedAt = Date.now()
    const out = buildElectiveAssignments(fixture)
    const elapsedMs = Date.now() - startedAt
    const summary = summariseRepeats({ ...fixture, assignments: out.assignments })

    const lines = [
      '',
      'T247 / owner ruling Q3 — per-camper repeat distribution',
      `  fixture: ${summary.totalCampers} campers, ${OCCURRENCES} occurrences, ${PER_OCCURRENCE} offerings each, ${ACTIVITIES} rankable choices (1 linked, 2 members)`,
      `  solve wall-clock: ${elapsedMs}ms; ${summary.totalAssignments} assignments`,
      '',
      '  THE ROWS OVERLAP. One camper can hold one activity 2x and another 4x, so the same',
      '  camper is counted in more than one row. The rows are not a partition of the campers',
      '  and the columns do not sum to the overall totals printed underneath them.',
      '',
      '  repeats | pairs | campers | shutOutCampers | shutOutPairs',
      '  --------+-------+---------+----------------+-------------',
      ...summary.rows.map((r) =>
        `  ${String(r.repeats).padStart(7)} | ${String(r.pairs).padStart(5)} | ${String(r.campers).padStart(7)} | ${String(r.shutOutCampers).padStart(14)} | ${String(r.shutOutPairs).padStart(12)}`
      ),
      '',
      '  What each column counts:',
      '    repeats         occurrences of ONE activity a camper received, exactly this many',
      '    pairs           (camper, activity) pairs held exactly `repeats` times',
      '    campers         distinct campers holding at least one such pair',
      '    shutOutCampers  of THOSE campers, how many received none of some activity they ranked',
      '    shutOutPairs    (camper, activity) shut-out pairs held by THOSE campers',
      '',
      '  Overall totals — NOT a sum of the rows above, because the rows overlap:',
      `    ranked-but-unplaced (camper, activity) pairs: ${summary.totalShutOut}`,
      `    campers shut out of at least one activity they ranked: ${summary.campersShutOutAtLeastOnce} of ${summary.totalCampers}`,
      '',
    ]
    console.log(lines.join('\n'))

    // Non-vacuous: the fixture must genuinely produce repeats, or it is not
    // exercising the behaviour the owner ruled on.
    expect(summary.rows.length).toBeGreaterThan(0)
    expect(summary.rows.some((r) => r.pairs > 0)).toBe(true)
    // And the halves of the figure must reconcile against the assignment count.
    expect(summary.totalCounted).toBe(summary.totalAssignments)
    expect(summary.totalShutOut).toBeGreaterThan(0)

    // TRIPWIRE for the round-2 HIGH 1 defect: the per-row shut-out figure used
    // to be the WHOLE fixture's shut-out list filtered by "activities some
    // camper anywhere reached k". Those activity sets are not disjoint across k,
    // so the x2 row printed the entire overall total and the column summed to
    // 2.6x the truth. A row's cohort is a strict subset of the campers, so its
    // figure must be strictly smaller than the overall total.
    const partialCohorts = summary.rows.filter((r) => r.campers < summary.totalCampers)
    expect(partialCohorts.length).toBeGreaterThan(0)
    for (const r of partialCohorts) {
      expect(r.shutOutPairs).toBeLessThan(summary.totalShutOut)
      expect(r.shutOutCampers).toBeLessThanOrEqual(r.campers)
    }
  })
})
