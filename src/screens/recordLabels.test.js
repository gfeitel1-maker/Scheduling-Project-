import { describe, it, expect } from 'vitest'
import { entityLabel, fieldLabel, restoreCaveat } from './recordLabels'

// T18 / CONSTITUTION Art. V: "The user is a camp director, not a software
// operator ... They do not know what an op-log is, and must never need to."
//
// These are the translation layer between the op log's table/column names and
// what a director reads in Trash and record History. The fallbacks are the
// point of the tests: both used to pass the raw name straight through, so any
// entity or column nobody had thought to map leaked schema onto the screen.

describe('entityLabel', () => {
  it('names the records a director works with', () => {
    expect(entityLabel('groups')).toBe('Group')
    expect(entityLabel('activities')).toBe('Activity')
    expect(entityLabel('days_of_operation')).toBe('Day')
    expect(entityLabel('anchor_activities')).toBe('Fixed event')
  })

  it('never leaks a raw table name for something unmapped', () => {
    // `users` is a real case — deleting a person is covered by the Trash
    // tests — and it renders as a section heading, so it was the most visible.
    for (const unmapped of ['users', 'template_slots', 'schedule_templates', 'day_override_template_slots']) {
      expect(entityLabel(unmapped)).toBe('Record')
      expect(entityLabel(unmapped)).not.toMatch(/_/)
    }
  })
})

describe('fieldLabel', () => {
  it('names the fields a director filled in', () => {
    expect(fieldLabel('name')).toBe('Name')
    expect(fieldLabel('min_per_week')).toBe('Fewest per week')
    expect(fieldLabel('weather_alternative_id')).toBe('Wet-weather alternative')
  })

  it('covers the schedule-cell fields, which used to hit the fallback', () => {
    // A history line about a cell read "changed is span head" before T18.
    expect(fieldLabel('is_span_head')).toBe('Runs across two periods')
    expect(fieldLabel('is_locked')).toBe('Held in place')
    expect(fieldLabel('is_anchor')).toBe('Fixed event')
    expect(fieldLabel('group_id')).toBe('Group')
  })

  it('says the delete and bulk-replace ops in words', () => {
    expect(fieldLabel('__deleted__')).toBe('Deleted')
    expect(fieldLabel('__bulk_replace__')).toBe('Replaced in bulk')
  })

  it('never leaks a raw column name for something unmapped', () => {
    // De-underscoring a column name is still a column name. Better to admit
    // we cannot name it than to show schema.
    for (const unmapped of ['some_future_column', 'internal_seq', 'x']) {
      expect(fieldLabel(unmapped)).toBe('something')
      expect(fieldLabel(unmapped)).not.toMatch(/_/)
    }
  })
})

describe('restoreCaveat', () => {
  it('says what a restore does not bring back, per entity (T24)', () => {
    expect(restoreCaveat('activities')).toMatch(/still empty/)
    expect(restoreCaveat('groups')).toMatch(/Versions on the Schedule screen/)
    expect(restoreCaveat('days_of_operation')).toMatch(/Versions on the Schedule screen/)
  })

  it('stays quiet for a record with nothing else to lose', () => {
    // A caveat on every restore would train directors to skip reading them.
    expect(restoreCaveat('users')).toBeNull()
    expect(restoreCaveat('tiers')).toBeNull()
  })

  it('uses no developer vocabulary', () => {
    for (const entity of ['activities', 'groups', 'days_of_operation']) {
      expect(restoreCaveat(entity)).not.toMatch(/snapshot|op\b|slot|template|route|entity/i)
    }
  })
})
