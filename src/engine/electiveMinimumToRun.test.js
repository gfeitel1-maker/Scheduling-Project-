// T265 — an offering that does not make its minimum does not run, and its
// campers cascade to their next available ranked choice.
//
// Owner ruling 2026-09-26: placement is TWO PHASES — place every camper from
// their preferences, THEN validate against the minimums, THEN move the campers
// whose offering did not make its minimum. A minimum is not a constraint the
// solver can honour while placing (you cannot know an offering is short until
// everyone has been placed), which is why it cannot live inside minCostAssign.
//
// Owner ruling 2026-09-26, cancellation order: cancel the offering FURTHEST
// BELOW its minimum first (largest `minimum - enrolled`), ties by a stable
// identifier. Order changes the answer, so it is pinned here explicitly.
import { describe, it, expect } from 'vitest'
import { buildElectiveAssignments } from './buildElectiveAssignments.js'

const occ = (id) => ({ id })
// `minimum` is nullable: null/undefined means no minimum to enforce. It can
// never be 0 — the DB CHECK rejects 0 and `resolveOfferingMinimum` is the only
// producer — which is what makes a single engine-side field safe where the
// stored value needs the two-part (min_mode, min_to_run) shape.
const offering = (occurrence_id, labelKey, activity_id, capacity = 1, minimum = null) =>
  ({ occurrence_id, labelKey, activity_id, capacity, minimum })
const pref = (camper_id, labelKey, rank) => ({ camper_id, labelKey, rank })
const campers = (...ids) => ids.map((id) => ({ id }))

const placedIn = (out, activityId) =>
  out.assignments.filter((a) => a.activity_id === activityId).map((a) => a.camper_id).sort()
const declined = (out) =>
  out.findings.filter((f) => f.kind === 'BELOW_MINIMUM').map((f) => f.activity_id)

describe('minimum headcount to run an offering', () => {
  // NON-VACUITY, and the ticket names it as the required negative: a guard that
  // is too eager passes every "declines below minimum" test while silently
  // refusing valid offerings. Exactly AT the minimum must RUN.
  it('runs an offering whose enrolment exactly MEETS its minimum', () => {
    const out = buildElectiveAssignments({
      campers: campers('c1', 'c2', 'c3', 'c4', 'c5'),
      occurrences: [occ('o1')],
      offerings: [
        offering('o1', 'archery', 'a-arch', 10, 5),
        offering('o1', 'swim', 'a-swim', 10, null),
      ],
      preferences: ['c1', 'c2', 'c3', 'c4', 'c5'].flatMap((c) => [
        pref(c, 'archery', 1), pref(c, 'swim', 2),
      ]),
    })
    expect(placedIn(out, 'a-arch')).toEqual(['c1', 'c2', 'c3', 'c4', 'c5'])
    expect(declined(out)).toEqual([])
  })

  it('declines an offering one short of its minimum and cascades its campers to their next ranked choice', () => {
    const out = buildElectiveAssignments({
      campers: campers('c1', 'c2', 'c3', 'c4'),
      occurrences: [occ('o1')],
      offerings: [
        offering('o1', 'archery', 'a-arch', 10, 5),
        offering('o1', 'swim', 'a-swim', 10, null),
      ],
      preferences: ['c1', 'c2', 'c3', 'c4'].flatMap((c) => [
        pref(c, 'archery', 1), pref(c, 'swim', 2),
      ]),
    })
    expect(placedIn(out, 'a-arch')).toEqual([])
    expect(placedIn(out, 'a-swim')).toEqual(['c1', 'c2', 'c3', 'c4'])
    expect(declined(out)).toEqual(['a-arch'])
    // They landed on a choice they actually ranked, at that rank — the cascade
    // goes through the preference machinery, it does not dump them anywhere.
    expect(out.assignments.every((a) => a.preference_rank === 2)).toBe(true)
  })

  it('names the declined offering and its shortfall in the finding', () => {
    const out = buildElectiveAssignments({
      campers: campers('c1', 'c2', 'c3'),
      occurrences: [occ('o1')],
      offerings: [
        offering('o1', 'archery', 'a-arch', 10, 5),
        offering('o1', 'swim', 'a-swim', 10, null),
      ],
      preferences: ['c1', 'c2', 'c3'].flatMap((c) => [
        pref(c, 'archery', 1), pref(c, 'swim', 2),
      ]),
    })
    const f = out.findings.find((x) => x.kind === 'BELOW_MINIMUM')
    expect(f).toMatchObject({
      kind: 'BELOW_MINIMUM',
      occurrence_id: 'o1',
      activity_id: 'a-arch',
      labelKey: 'archery',
      enrolled: 3,
      minimum: 5,
      shortfall: 2,
    })
    expect(f.message).toContain('3 of the 5')
  })

  // A minimum of null is not a minimum of 0. An offering with one camper and no
  // minimum runs — the absence of a value must never be read as "needs 0", and
  // must never be read as "needs something" either.
  it('leaves an offering with no minimum alone however few campers it holds', () => {
    const out = buildElectiveAssignments({
      campers: campers('c1'),
      occurrences: [occ('o1')],
      offerings: [offering('o1', 'archery', 'a-arch', 10, null)],
      preferences: [pref('c1', 'archery', 1)],
    })
    expect(placedIn(out, 'a-arch')).toEqual(['c1'])
    expect(out.findings.filter((f) => f.kind === 'BELOW_MINIMUM')).toEqual([])
  })

  // THE DISTINGUISHING FIXTURE, named in the ticket. Archery is 4 of 6
  // (shortfall 2); Fishing is 3 of 4 (shortfall 1). Fishing has FEWER campers,
  // but Archery is FURTHER BELOW ITS OWN MINIMUM, so Archery comes off first —
  // and its four campers then carry Fishing past 4, so Fishing RUNS.
  //
  // An implementation that cancels by fewest-enrolled, or in id order, cancels
  // Fishing instead and its three campers carry Archery past 6: the mirror
  // outcome, equally self-consistent, and wrong. Asserting WHICH offering was
  // declined separates them.
  it('cancels the offering furthest below its own minimum first, not the one with fewest campers', () => {
    const out = buildElectiveAssignments({
      campers: campers('c1', 'c2', 'c3', 'c4', 'c5', 'c6', 'c7'),
      occurrences: [occ('o1')],
      offerings: [
        offering('o1', 'archery', 'a-arch', 20, 6),
        offering('o1', 'fishing', 'a-fish', 20, 4),
      ],
      preferences: [
        // four want Archery first
        ...['c1', 'c2', 'c3', 'c4'].flatMap((c) => [pref(c, 'archery', 1), pref(c, 'fishing', 2)]),
        // three want Fishing first
        ...['c5', 'c6', 'c7'].flatMap((c) => [pref(c, 'fishing', 1), pref(c, 'archery', 2)]),
      ],
    })
    expect(declined(out)).toEqual(['a-arch'])
    expect(placedIn(out, 'a-fish')).toEqual(['c1', 'c2', 'c3', 'c4', 'c5', 'c6', 'c7'])
  })

  // The cascade RESCUES: cancelling the furthest-below offering releases campers
  // that carry a surviving offering past its own minimum. This is why the loop
  // iterates rather than evaluating minima once — a single pass would decline
  // both and leave nothing running.
  it('lets campers released by a cancellation rescue an offering that was itself short', () => {
    const out = buildElectiveAssignments({
      campers: campers('c1', 'c2', 'c3', 'c4', 'c5', 'c6', 'c7', 'c8', 'c9'),
      occurrences: [occ('o1')],
      offerings: [
        offering('o1', 'archery', 'a-arch', 20, 6),
        offering('o1', 'fishing', 'a-fish', 20, 6),
      ],
      preferences: [
        ...['c1', 'c2', 'c3', 'c4'].flatMap((c) => [pref(c, 'archery', 1), pref(c, 'fishing', 2)]),
        ...['c5', 'c6', 'c7', 'c8', 'c9'].flatMap((c) => [pref(c, 'fishing', 1), pref(c, 'archery', 2)]),
      ],
    })
    // Archery: 4 of 6 (shortfall 2). Fishing: 5 of 6 (shortfall 1). Archery off
    // first; its four join Fishing, which reaches 9 and runs.
    expect(declined(out)).toEqual(['a-arch'])
    expect(placedIn(out, 'a-fish')).toHaveLength(9)
  })

  // A camper with no next available ranked choice is a real case. They are not
  // placed, and a finding says so rather than dropping them silently.
  it('reports campers left with nowhere to go when their only offering does not run', () => {
    const out = buildElectiveAssignments({
      campers: campers('c1', 'c2'),
      occurrences: [occ('o1')],
      offerings: [offering('o1', 'archery', 'a-arch', 10, 5)],
      preferences: [pref('c1', 'archery', 1), pref('c2', 'archery', 1)],
    })
    expect(out.assignments).toEqual([])
    expect(declined(out)).toEqual(['a-arch'])
    const f = out.findings.find((x) => x.kind === 'UNPLACED_AFTER_DECLINE')
    expect(f).toMatchObject({ occurrence_id: 'o1', camper_ids: ['c1', 'c2'] })
    expect(f.message).toMatch(/did not run/i)
  })

  // A cascade can push a surviving offering over its capacity — the displaced
  // campers are placed into REMAINING capacity, never past it.
  it('never pushes a surviving offering past its capacity to absorb a cascade', () => {
    const out = buildElectiveAssignments({
      campers: campers('c1', 'c2', 'c3'),
      occurrences: [occ('o1')],
      offerings: [
        offering('o1', 'archery', 'a-arch', 10, 5),
        offering('o1', 'swim', 'a-swim', 2, null),
      ],
      preferences: ['c1', 'c2', 'c3'].flatMap((c) => [
        pref(c, 'archery', 1), pref(c, 'swim', 2),
      ]),
    })
    expect(placedIn(out, 'a-swim')).toHaveLength(2)
    expect(out.findings.some((f) => f.kind === 'UNPLACED_AFTER_DECLINE')).toBe(true)
  })

  // DETERMINISM. buildSchedule.js's seeded-PRNG property must hold here too: a
  // cascade whose outcome depends on Map or input-array iteration order is a bug
  // that only shows up across devices.
  it('produces an identical result when the input arrays arrive in a different order', () => {
    const base = {
      campers: campers('c1', 'c2', 'c3', 'c4', 'c5', 'c6', 'c7'),
      occurrences: [occ('o1'), occ('o2')],
      offerings: [
        offering('o1', 'archery', 'a-arch', 20, 6),
        offering('o1', 'fishing', 'a-fish', 20, 4),
        offering('o2', 'archery', 'a-arch', 20, 5),
        offering('o2', 'fishing', 'a-fish', 20, 5),
      ],
      preferences: [
        ...['c1', 'c2', 'c3', 'c4'].flatMap((c) => [pref(c, 'archery', 1), pref(c, 'fishing', 2)]),
        ...['c5', 'c6', 'c7'].flatMap((c) => [pref(c, 'fishing', 1), pref(c, 'archery', 2)]),
      ],
    }
    const forward = buildElectiveAssignments(base)
    const reversed = buildElectiveAssignments({
      campers: [...base.campers].reverse(),
      occurrences: [...base.occurrences].reverse(),
      offerings: [...base.offerings].reverse(),
      preferences: [...base.preferences].reverse(),
    })
    expect(reversed.assignments).toEqual(forward.assignments)
    expect(reversed.findings).toEqual(forward.findings)
  })

  // Ties on shortfall resolve by a stable identifier, never by input order.
  it('breaks a shortfall tie by a stable identifier', () => {
    const build = (offerings) => buildElectiveAssignments({
      campers: campers('c1', 'c2', 'c3', 'c4'),
      occurrences: [occ('o1')],
      offerings,
      preferences: [
        ...['c1', 'c2'].flatMap((c) => [pref(c, 'alpha', 1), pref(c, 'beta', 2)]),
        ...['c3', 'c4'].flatMap((c) => [pref(c, 'beta', 1), pref(c, 'alpha', 2)]),
      ],
    })
    const a = offering('o1', 'alpha', 'a-alpha', 20, 4)
    const b = offering('o1', 'beta', 'a-beta', 20, 4)
    // Both hold 2 of 4 — an exact tie on shortfall. Same answer either way in.
    expect(declined(build([a, b]))).toEqual(declined(build([b, a])))
  })

  // The minimum is per OCCURRENCE, not per activity across the week: Monday's
  // Archery making its minimum says nothing about Wednesday's.
  it('evaluates each occurrence of an offering against the minimum on its own', () => {
    const out = buildElectiveAssignments({
      campers: campers('c1', 'c2', 'c3'),
      occurrences: [occ('o1'), occ('o2')],
      offerings: [
        offering('o1', 'archery', 'a-arch', 10, 3),
        offering('o1', 'swim', 'a-swim', 10, null),
        offering('o2', 'archery', 'a-arch', 10, 3),
        offering('o2', 'swim', 'a-swim', 10, null),
      ],
      preferences: [
        // all three want Archery in o1 — it makes its minimum of 3 there
        ...['c1', 'c2', 'c3'].map((c) => ({ ...pref(c, 'archery', 1), occurrence_id: 'o1' })),
        ...['c1', 'c2', 'c3'].map((c) => ({ ...pref(c, 'swim', 2), occurrence_id: 'o1' })),
        // only one wants it in o2 — short there
        { ...pref('c1', 'archery', 1), occurrence_id: 'o2' },
        ...['c1', 'c2', 'c3'].map((c) => ({ ...pref(c, 'swim', 1), occurrence_id: 'o2' })),
      ],
    })
    const short = out.findings.filter((f) => f.kind === 'BELOW_MINIMUM')
    expect(short).toHaveLength(1)
    expect(short[0]).toMatchObject({ occurrence_id: 'o2', activity_id: 'a-arch' })
    expect(placedIn(out, 'a-arch')).toEqual(['c1', 'c2', 'c3'])
  })

  // A locked seat is a director's decision and is never re-decided (T246). It
  // COUNTS toward the minimum, and a cancellation never moves it.
  it('counts a locked seat toward the minimum and never moves it', () => {
    const out = buildElectiveAssignments({
      campers: campers('c1', 'c2', 'c3'),
      occurrences: [occ('o1')],
      offerings: [
        offering('o1', 'archery', 'a-arch', 10, 3),
        offering('o1', 'swim', 'a-swim', 10, null),
      ],
      lockedAssignments: [{ camperId: 'c3', occurrenceId: 'o1', activityId: 'a-arch' }],
      preferences: ['c1', 'c2'].flatMap((c) => [pref(c, 'archery', 1), pref(c, 'swim', 2)]),
    })
    // c1 + c2 solved into Archery, c3 locked there: 3 of 3, it runs.
    expect(placedIn(out, 'a-arch')).toEqual(['c1', 'c2', 'c3'])
    expect(declined(out)).toEqual([])
  })

  // A hand-set seat cannot be moved (T246), so an offering holding one cannot be
  // emptied and is not cancelled. It is still REPORTED — an offering quietly
  // running under its minimum is the silent wrongness this ticket removes.
  it('keeps a short offering that holds a hand-set seat, and says why', () => {
    const out = buildElectiveAssignments({
      campers: campers('c1', 'c2'),
      occurrences: [occ('o1')],
      offerings: [
        offering('o1', 'archery', 'a-arch', 10, 5),
        offering('o1', 'swim', 'a-swim', 10, null),
      ],
      lockedAssignments: [{ camperId: 'c2', occurrenceId: 'o1', activityId: 'a-arch' }],
      preferences: [pref('c1', 'archery', 1), pref('c1', 'swim', 2)],
    })
    expect(declined(out)).toEqual([])
    expect(placedIn(out, 'a-arch')).toEqual(['c1', 'c2'])
    const f = out.findings.find((x) => x.kind === 'KEPT_BELOW_MINIMUM')
    expect(f).toMatchObject({ activity_id: 'a-arch', enrolled: 2, minimum: 5, shortfall: 3 })
    expect(f.message).toMatch(/set by hand/i)
  })

  // An offering kept for holding a hand-set seat is STILL OPEN, so a cascade can
  // rescue it — and if it reaches its minimum it is no longer short and must not
  // be reported as short. Archery (2 of 5, uncancellable) is rescued to 6 by the
  // campers Fishing releases.
  //
  // This separates two structures that look interchangeable: reporting the kept
  // offering DURING the cascade loop has to exclude it from further placement to
  // avoid re-reporting it, which blocks exactly this rescue and then reports a
  // shortfall that the engine itself prevented from being fixed. Reporting
  // happens once, after the loop settles.
  it('lets a cascade rescue an offering that was kept for holding a hand-set seat', () => {
    const out = buildElectiveAssignments({
      campers: campers('c1', 'c2', 'c3', 'c4', 'c5', 'c6'),
      occurrences: [occ('o1')],
      offerings: [
        offering('o1', 'archery', 'a-arch', 10, 5),
        offering('o1', 'fishing', 'a-fish', 10, 6),
      ],
      lockedAssignments: [{ camperId: 'c1', occurrenceId: 'o1', activityId: 'a-arch' }],
      preferences: [
        pref('c2', 'archery', 1),
        ...['c3', 'c4', 'c5', 'c6'].flatMap((c) => [pref(c, 'fishing', 1), pref(c, 'archery', 2)]),
      ],
    })
    // Archery starts at 2 of 5 and cannot be cancelled; Fishing is 4 of 6 and can.
    // Fishing comes off, its four move to Archery, and Archery reaches 6.
    expect(declined(out)).toEqual(['a-fish'])
    expect(placedIn(out, 'a-arch')).toEqual(['c1', 'c2', 'c3', 'c4', 'c5', 'c6'])
    expect(out.findings.filter((f) => f.kind === 'KEPT_BELOW_MINIMUM')).toEqual([])
  })
})
