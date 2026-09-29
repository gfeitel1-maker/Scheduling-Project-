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
import {
  PARTICIPANT_ENTITIES as REGISTERED_PARTICIPANT_ENTITIES,
  STAFF_ATTRIBUTABLE_PARTICIPANT_ENTITIES,
  STAFF_READABLE_PARTICIPANT_ENTITIES,
} from '../ops/participantEntities.js'

// Round 2, M2: imported from the single definition. A hand-kept copy here is a
// guard that cannot notice an eighth entity — the exact shape this repo has
// been bitten by before.
const PARTICIPANT_ENTITIES = [...REGISTERED_PARTICIPANT_ENTITIES]

// T306 adds 'attribute'. It is listed here because the loops below are exhaustive
// over ENTITIES but NOT over verbs: a grant whose verb is absent from this array is
// skipped by every assertion in the file. Verified by experiment -- adding
// `campers.attribute` to PERMISSIONS.staff left all 25 assertions GREEN while the
// participant domain's staff surface widened. The last test in this describe now
// derives the verb list from PERMISSIONS itself so that cannot recur.
const VERBS = ['read', 'write', 'delete', 'restore', 'bulk_replace', 'import', 'attribute']

// T304 — the loops below skip exactly the (entity, verb) pairs the owner's
// 2026-09-29 ruling opened, DERIVED from the same constant permissions.js
// derives the grant from. Typing 'campers.read' here as a literal would be the
// hand-kept second copy this module was created to abolish: the skip and the
// grant could then disagree, and the loop would go on passing while doing less.
//
// A skip is not a hole. Every pair skipped here is asserted BY NAME below —
// `campers.read` positively (staff must hold it) and every other campers verb
// negatively — so relaxing the loop cannot quietly relax the rule.
const STAFF_EXCEPTIONS = [
  ['read', STAFF_READABLE_PARTICIPANT_ENTITIES],
  // T306, owner ruling 2026-09-29 — staff may NAME an unnamed subject. Its own verb
  // rather than `.write` because attributeElectiveSubject's is_unattributed guard
  // lives in the op and NOT in the generic write path, so a wide grant would route
  // staff around it (see electron/ops/participantEntities.js).
  ['attribute', STAFF_ATTRIBUTABLE_PARTICIPANT_ENTITIES],
]

function isStaffGranted(entity, verb) {
  return STAFF_EXCEPTIONS.some(([v, set]) => verb === v && set.has(entity))
}

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

  it('grants staff no action naming any of the seven, for any verb but the T304 exception', () => {
    for (const entity of PARTICIPANT_ENTITIES) {
      for (const verb of VERBS) {
        if (isStaffGranted(entity, verb)) continue
        expect(PERMISSIONS.staff, `staff must not hold ${entity}.${verb}`).not.toContain(
          `${entity}.${verb}`
        )
      }
    }
  })

  // T304 — the exception set must name only REGISTERED participant entities.
  // A typo ('camper', 'campers ') would silently grant nothing while reading
  // like a grant, and the skip above would stop skipping — a failure that
  // looks like success from both directions.
  it('every staff-readable exception is a registered participant entity', () => {
    expect(STAFF_READABLE_PARTICIPANT_ENTITIES.size).toBeGreaterThan(0)
    for (const entity of STAFF_READABLE_PARTICIPANT_ENTITIES) {
      expect(
        REGISTERED_PARTICIPANT_ENTITIES.has(entity),
        `${entity} is exempted but is not a participant entity`
      ).toBe(true)
    }
  })

  // T304 — the exception is READ ONLY. permissions.js derives the grant by
  // mapping this set to `.read`; if it were ever folded into ENTITIES instead,
  // `.write` would come with it silently. This is the assertion that catches
  // that, and it is deliberately derived from the same set.
  it('each exception grants exactly its own verb and nothing else', () => {
    for (const [grantedVerb, set] of STAFF_EXCEPTIONS) {
      expect(set.size, `the ${grantedVerb} exception set must not be empty`).toBeGreaterThan(0)
      for (const entity of set) {
        expect(PERMISSIONS.staff).toContain(`${entity}.${grantedVerb}`)
        for (const verb of VERBS.filter((v) => !isStaffGranted(entity, v))) {
          expect(PERMISSIONS.staff, `staff must not hold ${entity}.${verb}`).not.toContain(
            `${entity}.${verb}`
          )
        }
        expect(ENTITIES, `${entity} must still be out of ENTITIES`).not.toContain(entity)
      }
    }
  })

  // T306 — every exception set must name only REGISTERED participant entities, the
  // same typo trap the read set is checked for above.
  it('every staff-attributable exception is a registered participant entity', () => {
    expect(STAFF_ATTRIBUTABLE_PARTICIPANT_ENTITIES.size).toBeGreaterThan(0)
    for (const entity of STAFF_ATTRIBUTABLE_PARTICIPANT_ENTITIES) {
      expect(
        REGISTERED_PARTICIPANT_ENTITIES.has(entity),
        `${entity} is exempted but is not a participant entity`
      ).toBe(true)
    }
  })

  // T306 — THE BLIND SPOT THIS FILE HAD, closed. Every loop above iterates VERBS, so
  // a staff grant using a verb absent from that array is invisible to all of them.
  // Confirmed by experiment: `campers.attribute` was added and all 25 assertions
  // stayed green. This derives the verbs from PERMISSIONS.staff itself, so the next
  // new verb fails HERE instead of passing everywhere.
  it('VERBS lists every verb staff actually hold on a participant entity', () => {
    const held = new Set()
    for (const action of PERMISSIONS.staff) {
      const [entity, verb] = String(action).split('.')
      if (verb && REGISTERED_PARTICIPANT_ENTITIES.has(entity)) held.add(verb)
    }
    expect(held.size, 'positive control: staff must hold SOMETHING here, or this passes vacuously').toBeGreaterThan(0)
    for (const verb of held) {
      expect(
        VERBS,
        `staff hold a participant-entity '.${verb}' but VERBS omits it, so every loop in this file skips it`
      ).toContain(verb)
    }
  })

  // Asserted BY NAME as well as by the loop, per the ADR and the ticket, so a
  // future refactor of the loop cannot quietly drop them.
  // T304 — INVERTED from 'grants staff no campers.read' by owner ruling,
  // 2026-09-29. Asserted by name as well as through the loop, in the same
  // spirit as the original: a future refactor of the exception mechanism must
  // not quietly drop the grant the Roots home depends on.
  it('grants staff campers.read (T304 owner ruling)', () => {
    expect(PERMISSIONS.staff).toContain('campers.read')
  })
  it('grants staff no campers.write', () => {
    expect(PERMISSIONS.staff).not.toContain('campers.write')
  })
  // T306 owner ruling, 2026-09-29 — asserted by name as well as through the loop,
  // in the same spirit as campers.read above.
  it('grants staff campers.attribute (T306 owner ruling)', () => {
    expect(PERMISSIONS.staff).toContain('campers.attribute')
  })
  it('grants staff no elective_preferences.read', () => {
    expect(PERMISSIONS.staff).not.toContain('elective_preferences.read')
  })
  it('grants staff no elective_assignments.read', () => {
    expect(PERMISSIONS.staff).not.toContain('elective_assignments.read')
  })

  it('denies a real staff token every verb on every one of the seven, but the T304 exception', () => {
    const token = staffToken()
    for (const entity of PARTICIPANT_ENTITIES) {
      for (const verb of VERBS) {
        if (isStaffGranted(entity, verb)) continue
        const result = authorize({ db, token, action: `${entity}.${verb}` })
        expect(result.allowed, `staff was ALLOWED ${entity}.${verb}`).toBe(false)
      }
    }
  })

  // T304 — the matrix above is a data assertion; this is the behavioural one.
  // A real staff token must actually get through authorize() for the granted
  // action, or the Roots home is still empty for the role it was opened for.
  it('allows a real staff token the granted read, and still refuses its write', () => {
    const token = staffToken()
    for (const entity of STAFF_READABLE_PARTICIPANT_ENTITIES) {
      expect(
        authorize({ db, token, action: `${entity}.read` }).allowed,
        `staff was DENIED ${entity}.read`
      ).toBe(true)
      expect(
        authorize({ db, token, action: `${entity}.write` }).allowed,
        `staff was ALLOWED ${entity}.write`
      ).toBe(false)
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
    //
    // T304 — and this is exactly why the exception is skipped rather than the
    // test deleted. `campers.read` now opens per-record CAMPER HISTORY to
    // staff as well as the roster, because this handler derives its action
    // from the entity name. That was counted before the grant was written
    // (T304, "what changes") and is a consequence of the owner's ruling, not
    // an oversight: it is "who renamed this subject and when" for a role that
    // may already read the name. Recorded here so the next reader of this file
    // finds it stated rather than inferring it from a skip.
    const token = staffToken()
    for (const entity of PARTICIPANT_ENTITIES) {
      if (STAFF_READABLE_PARTICIPANT_ENTITIES.has(entity)) continue
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
