// T229 -- building solver offerings from confirmed elective_set_activities.
// The CAPACITY TRAP: buildElectiveAssignments does `Math.max(0, o.capacity ??
// 0)`, so capacity 0 or null CLOSES the offering. capacity_mode:'unlimited'
// must never reach the engine as 0/null.
import { describe, it, expect } from 'vitest'
import { buildOfferings } from './buildOfferings'
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

// imported after mapping tests define it below via re-export in module.
import { findMismatches } from './buildOfferings'
