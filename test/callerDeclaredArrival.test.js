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
// CASE 4 WAS ADDED LATER, closing the second limit T303 recorded at its own close:
// re-importing the same bytes AFTER a director names the subject forked one child
// into two camper rows holding her week twice, and the case-3 residue could not fire
// because it probes for a provisional row the rekey has deleted. The rule restored
// here is not a new one — absent a declaration, identical bytes are ALREADY one
// submission arriving once, and attribution silently stopped that applying. The link
// it converges on was already stored: `attributeElectiveSubject` carries `run_id`
// onto the moved preference rows and that run id is derived from the file's bytes,
// so the lookup is exact rather than a similarity match.
//
//   4. nothing declared, and this submission was already imported AND NAMED
//      -> the answers go to THAT camper, not to a second row, and the caller is TOLD
//
// The declared half of case 4 is deliberately NOT fixed and is asserted as it
// actually behaves: a retry of arrival A and a second child declared as B are
// indistinguishable from content, so it reports instead of guessing. Owner's call.
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
import { attributeSubjectTool, preferenceSheetCommitTool, preferenceSheetPreviewTool } from '../scripts/mcp/tools.js'
import { attributeElectiveSubject } from '../electron/ops/attributeElectiveSubject.js'
import { removeElectivePreference } from '../electron/ops/setElectivePreference.js'
import { appendOp } from '../electron/ops/operations.js'

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
let deviceId

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'shoresh-arrival-'))
  dbPath = path.join(dir, 'shoresh.sqlite')
  const db = openLocalDb(dbPath)
  campId = randomUUID()
  deviceId = randomUUID()
  db.prepare('INSERT INTO camps (id, name, signing_secret) VALUES (?, ?, ?)').run(campId, 'Camp', 'a'.repeat(64))
  db.prepare('INSERT INTO devices (id, name) VALUES (?, ?)').run(deviceId, 'Host')
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

/** The one elective_assignment_runs row by id — T319's name/source_filename checks. */
const runRow = (runId) =>
  withDb((db) => db.prepare('SELECT name, source_filename FROM elective_assignment_runs WHERE id = ?').get(runId))

const indistinguishable = (result) =>
  (result.residue ?? []).filter((r) => r.kind === 'INDISTINGUISHABLE_SUBMISSION')

const alreadyNamed = (result) =>
  (result.residue ?? []).filter((r) => r.kind === 'SUBMISSION_ALREADY_NAMED')

const unresolved = (result) =>
  (result.residue ?? []).filter((r) => r.kind === 'SUBMISSION_ALREADY_NAMED_UNRESOLVED')

/** The one unattributed subject currently awaiting a name. */
const subjectAwaitingName = () =>
  withDb((db) => db.prepare('SELECT id FROM campers WHERE is_unattributed = 1').get())

/** THE DIRECTOR NAMES THE CHILD — the act that used to drop the submission key. */
const nameSubject = (displayName, externalId = null) =>
  withDb((db) =>
    attributeElectiveSubject(db, {
      campId,
      deviceId,
      subjectId: subjectAwaitingName().id,
      displayName,
      externalId,
    })
  )

/**
 * AN ORDINARY ADMIN EDIT to a camper field — NOT through attributeElectiveSubject,
 * which refuses an already-named camper. `campers` is a plain camp-scoped entity
 * (`electron/ops/campScopedEntities.js`) and the generic `write()` IPC handler has no
 * field guard on it, so correcting a child's name or attaching her roster id later is
 * an everyday action that lands here.
 */
const adminEdit = (camperId, field, value) =>
  withDb((db) =>
    appendOp(db, {
      entity: 'campers',
      entity_id: camperId,
      field,
      value,
      author_user_id: null,
      device_id: deviceId,
      client_write_id: randomUUID(),
    })
  )

/** The same act through the REAL MCP handler, so the whole chain is machine-driven. */
const nameSubjectViaMcp = (displayName) =>
  attributeSubjectTool(
    { subject_id: subjectAwaitingName().id, camper_name: displayName },
    { dbPath, allowWrite: true, authorUserId: null, dbKey: null }
  )

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

describe('T319 — the run is named after the import event, never after one arrival\'s file', () => {
  it('CLI: a second byte-identical arrival leaves the run\'s name and source_filename untouched', () => {
    // The scenario the ticket names verbatim: two campers submit byte-identical
    // sheets under different filenames (ari.csv, noa.csv). The run id is
    // content-derived, so both correctly land on ONE elective_assignment_runs row
    // — but before T319 that row's name/source_filename were whichever file
    // arrived LAST. Captured after arrival 1 and compared after arrival 2, so a
    // rename by the second arrival cannot pass unnoticed.
    const first = viaCli('ari.csv', SAME)
    expect(first.ok).toBe(true)
    const afterFirst = runRow(first.runId)
    expect(afterFirst.name).toMatch(/^Import \d{4}-\d{2}-\d{2} \d{2}:\d{2}, 1 sheet$/)
    expect(afterFirst.name).not.toBe('ari.csv')
    expect(afterFirst.name).not.toBe('noa.csv')
    expect(afterFirst.source_filename).toBe('ari.csv')

    const second = viaCli('noa.csv', SAME)
    expect(second.ok).toBe(true)
    expect(second.runId).toBe(first.runId)
    const afterSecond = runRow(second.runId)
    // UNCHANGED — this is the defect. Before the fix, source_filename (and, on a
    // caller that let the default apply, name) becomes 'noa.csv' here.
    expect(afterSecond).toEqual(afterFirst)
    expect(afterSecond.source_filename).toBe('ari.csv')
    expect(afterSecond.source_filename).not.toBe('noa.csv')
  })

  it('CLI: an explicit --name still wins over the import-event default', () => {
    const out = viaCli('ari.csv', SAME, { runName: 'Week 3 archery cohort' })
    expect(out.ok).toBe(true)
    expect(runRow(out.runId).name).toBe('Week 3 archery cohort')
  })

  it('MCP: an explicit run_name still wins over the import-event default', () => {
    const out = viaMcp('ari.csv', SAME, { run_name: 'Week 3 archery cohort' })
    expect(out.ok).toBe(true)
    expect(runRow(out.runId).name).toBe('Week 3 archery cohort')
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

describe('T303 case 4 — re-importing a NAMED submission lands on that camper, not a second row', () => {
  // EVERY ASSERTION HERE IS ON ROWS. The defect this closes returned ok=true with a
  // residue list that looked ordinary, so a test reading messages would have passed
  // over it: what was wrong was two camper rows and eight preference rows where
  // there should have been one and four.
  const nameHer = 'Aviva Feldspar'

  it('CLI: the same bytes after naming go to her, not to a new subject', () => {
    viaCli('ari.csv', SAME)
    expect(nameSubject(nameHer)).toMatchObject({ ok: true, rekeyed: true })

    const again = viaCli('ari.csv', SAME)
    expect(again.ok).toBe(true)

    const rows = campers()
    expect(rows).toHaveLength(1)
    expect(rows[0].display_name).toBe(nameHer)
    // Still named, not dragged back to provisional by the second import.
    expect(rows[0].is_unattributed).toBeNull()
    // Her week is stored ONCE. Eight rows here was the defect.
    expectWholeWeekEach(rows)
    expect(alreadyNamed(again)).toHaveLength(1)
    expect(alreadyNamed(again)[0]).toMatchObject({ camper_id: rows[0].id, camper_name: nameHer })
  })

  it('CLI: a THIRD import of the same bytes still converges — this is idempotent, not one-shot', () => {
    viaCli('ari.csv', SAME)
    nameSubject(nameHer)
    viaCli('ari.csv', SAME)
    viaCli('ari.csv', SAME)

    expect(campers()).toHaveLength(1)
    expect(prefCount()).toBe(4)
  })

  it('MCP: preference_sheet_commit converges the same way', () => {
    viaMcp('ari.csv', SAME)
    nameSubject(nameHer)

    const again = viaMcp('ari.csv', SAME)
    expect(again.ok).toBe(true)
    const rows = campers()
    expect(rows).toHaveLength(1)
    expect(rows[0].display_name).toBe(nameHer)
    expectWholeWeekEach(rows)
  })

  it('MCP: naming through the real attribute tool, then re-importing, converges end to end', () => {
    // The whole chain machine-driven — no direct call into the ops layer anywhere.
    viaMcp('ari.csv', SAME)
    expect(nameSubjectViaMcp(nameHer)).toMatchObject({ ok: true, rekeyed: true })

    expect(viaMcp('ari.csv', SAME).ok).toBe(true)
    expect(campers()).toHaveLength(1)
    expect(prefCount()).toBe(4)
  })

  it('MCP: a preview SAYS so before anything is written', () => {
    viaCli('ari.csv', SAME)
    nameSubject(nameHer)

    const preview = previewViaMcp('ari.csv', SAME)
    expect(preview.ok).toBe(true)
    expect(alreadyNamed(preview)).toHaveLength(1)
    // A preview is a read. Nothing moved.
    expect(campers()).toHaveLength(1)
    expect(prefCount()).toBe(4)
  })

  it('carries her ROSTER id across, so a camper named with an external_id converges too', () => {
    // NON-VACUITY ON THE ID ARM. A named camper's id comes from deriveCamperId's
    // `ext` arm when she has a roster id and its `name` arm when she does not.
    // Converging re-derives that id, so passing her name WITHOUT her external_id
    // would derive a DIFFERENT id and fork her — silently, and only for campers who
    // have a roster id, which is the half a name-only test never reaches.
    viaCli('ari.csv', SAME)
    expect(nameSubject(nameHer, 'roster-4417')).toMatchObject({ ok: true })

    expect(viaCli('ari.csv', SAME).ok).toBe(true)
    const rows = campers()
    expect(rows).toHaveLength(1)
    expect(rows[0].display_name).toBe(nameHer)
    expectWholeWeekEach(rows)
  })

  it('a director EDIT survives the convergence — her correction is not overwritten', () => {
    // Converging writes into a camper who already has rows, which is exactly where a
    // hand-edit could be silently undone by an import reporting success.
    viaCli('ari.csv', SAME)
    nameSubject(nameHer)
    const her = campers()[0]

    const runId = withDb((db) => db.prepare('SELECT id FROM elective_assignment_runs').get().id)
    const one = withDb((db) =>
      db.prepare('SELECT id FROM elective_preferences WHERE camper_id = ? LIMIT 1').get(her.id)
    )
    expect(
      withDb((db) => removeElectivePreference(db, { runId, preferenceId: one.id, deviceId }))
    ).toEqual({ ok: true })
    expect(prefCount()).toBe(3)

    expect(viaCli('ari.csv', SAME).ok).toBe(true)

    // THREE, not four: the removed row stays removed. Four would mean the import
    // restored a choice the director had deliberately taken away.
    expect(campers()).toHaveLength(1)
    expect(prefCount()).toBe(3)
  })

  it('a genuinely DIFFERENT child after naming is still her own camper', () => {
    // NON-VACUITY: the probe must key on THIS submission's bytes, not fire for every
    // import that happens after somebody was named.
    viaCli('ari.csv', SAME)
    nameSubject(nameHer)

    const other = viaCli('noa.csv', OTHER)
    expect(other.ok).toBe(true)
    expect(alreadyNamed(other)).toEqual([])
    const rows = campers()
    expect(rows).toHaveLength(2)
    expectWholeWeekEach(rows)
  })

  it('an UNNAMED match is still T303 case 3, untouched', () => {
    // The two residues must not collide. While the subject is unattributed the old
    // INDISTINGUISHABLE_SUBMISSION owns the case; only a NAMED subject is case 4.
    viaCli('ari.csv', SAME)
    const again = viaCli('noa.csv', SAME)

    expect(indistinguishable(again)).toHaveLength(1)
    expect(alreadyNamed(again)).toEqual([])
    expect(campers()).toHaveLength(1)
    expect(prefCount()).toBe(4)
  })

  it('never reports on a FIRST import of bytes nobody has sent before', () => {
    const first = viaCli('ari.csv', SAME)
    expect(alreadyNamed(first)).toEqual([])
    expect(unresolved(first)).toEqual([])
  })
})

describe('T303 case 4 — her id is CARRIED, so an ordinary admin edit cannot fork her', () => {
  // RED HAT FOUND THIS, and it is worse than the defect case 4 fixes. The first cut
  // re-DERIVED her id from `display_name` and `external_id`. Both are ordinary
  // admin-writable columns, and `deriveCamperId` branches on whether `external_id`
  // is set — so an everyday edit moved her between its `name` and `ext` arms, the
  // recipe returned an id she does not have, and the import minted a SECOND fully
  // named row holding her week twice. Neither row flagged `is_unattributed`, both
  // reading the same name, while the residue claimed the answers had reached her.
  // A confidently wrong success message, not silence.
  const nameHer = 'Aviva Feldspar'

  it('a roster id attached AFTER naming does not fork her, and is not cleared', () => {
    viaCli('ari.csv', SAME)
    nameSubject(nameHer)
    const her = campers()[0]
    // She was named in `name` mode; this moves the recipe to `ext` mode.
    adminEdit(her.id, 'external_id', 'roster-9999')

    expect(viaCli('ari.csv', SAME).ok).toBe(true)

    const rows = campers()
    expect(rows).toHaveLength(1)
    expect(rows[0].id).toBe(her.id)
    expectWholeWeekEach(rows)
    // The import writes external_id onto the record, so dropping it from the
    // converged subject would CLEAR a real roster id rather than fork her — the
    // opposite failure, and equally silent.
    expect(withDb((db) => db.prepare('SELECT external_id FROM campers WHERE id = ?').get(her.id)))
      .toEqual({ external_id: 'roster-9999' })
  })

  it('a corrected spelling of her name does not fork her, and the correction stands', () => {
    viaCli('ari.csv', SAME)
    nameSubject(nameHer)
    const her = campers()[0]
    adminEdit(her.id, 'display_name', 'Aviva R. Feldspar')

    expect(viaCli('ari.csv', SAME).ok).toBe(true)

    const rows = campers()
    expect(rows).toHaveLength(1)
    expect(rows[0].id).toBe(her.id)
    // The import must not write the OLD spelling back over the director's fix.
    expect(rows[0].display_name).toBe('Aviva R. Feldspar')
    expectWholeWeekEach(rows)
  })

  it('a roster id CLEARED after naming does not fork her either', () => {
    // The reverse flip, ext -> name, which the two above do not cover.
    viaCli('ari.csv', SAME)
    nameSubject(nameHer, 'roster-9999')
    const her = campers()[0]
    adminEdit(her.id, 'external_id', null)

    expect(viaCli('ari.csv', SAME).ok).toBe(true)

    const rows = campers()
    expect(rows).toHaveLength(1)
    expect(rows[0].id).toBe(her.id)
    expectWholeWeekEach(rows)
  })

  it('the residue never claims her when the answers did not reach her', () => {
    // NON-VACUITY ON THE MESSAGE, which is the part that made the first cut
    // dangerous: it reported SUBMISSION_ALREADY_NAMED while forking. If the
    // convergence ever misses again, the camper_id it names must not exist as a
    // camper holding nothing.
    viaCli('ari.csv', SAME)
    nameSubject(nameHer)
    adminEdit(campers()[0].id, 'external_id', 'roster-9999')

    const again = viaCli('ari.csv', SAME)
    const told = alreadyNamed(again)
    expect(told).toHaveLength(1)

    // THE CLAIM, CHECKED AS THE CLAIM: "these answers went to THAT camper rather
    // than to a new subject" is true only if the camper it names is the ONLY holder
    // of this submission's rows. Counting rows under her id alone is NOT enough and
    // was vacuous when first written — under the planted defect her own four rows
    // are still there beside the fork's four, so the count passed while the message
    // was false. The distinguishing fact is how many campers hold the run.
    const holders = withDb((db) =>
      db
        .prepare('SELECT DISTINCT camper_id FROM elective_preferences WHERE run_id = ?')
        .all(again.runId)
        .map((r) => r.camper_id)
    )
    expect(holders).toEqual([told[0].camper_id])
  })
})

describe('T303 case 4 — the two cases content cannot settle are REPORTED, not guessed', () => {
  it('a declared retry after naming still forks — the stated limit, and it says so', () => {
    // NOT FIXED, ASSERTED AS IT BEHAVES. A retry of arrival A and a second child
    // declared as B produce identical bytes, an identical run id and an identical
    // probe result. Converging would merge two real children; separating them needs
    // the arrival stored, which is a schema version the owner chose not to spend.
    // So this test pins the LIMIT, and pins that it is no longer silent.
    viaCli('ari.csv', SAME, { arrivalId: 'A' })
    nameSubject('Aviva Feldspar')

    const retry = viaCli('ari.csv', SAME, { arrivalId: 'A' })
    expect(retry.ok).toBe(true)
    expect(campers()).toHaveLength(2)
    expect(prefCount()).toBe(8)
    // The whole point of recording it: before this change the fork was silent.
    expect(unresolved(retry)).toHaveLength(1)
    expect(unresolved(retry)[0]).toMatchObject({ arrival_id: 'A' })
    expect(alreadyNamed(retry)).toEqual([])
  })

  it('a SECOND CHILD declared apart is never merged onto the first, even after naming', () => {
    // THE REASON THE DECLARED PATH DOES NOT CONVERGE, stated as a child rather than
    // as a guard. Two children pick the same activities; the first is named; the
    // second's sheet is byte-identical and the caller declares it apart. Converging
    // on the content probe here would put the second child's week onto the first
    // child's record and delete her from the camp — the one refusal the ADR names,
    // happening silently with ok=true.
    viaCli('ari.csv', SAME, { arrivalId: 'zz-first' })
    nameSubject('Aviva Feldspar')

    const second = viaCli('noa.csv', SAME, { arrivalId: 'aa-second' })
    expect(second.ok).toBe(true)

    // TWO children, each with her own whole week. One row here is a merge.
    const rows = campers()
    expect(rows).toHaveLength(2)
    expectWholeWeekEach(rows)
    expect(rows.map((r) => r.display_name).sort()).toEqual(['Aviva Feldspar', 'noa'])
    expect(alreadyNamed(second)).toEqual([])
  })

  it('two named campers holding one submission is ambiguous, so nothing is guessed', () => {
    // Arrival tokens anti-sorted: 'zz' imports FIRST, 'aa' second, so nothing below
    // can pass by a lucky alphabetical order.
    viaCli('ari.csv', SAME, { arrivalId: 'zz-first' })
    nameSubject('Aviva Feldspar')
    viaCli('noa.csv', SAME, { arrivalId: 'aa-second' })
    nameSubject('Ben Quartzite')
    expect(campers()).toHaveLength(2)

    const undeclared = viaCli('ari.csv', SAME)
    expect(undeclared.ok).toBe(true)
    // It did NOT pick one of them.
    expect(alreadyNamed(undeclared)).toEqual([])
    expect(unresolved(undeclared)).toHaveLength(1)
    expect(unresolved(undeclared)[0].camper_ids).toHaveLength(2)
    const rows = campers()
    expect(rows).toHaveLength(3)
    expect(rows.filter((r) => r.is_unattributed === 1)).toHaveLength(1)
  })
})
