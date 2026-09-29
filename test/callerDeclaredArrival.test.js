// @vitest-environment node
//
// T303 — A RETRY SAYS IT IS A RETRY: the caller declares the arrival on the
// machine path.
//
// THE DEFECT, confirmed by execution before anything was written. T299 made two
// children who answered identically into two campers on the director's panel,
// because the panel mints an arrival per file selection. The machine path was left
// unsolved and the reason was real: `scripts/preferenceSheetCli.js` passed
// `arrivalId: importedRunId`, and `deriveImportedElectiveRunId` keys that run id on
// the file's BYTES — precisely so that an agent re-sending the same bytes after an
// ambiguous timeout converges rather than duplicating. Under that declaration two
// byte-identical files ARE one submission arriving once, so two children who both
// picked archery and swim collapsed onto ONE camper row holding both children's
// answers, silently, with ok=true.
//
// WHY A PER-INVOCATION ARRIVAL IS NOT THE FIX, and why this file tests both halves
// in the same describe. Minting an arrival per CLI call would split the two children
// and SIMULTANEOUSLY fork every retry. A machine that cannot safely retry a failed
// call cannot be trusted to drive the software at all, so a change that buys case 1
// by losing case 2 is not a fix. Both must hold at once, which is why the caller
// states the arrival: the caller knows whether this is a new submission or the same
// one again, and nothing in the bytes does.
//
// THE THREE CASES, all asserted on CAMPER ROWS IN THE DATABASE rather than on a
// message, and all driven through the REAL CLI core AND the REAL MCP tool — a defect
// on this feature once passed 78 tests because every test entered through one path.
//
//   1. two declared arrivals, byte-identical content -> TWO campers
//   2. one declared arrival, repeated -> ONE camper
//   3. nothing declared -> today's content-derived behaviour, AND the caller is TOLD
//
// FIXTURES ARE DELIBERATELY ANTI-SORTED. The arrival tokens and the filenames both
// sort OPPOSITE to the order they are imported in, because an ordering assertion on
// this feature was once vacuous when fixture ids happened to sort correctly. Nothing
// below may pass by virtue of a lucky sort.
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { randomUUID } from 'node:crypto'

import { openLocalDb } from '../electron/db/localDb.js'
import { runPreferenceSheetCli } from '../scripts/preferenceSheetCli.js'
import { preferenceSheetCommitTool, preferenceSheetPreviewTool } from '../scripts/mcp/tools.js'

const ACTIVITIES = ['Swim', 'Archery', 'Ceramics', 'Nature', 'Gaga', 'Drama']

// ONE submission's bytes, used by TWO different children. This is the adversarial
// case: a camp offering eight options where archery and swim are the obvious picks
// produces byte-identical sheets from two real children, and nothing in the content
// can separate them.
const SAME = 'Period,Monday,Tuesday\nPeriod 1,Swim,Archery\nPeriod 2,Ceramics,Nature\n'
// A genuinely different child, for the non-vacuity checks: the collision residue
// must key on an ACTUAL collision, not fire on every unattributed import.
const OTHER = 'Period,Monday,Tuesday\nPeriod 1,Gaga,Drama\nPeriod 2,Archery,Swim\n'

let dir
let dbPath
let campId

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'shoresh-arrival-'))
  dbPath = path.join(dir, 'shoresh.sqlite')
  const db = openLocalDb(dbPath)
  campId = randomUUID()
  db.prepare('INSERT INTO camps (id, name, signing_secret) VALUES (?, ?, ?)').run(campId, 'Camp', 'a'.repeat(64))
  db.prepare('INSERT INTO devices (id, name) VALUES (?, ?)').run(randomUUID(), 'Host')
  const insert = db.prepare('INSERT INTO activities (id, camp_id, name) VALUES (?, ?, ?)')
  for (const name of ACTIVITIES) insert.run(randomUUID(), campId, name)
  db.close()
})

afterEach(() => fs.rmSync(dir, { recursive: true, force: true }))

const withDb = (fn) => {
  const db = openLocalDb(dbPath)
  try {
    return fn(db)
  } finally {
    db.close()
  }
}

/** Write `content` as `basename` in its own directory, so the same name can repeat. */
function fileWith(basename, content) {
  const sub = fs.mkdtempSync(path.join(dir, 'sub-'))
  const file = path.join(sub, basename)
  fs.writeFileSync(file, content)
  return file
}

/** THE CLI PATH, as an agent drives the core function. */
const viaCli = (basename, content, options = {}) =>
  runPreferenceSheetCli({ file: fileWith(basename, content), dbPath, action: 'commit', ...options })

/** THE MCP PATH, through the real tool handler with its own snake_case argument names. */
const viaMcp = (basename, content, args = {}) =>
  preferenceSheetCommitTool(
    { file_path: fileWith(basename, content), ...args },
    { dbPath, allowWrite: true, authorUserId: null, dbKey: null }
  )

const previewViaMcp = (basename, content, args = {}) =>
  preferenceSheetPreviewTool({ file_path: fileWith(basename, content), ...args }, { dbPath, dbKey: null })

const campers = () =>
  withDb((db) => db.prepare('SELECT id, display_name, is_unattributed FROM campers').all())

const prefRows = (camperId) =>
  withDb((db) =>
    db
      .prepare(
        `SELECT p.coordinate_day_label AS day, p.coordinate_period_label AS period, ch.label
           FROM elective_preferences p
           JOIN elective_choices ch ON ch.id = p.choice_id
          WHERE p.camper_id = ?`
      )
      .all(camperId)
  )

const prefCount = () => withDb((db) => db.prepare('SELECT COUNT(*) c FROM elective_preferences').get().c)

const indistinguishable = (result) =>
  (result.residue ?? []).filter((r) => r.kind === 'INDISTINGUISHABLE_SUBMISSION')

/**
 * Every child's whole week landed, and no coordinate holds two answers.
 *
 * Counting camper rows alone is not enough: a merge is ALSO visible as two answers
 * at one coordinate, and a fork is visible as a child with half a week. Both are
 * checked here so the row count is never the only thing standing between a real
 * defect and a green suite.
 */
function expectWholeWeekEach(rows) {
  for (const r of rows) {
    const mine = prefRows(r.id)
    expect(mine).toHaveLength(4)
    expect(new Set(mine.map((m) => `${m.day}|${m.period}`)).size).toBe(4)
  }
  expect(prefCount()).toBe(rows.length * 4)
}

describe('T303 case 1 — two declared arrivals are TWO campers, byte-identical or not', () => {
  it('CLI: two different arrivals on identical bytes produce two camper rows', () => {
    // ANTI-SORTED ON PURPOSE: 'zz' is imported FIRST and 'aa' second, so a camper id
    // ordered by its arrival component comes back in the opposite order from the
    // calls. Nothing below reads position.
    const first = viaCli('zz-ari.csv', SAME, { arrivalId: 'zz-arrival-1' })
    const second = viaCli('aa-noa.csv', SAME, { arrivalId: 'aa-arrival-2' })
    expect(first.ok).toBe(true)
    expect(second.ok).toBe(true)

    const rows = campers()
    expect(rows).toHaveLength(2)
    expect(new Set(rows.map((r) => r.id)).size).toBe(2)
    for (const r of rows) expect(r.is_unattributed).toBe(1)
    expect(new Set(rows.map((r) => r.display_name))).toEqual(new Set(['zz-ari', 'aa-noa']))
    // Both children chose the same activities — correctly, that is the premise — so
    // each holds its OWN full copy of that week and the total is eight, not four.
    expectWholeWeekEach(rows)
  })

  it('CLI: the arrival is the ONLY distinguishing fact — same bytes, same filename', () => {
    // The hardest form of case 1. Identical content AND identical basename, so the
    // label cannot tell them apart and neither can the bytes. Only the declaration
    // does, which is the whole claim of this ticket.
    expect(viaCli('planner.csv', SAME, { arrivalId: 'second-call-token' }).ok).toBe(true)
    expect(viaCli('planner.csv', SAME, { arrivalId: 'first-call-token' }).ok).toBe(true)

    const rows = campers()
    expect(rows).toHaveLength(2)
    expect(new Set(rows.map((r) => r.id)).size).toBe(2)
    expect(rows.map((r) => r.display_name)).toEqual(['planner', 'planner'])
    expectWholeWeekEach(rows)
  })

  it('MCP: arrival_id on preference_sheet_commit produces two camper rows', () => {
    // THE SECOND DOOR. A defect on this feature once survived 78 tests because every
    // test entered through one path, so the MCP handler is driven with its own
    // argument name rather than assumed to be a pass-through.
    expect(viaMcp('zz-ari.csv', SAME, { arrival_id: 'zz-mcp-1' }).ok).toBe(true)
    expect(viaMcp('aa-noa.csv', SAME, { arrival_id: 'aa-mcp-2' }).ok).toBe(true)

    const rows = campers()
    expect(rows).toHaveLength(2)
    expect(new Set(rows.map((r) => r.id)).size).toBe(2)
    expectWholeWeekEach(rows)
  })

  it('a declared arrival does not disturb genuinely different children', () => {
    // Non-vacuity in the other direction: declaring arrivals must not be the ONLY
    // thing keeping two children apart, or the feature would be masking a regression
    // in the content key it sits on top of.
    expect(viaCli('one.csv', SAME, { arrivalId: 'arr-1' }).ok).toBe(true)
    expect(viaCli('two.csv', OTHER, { arrivalId: 'arr-2' }).ok).toBe(true)
    expect(campers()).toHaveLength(2)
    expectWholeWeekEach(campers())
  })
})

describe('T303 case 2 — one declared arrival repeated is ONE camper', () => {
  it('CLI: the same arrival three times converges, with no duplicate rows', () => {
    // THE HALF A PER-INVOCATION ARRIVAL WOULD HAVE BROKEN. Three times, not two: a
    // fork that only appeared on the third call would pass a two-call test.
    for (let i = 0; i < 3; i++) {
      expect(viaCli('planner.csv', SAME, { arrivalId: 'one-true-arrival' }).ok).toBe(true)
    }
    const rows = campers()
    expect(rows).toHaveLength(1)
    expectWholeWeekEach(rows)
  })

  it('CLI: a retry under one arrival survives the filename changing', () => {
    // An agent retrying a failed call may well have staged the file somewhere else.
    // The arrival is what it declared; the path is not part of the identity.
    expect(viaCli('staged.csv', SAME, { arrivalId: 'retry-token' }).ok).toBe(true)
    expect(viaCli('retried-from-tmp.csv', SAME, { arrivalId: 'retry-token' }).ok).toBe(true)
    expect(campers()).toHaveLength(1)
    expect(prefCount()).toBe(4)
  })

  it('MCP: the same arrival_id twice converges', () => {
    expect(viaMcp('planner.csv', SAME, { arrival_id: 'mcp-retry' }).ok).toBe(true)
    expect(viaMcp('planner.csv', SAME, { arrival_id: 'mcp-retry' }).ok).toBe(true)
    expect(campers()).toHaveLength(1)
    expect(prefCount()).toBe(4)
  })

  it('a declared arrival is never asked about — the caller already said', () => {
    // Requirement 4 applies to a caller that declared NOTHING. A caller that
    // declared is not told its own declaration back.
    viaCli('a.csv', SAME, { arrivalId: 'declared' })
    const second = viaCli('b.csv', SAME, { arrivalId: 'declared' })
    expect(indistinguishable(second)).toEqual([])
  })
})

describe('T303 case 3 — declaring nothing keeps today behaviour, and is TOLD', () => {
  it('CLI: still ONE camper, exactly as before', () => {
    // Never say no at the machine interface. A caller that declares nothing is not
    // refused and its behaviour does not change.
    expect(viaCli('ari.csv', SAME).ok).toBe(true)
    expect(viaCli('noa.csv', SAME).ok).toBe(true)
    expect(campers()).toHaveLength(1)
    expect(prefCount()).toBe(4)
  })

  it('CLI: the SECOND submission says the two were indistinguishable', () => {
    // The silence is the defect, not the merge. An agent that can SEE the collision
    // re-calls with explicit arrivals; an agent that cannot has lost a child's
    // answers and will never know.
    const first = viaCli('ari.csv', SAME)
    expect(indistinguishable(first)).toEqual([]) // non-vacuity: not on a first import
    const second = viaCli('noa.csv', SAME)
    expect(second.ok).toBe(true) // told, not refused
    const told = indistinguishable(second)
    expect(told).toHaveLength(1)
    // The remedy is IN the telling, which is how an agent that has never read the
    // tool schema discovers the parameter exists at the moment it needs it.
    expect(told[0].message).toMatch(/arrival_id/)
    expect(told[0].camper_id).toBe(campers()[0].id)
  })

  it('CLI: a genuinely different child is never reported as indistinguishable', () => {
    // Non-vacuity. The residue must key on the collision, not on being unattributed.
    viaCli('ari.csv', SAME)
    const other = viaCli('noa.csv', OTHER)
    expect(campers()).toHaveLength(2)
    expect(indistinguishable(other)).toEqual([])
  })

  it('MCP: a preview reports the collision before anything is committed', () => {
    // Discovery BEFORE the write. An agent that previews can fix its call without
    // having merged two children first.
    expect(viaMcp('ari.csv', SAME).ok).toBe(true)
    const preview = previewViaMcp('noa.csv', SAME)
    expect(preview.ok).toBe(true)
    expect(indistinguishable(preview)).toHaveLength(1)
    // A preview writes nothing, so the second sheet has not landed.
    expect(campers()).toHaveLength(1)
    expect(prefCount()).toBe(4)
  })

  it('MCP: commit tells the caller too', () => {
    expect(viaMcp('ari.csv', SAME).ok).toBe(true)
    expect(indistinguishable(viaMcp('noa.csv', SAME))).toHaveLength(1)
  })

  it('a named camper is never reported as indistinguishable', () => {
    // An attributed subject has an identity that is a fact about the child, so two
    // identical sheets under one name are one child by declaration, not by guess.
    viaCli('a.csv', SAME, { camperName: 'Aviva Feldspar' })
    const second = viaCli('b.csv', SAME, { camperName: 'Aviva Feldspar' })
    expect(indistinguishable(second)).toEqual([])
    expect(campers()).toHaveLength(1)
  })
})

describe('T303 — a malformed arrival is refused, never silently dropped', () => {
  // A declared arrival becomes a component of a derived camper id, and `opaque()`
  // throws on anything outside [A-Za-z0-9_.:-]. Two outcomes were unacceptable:
  // letting the throw escape (this function's contract is that it never throws past
  // its boundary), and ignoring the declaration (the caller declared two arrivals to
  // keep two children apart, and dropping it merges them without saying so — this
  // ticket's own defect class, at our own API boundary).
  it('says what is wrong instead of throwing', () => {
    let result
    expect(() => {
      result = viaCli('planner.csv', SAME, { arrivalId: "Ari's sheet" })
    }).not.toThrow()
    expect(result.ok).toBe(false)
    expect(result.error).toMatch(/arrival_id/)
    expect(campers()).toEqual([])
  })

  it('writes nothing at all — not the camper, not the run', () => {
    viaCli('planner.csv', SAME, { arrivalId: 'has a space' })
    expect(campers()).toEqual([])
    expect(prefCount()).toBe(0)
    expect(withDb((db) => db.prepare('SELECT COUNT(*) c FROM elective_assignment_runs').get().c)).toBe(0)
  })

  it('MCP refuses the same way', () => {
    const out = viaMcp('planner.csv', SAME, { arrival_id: 'not ok' })
    expect(out.ok).toBe(false)
    expect(out.error).toMatch(/arrival_id/)
    expect(campers()).toEqual([])
  })

  it('an EMPTY arrival is declaring nothing, not a malformed declaration', () => {
    // A caller that passes '' has said nothing, and saying nothing is never refused.
    const result = viaCli('planner.csv', SAME, { arrivalId: '' })
    expect(result.ok).toBe(true)
    expect(campers()).toHaveLength(1)
  })
})
