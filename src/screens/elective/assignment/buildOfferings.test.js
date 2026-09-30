// T229 -- building solver offerings from confirmed elective_set_activities.
// The CAPACITY TRAP: buildElectiveAssignments does `Math.max(0, o.capacity ??
// 0)`, so capacity 0 or null CLOSES the offering. capacity_mode:'unlimited'
// must never reach the engine as 0/null.
import { describe, it, expect } from 'vitest'
import { buildOfferings, findBlankCapacities } from './buildOfferings'
import { buildElectiveAssignments } from '../../../engine/buildElectiveAssignments'

describe('buildOfferings', () => {
  it('maps unlimited capacity to a very large number, never 0 or null', () => {
    const offerings = buildOfferings({
      occurrences: [{ id: 'occ-1' }],
      setActivities: [{ id: 'osa-1', activity_id: 'act-1', status: 'confirmed', capacity_mode: 'unlimited', capacity_limit: null }],
      activities: [{ id: 'act-1', name: 'Swim' }],
    })
    expect(offerings).toHaveLength(1)
    expect(offerings[0].capacity).toBeGreaterThan(1000)
  })

  // H5 — schema.sql declares `status TEXT NOT NULL DEFAULT 'confirmed'` and
  // `capacity_mode TEXT NOT NULL DEFAULT 'unlimited'`; the real electron path
  // always has them (SQLite materialises the default at INSERT). This
  // defends the shape src/localClient.mock.js can produce instead -- its rows
  // have no schema behind them, so a row created through the ordinary "Add
  // Offering" flow (ElectiveSetDetail's buildCreateFields writes only
  // elective_set_id/activity_id) read back as undefined, not the schema
  // default. Before this fix that row was silently both unconfirmed AND
  // capacity 0 in browser-dev -- invisible and closed, through the ordinary
  // UI path.
  it('treats a missing status/capacity_mode as the schema defaults (confirmed/unlimited), not closed', () => {
    const offerings = buildOfferings({
      occurrences: [{ id: 'occ-1' }],
      setActivities: [{ id: 'osa-1', activity_id: 'act-1' }],
      activities: [{ id: 'act-1', name: 'Swim' }],
    })
    expect(offerings).toHaveLength(1)
    expect(offerings[0].capacity).toBeGreaterThan(1000)
  })

  it('excludes offerings that are not confirmed', () => {
    const offerings = buildOfferings({
      occurrences: [{ id: 'occ-1' }],
      setActivities: [{ id: 'osa-1', activity_id: 'act-1', status: 'proposed', capacity_mode: 'unlimited', capacity_limit: null }],
      activities: [{ id: 'act-1', name: 'Swim' }],
    })
    expect(offerings).toHaveLength(0)
  })

  it('maps limited capacity to its numeric limit', () => {
    const offerings = buildOfferings({
      occurrences: [{ id: 'occ-1' }],
      setActivities: [{ id: 'osa-1', activity_id: 'act-1', status: 'confirmed', capacity_mode: 'limited', capacity_limit: 5 }],
      activities: [{ id: 'act-1', name: 'Swim' }],
    })
    expect(offerings[0].capacity).toBe(5)
  })

  it('end-to-end: an unlimited offering actually places a camper, proving capacity did not collapse to 0', () => {
    const occurrences = [{ id: 'occ-1' }]
    const offerings = buildOfferings({
      occurrences,
      setActivities: [{ id: 'osa-1', activity_id: 'act-1', status: 'confirmed', capacity_mode: 'unlimited', capacity_limit: null }],
      activities: [{ id: 'act-1', name: 'Swim' }],
    })
    const { assignments, findings } = buildElectiveAssignments({
      campers: [{ id: 'cam-1' }],
      occurrences,
      offerings,
      preferences: [{ camper_id: 'cam-1', labelKey: 'swim', rank: 1 }],
    })
    expect(assignments).toEqual([
      expect.objectContaining({ camper_id: 'cam-1', occurrence_id: 'occ-1', activity_id: 'act-1' }),
    ])
    expect(findings).toEqual([])
  })

  it('joins a sheet label to an offered activity ignoring whitespace/case', () => {
    const occurrences = [{ id: 'occ-1' }]
    const offerings = buildOfferings({
      occurrences,
      setActivities: [{ id: 'osa-1', activity_id: 'act-1', status: 'confirmed', capacity_mode: 'unlimited', capacity_limit: null }],
      activities: [{ id: 'act-1', name: 'Arts & Crafts' }],
    })
    expect(offerings[0].labelKey).toBe(offerings[0].labelKey.toLowerCase().replace(/\s+/g, ''))
  })

  it('surfaces a finding for a ranked label matching no offered activity, without throwing', () => {
    const occurrences = [{ id: 'occ-1' }]
    const offerings = buildOfferings({
      occurrences,
      setActivities: [{ id: 'osa-1', activity_id: 'act-1', status: 'confirmed', capacity_mode: 'unlimited', capacity_limit: null }],
      activities: [{ id: 'act-1', name: 'Swim' }],
    })
    const findings = findMismatches({ offerings, preferences: [{ camper_id: 'cam-1', labelKey: 'archery', label: 'Archery', rank: 1 }] })
    expect(findings.length).toBeGreaterThan(0)
  })
})

// T316 — a confirmed offering declared 'limited' with a blank capacity_limit
// (`resolveOfferingCapacity`'s `unknownLimit`) must be NAMED, not silently
// closed at capacity 0. Owner ruling 2026-09-29: "blank capacities need to be
// filled in."
describe('buildOfferings: a blank limited capacity is named and excluded, not closed at 0', () => {
  const activities = [{ id: 'act-1', name: 'Archery' }, { id: 'act-2', name: 'Swim' }]
  const occurrences = [{ id: 'occ-1' }]

  it('findBlankCapacities names the activity, carries its ids, and buildOfferings drops the row entirely — while a sibling GOOD offering still exists', () => {
    const setActivities = [
      { id: 'osa-1', activity_id: 'act-1', status: 'confirmed', capacity_mode: 'limited', capacity_limit: null },
      { id: 'osa-2', activity_id: 'act-2', status: 'confirmed', capacity_mode: 'unlimited', capacity_limit: null },
    ]

    const findings = findBlankCapacities({ setActivities, activities })
    expect(findings).toHaveLength(1)
    expect(findings[0]).toMatchObject({ kind: 'INVALID_CAPACITY', activity_id: 'act-1', set_activity_id: 'osa-1' })
    expect(findings[0].message).toContain('"Archery"')

    const offerings = buildOfferings({ occurrences, setActivities, activities })
    // Absence, not a call count: the row must produce NO offering at all...
    expect(offerings.find((o) => o.activity_id === 'act-1')).toBeUndefined()
    // ...and never sneak back in as a closed (capacity 0) offering...
    expect(offerings.some((o) => o.capacity === 0)).toBe(false)
    // ...while the sibling offering proves this isn't just an empty/broken fixture.
    expect(offerings.find((o) => o.activity_id === 'act-2')).toBeDefined()
  })

  it('produces no finding for a non-confirmed row with a blank limited capacity', () => {
    const findings = findBlankCapacities({
      setActivities: [{ id: 'osa-1', activity_id: 'act-1', status: 'proposed', capacity_mode: 'limited', capacity_limit: null }],
      activities,
    })
    expect(findings).toEqual([])
  })
})

// imported after mapping tests define it below via re-export in module.
import { findMismatches } from './buildOfferings'

// T265 — the minimum reaches the engine through the SAME path the capacity does.
// THE NON-VACUITY BAR THE TICKET SETS: a test that hand-builds an offering object
// asserts something about the fixture, not about the system, so these go through
// buildOfferings from a stored-row shape and then through the engine. Three
// instances of that failure in one day (T62, T197 round 1, T265's own
// occurrence_id) are why this is a bar and not a reviewer's preference.
describe('buildOfferings: the minimum headcount to run', () => {
  const setActivity = (overrides) => ({
    id: 'osa-1', activity_id: 'act-1', status: 'confirmed',
    capacity_mode: 'unlimited', capacity_limit: null, ...overrides,
  })
  const activities = [{ id: 'act-1', name: 'Swim' }]
  const occurrences = [{ id: 'occ-1' }]

  it('carries a stated minimum onto the offering', () => {
    const offerings = buildOfferings({
      occurrences, activities,
      setActivities: [setActivity({ min_mode: 'required', min_to_run: 4 })],
    })
    expect(offerings[0].minimum).toBe(4)
  })

  // A NULL minimum must never arrive as 0. If it did, `enrolled >= 0` is always
  // true and the minimum silently stops existing — or, with the comparison the
  // other way round, every offering is unrunnable forever.
  it('carries NULL through as null, never as 0', () => {
    const offerings = buildOfferings({
      occurrences, activities,
      setActivities: [setActivity({ min_mode: 'none', min_to_run: null })],
    })
    expect(offerings[0].minimum).toBeNull()
    expect(offerings[0].minimum).not.toBe(0)
  })

  it('ignores a leftover value when the mode says none', () => {
    const offerings = buildOfferings({
      occurrences, activities,
      setActivities: [setActivity({ min_mode: 'none', min_to_run: 9 })],
    })
    expect(offerings[0].minimum).toBeNull()
  })

  // The mock's row shape (no min columns at all) must not invent a minimum, or
  // every offering in browser-dev becomes unrunnable — the mirror of the
  // capacity-collapse bug the H5 comment above records.
  it('treats a row with no minimum columns as having no minimum', () => {
    const offerings = buildOfferings({
      occurrences, activities,
      setActivities: [{ id: 'osa-1', activity_id: 'act-1' }],
    })
    expect(offerings[0].minimum).toBeNull()
  })

  it('end-to-end through the stored-row shape: an offering under its minimum does not run', () => {
    const offerings = buildOfferings({
      occurrences,
      activities: [{ id: 'act-1', name: 'Swim' }, { id: 'act-2', name: 'Art' }],
      setActivities: [
        setActivity({ min_mode: 'required', min_to_run: 3 }),
        setActivity({ id: 'osa-2', activity_id: 'act-2' }),
      ],
    })
    const { assignments, findings } = buildElectiveAssignments({
      campers: [{ id: 'cam-1' }, { id: 'cam-2' }],
      occurrences,
      offerings,
      preferences: [
        { camper_id: 'cam-1', labelKey: 'swim', rank: 1 }, { camper_id: 'cam-1', labelKey: 'art', rank: 2 },
        { camper_id: 'cam-2', labelKey: 'swim', rank: 1 }, { camper_id: 'cam-2', labelKey: 'art', rank: 2 },
      ],
    })
    // Swim needed 3 and had 2, so both campers are in Art instead.
    expect(assignments.map((a) => a.activity_id)).toEqual(['act-2', 'act-2'])
    expect(findings.find((f) => f.kind === 'BELOW_MINIMUM')).toMatchObject({
      activity_id: 'act-1', enrolled: 2, minimum: 3, shortfall: 1,
    })
  })

  // An existing offering's placement must be BYTE-IDENTICAL before and after the
  // migration — the ticket's explicit requirement. A pre-v80 row has no minimum
  // columns at all; a migrated row has min_mode 'none'. Both must solve the same.
  it('places an existing offering identically before and after the migration', () => {
    const solve = (setActivities) => buildElectiveAssignments({
      campers: [{ id: 'cam-1' }],
      occurrences,
      offerings: buildOfferings({ occurrences, activities, setActivities }),
      preferences: [{ camper_id: 'cam-1', labelKey: 'swim', rank: 1 }],
    })
    const preMigration = solve([{
      id: 'osa-1', activity_id: 'act-1', status: 'confirmed',
      capacity_mode: 'unlimited', capacity_limit: null,
    }])
    const postMigration = solve([setActivity({ min_mode: 'none', min_to_run: null })])
    expect(postMigration.assignments).toEqual(preMigration.assignments)
    expect(postMigration.findings).toEqual(preMigration.findings)
    expect(preMigration.assignments).toHaveLength(1)
  })
})
