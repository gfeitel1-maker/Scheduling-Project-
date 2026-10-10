import { describe, it, expect } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import { parseTextGrid } from './textGrid.js'
import { extractEntities } from './extractEntities.js'
import { capturePlacements } from './capturePlacements.js'
import { buildReconciliationReport } from './reconciliationReport.js'
import { decisionTitle, entityNoun } from './decisionTitle.js'

const campB = fs.readFileSync(path.join(process.cwd(), 'docs/work/specs/samples/campB-by-day.txt'), 'utf8')
const parsed = parseTextGrid(campB)
const proposal = extractEntities(parsed)
const { placements } = capturePlacements(parsed, proposal)
const allGroupNames = proposal.entities.groups
const ctx = { placements, allGroupNames }

const decision = (over) => ({ kind: 'confirm_value', entity: 'activities', entityId: null, entityName: 'Carpool', field: null, proposedValue: null, ...over })

describe('decisionTitle says what will happen (audit 714 item 2)', () => {
  it('a fixed event names the groups and the times', () => {
    expect(decisionTitle(decision({ entity: 'fixed_events', timeBlock: '08:40-09:00', days: ['Monday'] }), ctx))
      .toBe('Make Carpool a fixed event for every group at 8:40 AM and 3:40 PM?')
  })

  it('a new activity names the groups and the times', () => {
    expect(decisionTitle(decision(), ctx)).toBe('Add Carpool as an activity for every group at 8:40 AM and 3:40 PM?')
  })

  it('falls back to the fixed event’s own block when the grid says nothing', () => {
    expect(decisionTitle(decision({ entity: 'fixed_events', entityName: 'Ghost', timeBlock: '15:40-16:00', days: ['Monday'] }), ctx))
      .toBe('Make Ghost a fixed event at 3:40–4:00 PM?')
  })

  it('a new activity with no placements is still a plain sentence', () => {
    expect(decisionTitle(decision({ entityName: 'Ghost' }), ctx)).toBe('Add Ghost as an activity?')
  })

  it.each([
    ['groups', 'Add the group "Badger 2"?'],
    ['tiers', 'Add the age division "Badger 2"?'],
    ['time_blocks', 'Add the time block "Badger 2"?'],
    ['locations', 'Add the place "Badger 2"?'],
  ])('a new %s row', (entity, expected) => {
    expect(decisionTitle(decision({ entity, entityName: 'Badger 2' }), ctx)).toBe(expected)
  })

  it('a field change names the field and the value', () => {
    expect(decisionTitle(decision({ entityName: 'Swim', field: ['min_per_week'], proposedValue: 3 }), ctx))
      .toBe('Set Swim’s fewest per week to 3?')
  })

  it('several fields at once', () => {
    expect(decisionTitle(decision({ entityName: 'Swim', field: ['min_per_week', 'priority'], proposedValue: { min_per_week: 3, priority: 2 } }), ctx))
      .toBe('Update Swim’s fewest per week and priority?')
  })

  it('entityNoun speaks camp, not schema', () => {
    expect(entityNoun('fixed_events')).toBe('Fixed event')
    expect(entityNoun('activities')).toBe('Activity')
    expect(entityNoun('mystery_table')).toBe('mystery table')
  })

  it('flows through the report onto each decision', () => {
    const planItems = [{ op: 'create', entity: 'activities', entity_id: null, _name: 'Carpool', evidence: { tier: 'low' }, fields: {} }]
    const report = buildReconciliationReport({ planItems, readiness: [], placements, allGroupNames })
    expect(report.decisions[0].title).toBe('Add Carpool as an activity for every group at 8:40 AM and 3:40 PM?')
  })
})
