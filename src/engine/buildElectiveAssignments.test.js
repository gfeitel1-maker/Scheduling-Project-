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

  it('returns empty rather than throwing on empty input', () => {
    const out = buildElectiveAssignments({ campers: [], occurrences: [], offerings: [], preferences: [] })
    expect(out.assignments).toEqual([])
    expect(out.findings).toEqual([])
  })
})
