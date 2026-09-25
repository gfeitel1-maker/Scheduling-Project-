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
})
