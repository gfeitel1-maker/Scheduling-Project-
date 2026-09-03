import { describe, it, expect } from 'vitest'
import { extractEntities } from './extractEntities.js'
import { capturePlacements } from './capturePlacements.js'

describe('capturePlacements', () => {
  it('captures group × day × block → activity for a one-page-per-group grid (orientation A)', () => {
    const pages = [{
      title: 'Bunk 1',
      columns: ['Monday', 'Tuesday'],
      rows: [
        { label: '09:00-09:40', cells: ['Swim', 'Art'] },
        { label: '09:45-10:25', cells: ['Art', 'Swim'] },
      ],
    }]
    const proposal = extractEntities({ pages })
    const { placements } = capturePlacements({ pages }, proposal)
    expect(placements).toContainEqual({ groupName: 'Bunk 1', dayName: 'Monday', blockLabel: '09:00-09:40', activityName: 'Swim' })
    expect(placements).toContainEqual({ groupName: 'Bunk 1', dayName: 'Tuesday', blockLabel: '09:00-09:40', activityName: 'Art' })
    expect(placements).toContainEqual({ groupName: 'Bunk 1', dayName: 'Monday', blockLabel: '09:45-10:25', activityName: 'Art' })
    expect(placements).toHaveLength(4)
  })

  it('captures group × day × block for a one-page-per-day grid (orientation B)', () => {
    const pages = [{
      title: 'Monday',
      columns: ['Bunk 1', 'Bunk 2'],
      rows: [{ label: '09:00-09:40', cells: ['Swim', 'Art'] }],
    }]
    const proposal = extractEntities({ pages })
    const { placements } = capturePlacements({ pages }, proposal)
    expect(placements).toContainEqual({ groupName: 'Bunk 1', dayName: 'Monday', blockLabel: '09:00-09:40', activityName: 'Swim' })
    expect(placements).toContainEqual({ groupName: 'Bunk 2', dayName: 'Monday', blockLabel: '09:00-09:40', activityName: 'Art' })
  })

  it('reads cells through the canonical map (a "Swim2" typo captures as "Swim 2")', () => {
    const pages = [{
      title: 'Bunk 1',
      columns: ['Monday', 'Tuesday', 'Wednesday'],
      rows: [{ label: '09:00-09:40', cells: ['Swim 2', 'Swim 2', 'Swim2'] }],
    }]
    const proposal = extractEntities({ pages })
    const { placements } = capturePlacements({ pages }, proposal)
    // all three fold to the dominant "Swim 2"
    expect(placements.every((p) => p.activityName === 'Swim 2')).toBe(true)
    expect(placements).toHaveLength(3)
  })

  it('ignores non-block rows (a banner row with no time label)', () => {
    const pages = [{
      title: 'Bunk 1',
      columns: ['Monday'],
      rows: [
        { label: 'Opening', cells: ['Assembly'] },
        { label: '09:00-09:40', cells: ['Swim'] },
      ],
    }]
    const proposal = extractEntities({ pages })
    const { placements } = capturePlacements({ pages }, proposal)
    expect(placements).toEqual([{ groupName: 'Bunk 1', dayName: 'Monday', blockLabel: '09:00-09:40', activityName: 'Swim' }])
  })

  // T118 slice 3 code review — activityNamesFromCell has a FOURTH caller
  // (this file), not three: a prior fix (PR #256) missed a third call site,
  // and the initial T118 slice 3 diff repeated that miss one caller later by
  // threading compoundCellDecisions through only extractEntities/
  // inferFixedEvents/inferMultiBlockCandidates. Every reader of raw cells
  // through activityNamesFromCell must apply the SAME confirmed decisions, or
  // a wrapper-resolved cell (e.g. "Lunch + Leave" -> "Lunch") would still
  // capture its placement under the unresolved wrapper name here, which
  // resolveImportedPlacements.js (T117) can never match to a real activity.
  it('reads placements through the same confirmed compound-cell decisions as extractEntities (T118 slice 3)', () => {
    const pages = [{
      title: 'Bunk 1',
      columns: ['Monday', 'Tuesday'],
      rows: [{ label: '11:25-12:05', cells: ['Lunch + Leave', 'Lunch + Leave'] }],
    }]
    const decisions = new Map([
      ['Lunch + Leave', { interpretation: 'wrapper', anchor_name: 'Lunch', wrapper_name: 'Leave' }],
    ])
    const proposal = extractEntities({ pages }, decisions)
    expect(proposal.compoundCellDecisions).toBe(decisions)
    const { placements } = capturePlacements({ pages }, proposal)
    expect(placements).toEqual([
      { groupName: 'Bunk 1', dayName: 'Monday', blockLabel: '11:25-12:05', activityName: 'Lunch' },
      { groupName: 'Bunk 1', dayName: 'Tuesday', blockLabel: '11:25-12:05', activityName: 'Lunch' },
    ])
  })
})
