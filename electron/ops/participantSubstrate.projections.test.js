// @vitest-environment node
//
// T194 round 2, H1 and H2. Both defects shipped green because every existing
// test — scenarios 31 and 32 included — uses the ONE op ordering that hides
// them: the parent always arrives before the child, and nothing ever deletes a
// parent that has children.
//
// H1: `elective_choice_offerings.ensureExists` minted a stub PARENT row with
//     run_id = '' to satisfy a NOT NULL column. `elective_choices.run_id`
//     carried a declared REFERENCES and PRAGMA foreign_keys is ON, and
//     INSERT OR IGNORE does NOT suppress a foreign-key violation, so an
//     out-of-order (orphan-parent) op THREW. The throw escapes applyProjection
//     into projector.js's upsertEntity, which had no try/catch, aborting
//     projectAll's one shared transaction and rolling back every other
//     entity's legitimate projection — one malformed record from a paired peer
//     freezing every receiving device's projection.
//
// H2: every child declared a hard REFERENCES on its parent with no ON DELETE,
//     so a parent DELETE op threw the same way — including the run delete that
//     deleteWeek.js's own guard tells the director to perform first.
//
// The fix for both is the same and is recorded in schema.sql: the seven
// participant tables use SOFT references throughout. See that comment for why.
import { describe, it, expect, afterEach, beforeEach, afterAll } from 'vitest'
import fs from 'node:fs'
import { openTemplatedDb, cleanupTemplatedDbs } from '../db/testDbTemplate.js'
import { applyProjection } from './projections.js'

afterAll(() => {
  cleanupTemplatedDbs()
})

let tmpFile
let db

beforeEach(() => {
  const templated = openTemplatedDb()
  db = templated.db
  tmpFile = templated.file
  db.prepare('INSERT INTO camps (id, name) VALUES (?, ?)').run('camp-1', 'Camp One')
})

afterEach(() => {
  db.close()
  if (tmpFile && fs.existsSync(tmpFile)) fs.unlinkSync(tmpFile)
})

const project = (entity, entity_id, field, value) =>
  applyProjection(db, { entity, entity_id, field, value })

// Sanity: the hazard class only exists with foreign keys actually enforced, so
// assert the pragma rather than assuming openTemplatedDb sets it.
it('runs with foreign_keys enforcement ON', () => {
  expect(db.pragma('foreign_keys', { simple: true })).toBe(1)
})

describe('H1 — an out-of-order child op does not abort the batch', () => {
  it('projects an offering whose choice has not arrived yet', () => {
    expect(() =>
      project('elective_choice_offerings', 'off-1', 'choice_id', 'ghost-choice')
    ).not.toThrow()
    const row = db.prepare('SELECT * FROM elective_choice_offerings WHERE id = ?').get('off-1')
    expect(row.choice_id).toBe('ghost-choice')
  })

  it('projects a run whose schedule week has not arrived yet', () => {
    expect(() =>
      project('elective_assignment_runs', 'run-1', 'schedule_week_id', 'ghost-week')
    ).not.toThrow()
    expect(
      db.prepare('SELECT schedule_week_id FROM elective_assignment_runs WHERE id = ?').get('run-1')
        .schedule_week_id
    ).toBe('ghost-week')
  })

  it('projects a camper whose group has not arrived yet', () => {
    project('campers', 'camper-1', 'camp_id', 'camp-1')
    expect(() => project('campers', 'camper-1', 'group_id', 'ghost-group')).not.toThrow()
  })

  it('projects every child of a run that has not arrived yet', () => {
    for (const entity of [
      'elective_occurrences',
      'elective_choices',
      'elective_preferences',
      'elective_assignments',
    ]) {
      expect(() => project(entity, `${entity}-x`, 'run_id', 'ghost-run'), entity).not.toThrow()
    }
  })
})

describe('H2 — deleting a parent that has children does not throw', () => {
  const seedRun = () => {
    project('elective_assignment_runs', 'run-1', 'camp_id', 'camp-1')
    project('elective_occurrences', 'occ-1', 'run_id', 'run-1')
    project('elective_choices', 'choice-1', 'run_id', 'run-1')
    project('elective_choices', 'choice-1', 'label', 'Swim')
    project('elective_choice_offerings', 'off-1', 'choice_id', 'choice-1')
    project('elective_preferences', 'pref-1', 'run_id', 'run-1')
    project('elective_assignments', 'asgn-1', 'run_id', 'run-1')
  }

  it('deletes a run that still has occurrences, preferences and assignments', () => {
    seedRun()
    expect(() =>
      project('elective_assignment_runs', 'run-1', '__deleted__', 1)
    ).not.toThrow()
    expect(
      db.prepare('SELECT COUNT(*) c FROM elective_assignment_runs').get().c
    ).toBe(0)
  })

  it('deletes a choice that still has offerings', () => {
    seedRun()
    expect(() => project('elective_choices', 'choice-1', '__deleted__', 1)).not.toThrow()
    expect(db.prepare('SELECT COUNT(*) c FROM elective_choices').get().c).toBe(0)
  })

  it('deletes the camp-scoped parents (camper, run) without a camps FK refusal', () => {
    project('campers', 'camper-1', 'camp_id', 'camp-1')
    expect(() => project('campers', 'camper-1', '__deleted__', 1)).not.toThrow()
  })
})
