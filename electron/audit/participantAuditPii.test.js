// @vitest-environment node
//
// T194 / ADR docs/adr/2026-09-17-individual-elective-scheduling.md D9:
// "no camper field value may be passed into recordAuditEvent metadata".
//
// SECRET_KEYS (auditLog.js) is a KEY-NAME BLOCKLIST, not a PII filter, and it
// cannot be made into one: the hazard here is the VALUE, not the key. There is
// no key name that makes `{ name: 'Sarah Cohen' }` safe and no key name that
// makes it dangerous — a blocklist simply cannot see it.
//
// audit_events is append-only and survives deletion, so a camper's display name
// written here is unrecoverable by ANY purge, including T202's. That makes this
// a structural guard at the write, not a cleanup job.
import { describe, it, expect, beforeEach, afterEach, afterAll } from 'vitest'
import fs from 'node:fs'
import { openTemplatedDb, cleanupTemplatedDbs } from '../db/testDbTemplate.js'
import { recordAuditEvent, listAuditEvents } from './auditLog.js'
import { deriveElectiveAssignmentId } from '../ops/electiveDerivedIds.js'
// Round 2, M2: the list is IMPORTED, not re-typed. A hand-kept copy in a test
// is a guard that cannot notice an eighth entity.
import {
  PARTICIPANT_ENTITIES as REGISTERED_PARTICIPANT_ENTITIES,
  PARTICIPANT_ENTITY_NEAR_MISSES,
} from '../ops/participantEntities.js'

const PARTICIPANT_ENTITIES = [...REGISTERED_PARTICIPANT_ENTITIES]

afterAll(() => {
  cleanupTemplatedDbs()
})

let db
let tmpFile

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

const record = (targetType, metadata) =>
  recordAuditEvent(db, {
    campId: 'camp-1',
    action: 'elective.generate',
    targetType,
    targetId: 'x',
    // audit_events CHECKs outcome IN ('allow','deny') — a fixture built from the
    // code under test rather than from the SCHEMA is how this table went a week
    // silently rejecting rows once already.
    outcome: 'allow',
    metadata,
  })

describe('recordAuditEvent refuses free text on the participant entities', () => {
  it('throws on a display-name-shaped value, for every one of the seven', () => {
    for (const entity of PARTICIPANT_ENTITIES) {
      expect(() => record(entity, { value: 'Sarah Cohen' }), `${entity} accepted a name`).toThrow(
        /participant/i
      )
    }
  })

  it('throws on a filename, which is free text by another name', () => {
    expect(() => record('campers', { source: 'Summer 2026 prefs.xlsx' })).toThrow(/participant/i)
  })

  it('throws on free text nested inside the metadata', () => {
    expect(() => record('campers', { context: { display_name: 'Sarah Cohen' } })).toThrow(
      /participant/i
    )
    expect(() => record('campers', { names: ['Sarah Cohen'] })).toThrow(/participant/i)
  })

  it('throws even when the key name looks innocuous — the hazard is the VALUE', () => {
    expect(() => record('elective_preferences', { note: 'wants swim with her sister' })).toThrow(
      /participant/i
    )
  })

  // NON-VACUITY, and the reason the safe set is not literally [A-Za-z0-9_-]:
  // a DERIVED ID contains ':' and '.', so an alphabet that excluded them would
  // refuse the very ids this feature is built on.
  it('ACCEPTS ids, numbers, booleans and the declared enum literals', () => {
    const derived = deriveElectiveAssignmentId('run-1', 'camper-1', 'occ-1')
    expect(() =>
      record('elective_assignments', {
        assignment_id: derived,
        run_id: '3f2a9c10-4b8e-4d6f-9a11-0c2d3e4f5a6b',
        rank: 2,
        is_locked: true,
        missing: null,
        status: 'draft',
        source: 'solver',
        capacity_mode: 'unlimited',
      })
    ).not.toThrow()
    expect(listAuditEvents(db, { limit: 10 }).length).toBe(1)
  })

  it('leaves NON-participant entities completely unaffected', () => {
    // The guard is scoped to the seven. Ordinary audit rows must keep working
    // exactly as before, free text and all — this is not a global policy change.
    expect(() => record('activities', { name: 'Arts & Crafts' })).not.toThrow()
    expect(() => record('users', { reason: 'role changed by an admin' })).not.toThrow()
    expect(listAuditEvents(db, { limit: 10 }).length).toBe(2)
  })

  it('still never throws for an ordinary DB failure — the base contract is intact', () => {
    // recordAuditEvent's contract is that a failure here must never block or
    // corrupt the authorization decision it is recording. The PII guard is a
    // deliberate, narrow exception for a CALLER BUG; an infrastructure failure
    // must still be swallowed.
    db.close()
    expect(() => record('activities', { ok: 1 })).not.toThrow()
    // reopen so afterEach's close() does not double-close
    const templated = openTemplatedDb()
    db = templated.db
    if (fs.existsSync(tmpFile)) fs.unlinkSync(tmpFile)
    tmpFile = templated.file
  })

  it('writes NOTHING when it refuses — a refused row must not be half-recorded', () => {
    expect(() => record('campers', { value: 'Sarah Cohen' })).toThrow()
    expect(listAuditEvents(db, { limit: 10 }).length).toBe(0)
  })
})

// ---------------------------------------------------------------------------
// Round 2, M1 and M2. The round-1 guard covered `metadata` ONLY. `targetId` and
// `reason` were bound raw, and `reason` is free text at every existing call
// site in this repo — so the natural T195 call
// `recordAuditEvent(db, { targetType: 'campers', reason: 'resolved "Sarah
// Cohen" to camper-15' })` wrote an unerasable child's name to an append-only
// table, past a guard whose whole purpose was to stop exactly that.
//
// targetId is guarded too, and not as belt-and-braces: a derived id EMBEDS a
// normalized human label (a choice id contains the choice's label key), so a
// targetId is not automatically PII-free.
// ---------------------------------------------------------------------------
describe('the guard covers every free-text-carrying field, not only metadata', () => {
  const recordWith = (fields) =>
    recordAuditEvent(db, {
      campId: 'camp-1',
      action: 'elective.import',
      outcome: 'allow',
      ...fields,
    })

  for (const entity of REGISTERED_PARTICIPANT_ENTITIES) {
    it(`refuses free text in reason for ${entity}`, () => {
      expect(() =>
        recordWith({ targetType: entity, targetId: 'x', reason: 'resolved "Sarah Cohen" to camper-15' })
      ).toThrow(/reason/i)
    })

    it(`refuses free text in targetId for ${entity}`, () => {
      expect(() => recordWith({ targetType: entity, targetId: 'Sarah Cohen' })).toThrow(/targetId/i)
    })
  }

  it('still accepts an id-shaped targetId and an id-shaped reason', () => {
    expect(() =>
      recordWith({
        targetType: 'campers',
        targetId: 'camper-15',
        reason: 'purge.camper-15',
      })
    ).not.toThrow()
    expect(listAuditEvents(db, { limit: 5 })[0].target_id).toBe('camper-15')
  })

  it('accepts a DERIVED id as targetId — the ids this feature actually mints', () => {
    expect(() =>
      recordWith({
        targetType: 'elective_assignments',
        targetId: deriveElectiveAssignmentId('run-1', 'camper-1', 'occ-1'),
      })
    ).not.toThrow()
  })

  // Non-participant entities are untouched: `reason` is free text by design
  // everywhere else in this repo, and every existing call site relies on it.
  it('leaves reason free text for a non-participant target type', () => {
    expect(() =>
      recordWith({ targetType: 'activities', targetId: 'act-1', reason: 'Deleted "Swim" by hand' })
    ).not.toThrow()
  })
})

describe('the guard is not defeated by a near-miss target type', () => {
  it('refuses a singular or shorthand participant spelling instead of silently not firing', () => {
    for (const [spelling, entity] of PARTICIPANT_ENTITY_NEAR_MISSES) {
      expect(
        () =>
          recordAuditEvent(db, {
            campId: 'camp-1',
            action: 'elective.import',
            outcome: 'allow',
            targetType: spelling,
            targetId: 'x',
          }),
        spelling
      ).toThrow(new RegExp(entity))
    }
  })

  it('has near misses to test — the derivation is not empty', () => {
    expect(PARTICIPANT_ENTITY_NEAR_MISSES.size).toBeGreaterThan(6)
  })
})
