// @vitest-environment node
//
// T194 / ADR docs/adr/2026-09-17-individual-elective-scheduling.md D9:
// the WHOLE participant domain is admin-only. Staff consume the EXPORTED
// ARTIFACT — the activity roster and the child schedule a counsellor holds —
// not a read grant on the entities.
//
// WHY THIS FILE EXISTS SEPARATELY FROM permissionsEntityParity.test.js.
// That test guards OMISSION: a camp-scoped entity missing from ENTITIES and
// silently resolving to admin-only. By construction it cannot catch an
// OVER-GRANT — adding `campers` to ENTITIES would make that test PASS while
// handing every staff member both read and write over a child's record.
// This file asserts the NEGATIVE, which is the only thing that catches it.
import { describe, it, expect, beforeEach, afterEach, afterAll } from 'vitest'
import fs from 'node:fs'
import { randomBytes, randomUUID } from 'node:crypto'
import { openTemplatedDb, cleanupTemplatedDbs } from '../db/testDbTemplate.js'
import { issueLocalToken, ensureHostSigningKey } from './localAuth.js'
import { authorize } from './authorize.js'
import { PERMISSIONS, ENTITIES } from './permissions.js'
import { RESTORE_DECISIONS, RESTORABLE_ENTITIES } from '../ops/restore.js'
import { PROJECTIONS } from '../ops/projections.js'
import { PARTICIPANT_ENTITIES as REGISTERED_PARTICIPANT_ENTITIES } from '../ops/participantEntities.js'

// Round 2, M2: imported from the single definition. A hand-kept copy here is a
// guard that cannot notice an eighth entity — the exact shape this repo has
// been bitten by before.
const PARTICIPANT_ENTITIES = [...REGISTERED_PARTICIPANT_ENTITIES]

const VERBS = ['read', 'write', 'delete', 'restore', 'bulk_replace', 'import']

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
  db.prepare('UPDATE camps SET signing_secret = ? WHERE id = ?').run(
    randomBytes(32).toString('hex'),
    'camp-1'
  )
  db.prepare(
    `INSERT INTO devices (id, name, authorized_at, device_secret_identifier, pairing_status)
     VALUES (?, ?, ?, ?, 'authorized')`
  ).run('device-1', 'Test Device', new Date().toISOString(), randomBytes(32).toString('hex'))
  const hostKey = ensureHostSigningKey(db)
  db.prepare('UPDATE camps SET signing_public_key = ? WHERE id = ?').run(hostKey.public_key, 'camp-1')
})

afterEach(() => {
  db.close()
  if (tmpFile && fs.existsSync(tmpFile)) fs.unlinkSync(tmpFile)
})

function staffToken() {
  const id = randomUUID()
  db.prepare(
    'INSERT INTO users (id, camp_id, name, pin_hash, pin_salt, role) VALUES (?, ?, ?, ?, ?, ?)'
  ).run(id, 'camp-1', `Staff-${id}`, 'hash', 'salt', 'staff')
  return issueLocalToken(db, id, 'device-1')
}

function adminToken() {
  const id = randomUUID()
  db.prepare(
    'INSERT INTO users (id, camp_id, name, pin_hash, pin_salt, role) VALUES (?, ?, ?, ?, ?, ?)'
  ).run(id, 'camp-1', `Admin-${id}`, 'hash', 'salt', 'admin')
  return issueLocalToken(db, id, 'device-1')
}

describe('the participant domain is admin-only (ADR D9)', () => {
  it('keeps all seven OUT of ENTITIES', () => {
    // permissions.js derives staffReadWrite by flatMapping every ENTITIES entry
    // into BOTH `.read` and `.write` with no per-entity opt-in. There is no
    // partial registration, so exclusion is the whole mechanism.
    for (const e of PARTICIPANT_ENTITIES) {
      expect(ENTITIES, `${e} must not be in ENTITIES`).not.toContain(e)
    }
  })

  it('grants staff no action naming any of the seven, for any verb', () => {
    for (const entity of PARTICIPANT_ENTITIES) {
      for (const verb of VERBS) {
        expect(PERMISSIONS.staff, `staff must not hold ${entity}.${verb}`).not.toContain(
          `${entity}.${verb}`
        )
      }
    }
  })

  // Asserted BY NAME as well as by the loop, per the ADR and the ticket, so a
  // future refactor of the loop cannot quietly drop them.
  it('grants staff no campers.read', () => {
    expect(PERMISSIONS.staff).not.toContain('campers.read')
  })
  it('grants staff no campers.write', () => {
    expect(PERMISSIONS.staff).not.toContain('campers.write')
  })
  it('grants staff no elective_preferences.read', () => {
    expect(PERMISSIONS.staff).not.toContain('elective_preferences.read')
  })
  it('grants staff no elective_assignments.read', () => {
    expect(PERMISSIONS.staff).not.toContain('elective_assignments.read')
  })

  it('denies a real staff token every verb on every one of the seven', () => {
    const token = staffToken()
    for (const entity of PARTICIPANT_ENTITIES) {
      for (const verb of VERBS) {
        const result = authorize({ db, token, action: `${entity}.${verb}` })
        expect(result.allowed, `staff was ALLOWED ${entity}.${verb}`).toBe(false)
      }
    }
  })

  it('allows a real admin token the same actions — the domain is reachable, just not by staff', () => {
    const token = adminToken()
    for (const entity of PARTICIPANT_ENTITIES) {
      expect(authorize({ db, token, action: `${entity}.read` }).allowed).toBe(true)
      expect(authorize({ db, token, action: `${entity}.write` }).allowed).toBe(true)
    }
  })

  // NON-VACUITY. A test that only asserts absence passes just as happily if
  // PERMISSIONS.staff were emptied, or if the lookup broke, or if authorize()
  // started denying everything. The positive control turns all three red.
  it('positive control: the same checks DO find the ordinary staff grants', () => {
    expect(PERMISSIONS.staff).toContain('activities.read')
    expect(PERMISSIONS.staff).toContain('activities.write')
    const token = staffToken()
    expect(authorize({ db, token, action: 'activities.read' }).allowed).toBe(true)
    expect(authorize({ db, token, action: 'activities.write' }).allowed).toBe(true)
  })
})

describe('history and Trash on the seven are admin-only BY CONSTRUCTION', () => {
  // D9 requires per-record history and Trash to be admin-only too, and the
  // blanket 'trash.read' grant cannot be narrowed by omission. Verified:
  // it does not need to be. TWO INDEPENDENT EXISTING MECHANISMS already make
  // it true, and these tests exist to keep it true rather than to add a third.

  it('history: getEntityHistoryHandler authorizes `<entity>.read`, which staff do not hold', () => {
    // electron/main.js's getEntityHistoryHandler calls
    // requireAuthorized(db, { token, action: `${entity}.read` }) — a PER-ENTITY
    // action, not blanket 'trash.read'. So per-record history on the seven is
    // already admin-only, with no mechanism change.
    const token = staffToken()
    for (const entity of PARTICIPANT_ENTITIES) {
      expect(authorize({ db, token, action: `${entity}.read` }).allowed).toBe(false)
    }
    // ...and the handler additionally requires PROJECTIONS[entity], which all
    // seven now satisfy — so the denial above is the ONLY thing standing
    // between staff and a camper's history. That is why this test exists.
    for (const entity of PARTICIPANT_ENTITIES) {
      expect(PROJECTIONS[entity], `${entity} missing from PROJECTIONS`).toBeTruthy()
    }
  })

  // Round 2, L4. The assertion above is about `authorize`; the claim it is
  // making is about main.js. A comment naming the handler is not a test of it:
  // if getEntityHistoryHandler ever became blanket `trash.read`, every test in
  // this describe block would stay green while camper history opened to staff.
  // Read the source and pin the action string.
  it('history: the handler really authorizes `<entity>.read`, not blanket trash.read', () => {
    const main = fs.readFileSync(
      new URL('../main.js', import.meta.url),
      'utf8'
    )
    const start = main.indexOf('function getEntityHistoryHandler')
    expect(start, 'getEntityHistoryHandler not found — was it renamed?').toBeGreaterThan(-1)
    const body = main.slice(start, main.indexOf('\n  }', start))
    expect(body).toContain('action: `${entity}.read`')
    expect(body).not.toContain('trash.read')
  })

  // T248 — the same source-pinning pattern as getEntityHistoryHandler above,
  // for the new getElectiveRunOuterScheduleHandler (electron/main.js).
  it('elective outer schedule: the handler really authorizes elective_assignment_runs.read', () => {
    const main = fs.readFileSync(
      new URL('../main.js', import.meta.url),
      'utf8'
    )
    const start = main.indexOf('function getElectiveRunOuterScheduleHandler')
    expect(start, 'getElectiveRunOuterScheduleHandler not found — was it renamed?').toBeGreaterThan(-1)
    const body = main.slice(start, main.indexOf('\n  }', start))
    expect(body).toContain("action: 'elective_assignment_runs.read'")
    const actionStrings = [...body.matchAll(/action:\s*'([^']+)'/g)].map((m) => m[1])
    expect(actionStrings).toEqual(['elective_assignment_runs.read'])
  })

  it('trash: none of the seven can ever be enumerated by listDeleted', () => {
    // listDeleted (electron/ops/trash.js) filters its result to
    // RESTORABLE_ENTITIES, which restore.js derives as exactly those keys whose
    // RESTORE_DECISIONS value is the LITERAL 'restorable'. Blanket 'trash.read'
    // grants the ability to CALL the handler, not the ability to see a camper.
    for (const entity of PARTICIPANT_ENTITIES) {
      expect(RESTORABLE_ENTITIES.has(entity), `${entity} is enumerable in Trash`).toBe(false)
    }
  })

  it('pins all seven as non-restorable, so a flip is a deliberate failing-test decision', () => {
    for (const entity of PARTICIPANT_ENTITIES) {
      expect(RESTORE_DECISIONS[entity], `${entity} has no recorded decision`).toBeTruthy()
      // The mechanism is the value NOT being the literal 'restorable'. Flipping
      // one later — e.g. when a setup UI ships — would START LISTING CAMPER
      // ROWS to any staff holding blanket trash.read. This assertion makes that
      // a decision someone has to take on purpose.
      expect(RESTORE_DECISIONS[entity]).not.toBe('restorable')
      expect(RESTORE_DECISIONS[entity]).toMatch(/^refused:/)
    }
  })

  // Non-vacuity for the two above: prove the mechanism can say YES.
  it('positive control: an ordinary entity IS restorable and IS enumerable', () => {
    expect(RESTORE_DECISIONS.activities).toBe('restorable')
    expect(RESTORABLE_ENTITIES.has('activities')).toBe(true)
  })
})
