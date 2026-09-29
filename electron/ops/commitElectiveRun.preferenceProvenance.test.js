// T297 — what happens to a director's correction when the file is imported
// again. Fixtures are fabricated; no real camper data is in this repo and none
// may be added.
//
// THE DECISION UNDER TEST: preserve the edit, and say so. The three rejected
// alternatives are named in commitElectiveRun.js's own comment; what matters
// here is that neither silent direction is possible — the row survives AND the
// disagreement is reported.
//
// Every case re-imports the SAME parsed sheet against the SAME runId, which is
// exactly what a director gets by re-running an import of the file they already
// have (T285 keys a submission by content hash, so the identical file is the
// same submission and lands on the same run). That is the realistic hazard: a
// CORRECTED file is a different submission and a different run, so it cannot
// clobber anything.
import { describe, it, expect, afterEach } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { openLocalDb } from '../db/localDb.js'
import { commitElectiveRun } from './commitElectiveRun.js'
import { setElectivePreference, removeElectivePreference } from './setElectivePreference.js'
import { attributeElectiveSubject } from './attributeElectiveSubject.js'
import { isHumanOwned } from './fieldProvenance.js'
import { deriveElectiveChoiceId } from './electiveDerivedIds.js'

const dirs = []
function freshDb() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'shoresh-prefprov-'))
  dirs.push(dir)
  const db = openLocalDb(path.join(dir, 'shoresh.sqlite'))
  const campId = randomUUID()
  db.prepare('INSERT INTO camps (id, name, signing_secret) VALUES (?, ?, ?)').run(campId, 'Camp Test', 'a'.repeat(64))
  db.prepare('INSERT INTO devices (id, name) VALUES (?, ?)').run('dev-1', 'Host')
  db.prepare('INSERT INTO elective_sets (id, camp_id, name) VALUES (?, ?, ?)').run('set-1', campId, 'Electives')
  db.prepare('INSERT INTO days_of_operation (id, camp_id, label) VALUES (?, ?, ?)').run('day-mon', campId, 'Monday')
  db.prepare('INSERT INTO time_blocks (id, camp_id, name) VALUES (?, ?, ?)').run('tb-1', campId, 'Period 1')
  return { db, campId }
}
afterEach(() => {
  for (const d of dirs) fs.rmSync(d, { recursive: true, force: true })
  dirs.length = 0
})

// A planner grid, written the way a child writes one.
const PARSED = {
  campers: [
    { id: 'cam-1', display_name: 'Ari Green', external_id: null },
    { id: 'cam-2', display_name: 'Noa Katz', external_id: 'CM-2' },
  ],
  choices: [
    { label: 'Gaga', labelKey: 'gaga' },
    { label: 'Ceramics', labelKey: 'ceramics' },
  ],
  preferences: [
    { camper_id: 'cam-1', occurrence_id: null, coordinate: { dayName: 'monday', periodLabel: '1' }, label: 'Gaga', labelKey: 'gaga', rank: 1, rank_kind: 'cell-choice' },
    { camper_id: 'cam-2', occurrence_id: null, coordinate: { dayName: 'monday', periodLabel: '1' }, label: 'Ceramics', labelKey: 'ceramics', rank: 1, rank_kind: 'cell-choice' },
  ],
  sameNameCampers: [],
  skippedRows: [],
}
const OCCURRENCES = [
  { id: 'occ-a', elective_set_id: 'set-1', day_id: 'day-mon', time_block_id: 'tb-1', tier_id: 'tier-1' },
]
const ASSIGNMENTS = [
  { camper_id: 'cam-1', occurrence_id: 'occ-a', labelKey: 'gaga', activity_id: 'act-gaga', preference_rank: 1 },
  { camper_id: 'cam-2', occurrence_id: 'occ-a', labelKey: 'ceramics', activity_id: 'act-ceramics', preference_rank: 1 },
]

const importSheet = (db, campId, runId) =>
  commitElectiveRun(db, {
    campId, deviceId: 'dev-1', name: 'Week 1 electives', runId,
    parsed: PARSED, assignments: ASSIGNMENTS, occurrences: OCCURRENCES,
  })

const prefsFor = (db, runId, camperId) =>
  db.prepare('SELECT * FROM elective_preferences WHERE run_id = ? AND camper_id = ?').all(runId, camperId)

const held = (out) => out.findings.filter((f) => f.kind === 'PREFERENCE_EDIT_HELD')

describe('re-importing a sheet over an edited preference', () => {
  it('does not restore the row the director removed, and says the removal stands', () => {
    const { db, campId } = freshDb()
    const runId = randomUUID()
    expect(importSheet(db, campId, runId)).toMatchObject({ ok: true })

    const imported = prefsFor(db, runId, 'cam-1')[0]
    expect(removeElectivePreference(db, { runId, preferenceId: imported.id, deviceId: 'dev-1' }))
      .toEqual({ ok: true })

    const again = importSheet(db, campId, runId)
    expect(again).toMatchObject({ ok: true })

    // THE ASSERTION: the removed preference is still gone. A restored row would
    // be the director's decision undone by an action that reported success.
    expect(prefsFor(db, runId, 'cam-1')).toHaveLength(0)
    // AND IT IS NOT SILENT. Preserving without reporting is the same loss in the
    // other direction: the import says "done" while declining to apply the file.
    expect(held(again)).toEqual([
      expect.objectContaining({ kind: 'PREFERENCE_EDIT_HELD', camper_id: 'cam-1', reason: 'removed' }),
    ])
    // cam-2 never edited anything, so the file owns their row and it is absent
    // from the report.
    expect(held(again).some((f) => f.camper_id === 'cam-2')).toBe(false)
  })

  it('does not re-create the coordinate row an edit superseded, so the cell keeps holding ONE choice', () => {
    const { db, campId } = freshDb()
    const runId = randomUUID()
    expect(importSheet(db, campId, runId)).toMatchObject({ ok: true })

    // The director changes cam-1's Monday/Period 1 cell from Gaga to Ceramics.
    const edit = setElectivePreference(db, {
      runId, camperId: 'cam-1', occurrenceId: 'occ-a',
      choiceId: deriveElectiveChoiceId(runId, 'ceramics'),
      rank: 1, rankKind: 'cell-choice', deviceId: 'dev-1',
    })
    expect(edit).toMatchObject({ ok: true })
    expect(prefsFor(db, runId, 'cam-1')).toHaveLength(1)

    const again = importSheet(db, campId, runId)
    expect(again).toMatchObject({ ok: true })

    // THE ASSERTION THAT MATTERS, and the one a naive implementation fails.
    // The edit wrote its row under the `occ` arm of deriveElectivePreferenceId
    // while the import writes the `at` (coordinate) arm — DIFFERENT ids — so a
    // field-level provenance gate alone never sees a collision and happily
    // re-creates the Gaga row. The cell would then hold two rank-1 choices and
    // the correction would merely TIE with the value being corrected.
    const after = prefsFor(db, runId, 'cam-1')
    expect(after).toHaveLength(1)
    expect(after[0].choice_id).toBe(deriveElectiveChoiceId(runId, 'ceramics'))
    expect(held(again)).toEqual([
      expect.objectContaining({ camper_id: 'cam-1', reason: 'removed' }),
    ])
  })

  // NAMING A SUBJECT MUST NOT INVENT CORRECTIONS. A rekey re-derives every
  // preference id, so the moved rows are new records with fresh op histories —
  // and an unstamped write reads back as hand-edited, because appendOp defaults
  // `source` to null and isHumanOwned decodes null as human. Before the import
  // stamp existed that was inert; afterwards it would silently relabel a whole
  // imported sheet as the director's own work, and the next import of the same
  // file would hold every row and claim the director had edited it.
  it('carries provenance across a subject rekey, in both directions', () => {
    const { db, campId } = freshDb()
    const runId = randomUUID()
    // cam-2's sheet arrived without a name, so it is a provisional subject.
    db.prepare('UPDATE campers SET is_unattributed = 1 WHERE id = ?').run('cam-2')
    expect(importSheet(db, campId, runId)).toMatchObject({ ok: true })
    db.prepare('UPDATE campers SET is_unattributed = 1 WHERE id = ?').run('cam-2')

    // One of this subject's two answers is hand-corrected; the other is the file's.
    const rows = prefsFor(db, runId, 'cam-2')
    expect(rows).toHaveLength(1)
    const edited = setElectivePreference(db, {
      runId, camperId: 'cam-2', occurrenceId: 'occ-a',
      choiceId: deriveElectiveChoiceId(runId, 'gaga'),
      rank: 1, rankKind: 'cell-choice', replacesPreferenceId: rows[0].id, deviceId: 'dev-1',
    })
    expect(edited).toMatchObject({ ok: true })
    expect(isHumanOwned(db, 'elective_preferences', edited.preferenceId, 'choice_id')).toBe(true)

    const out = attributeElectiveSubject(db, {
      campId, deviceId: 'dev-1', subjectId: 'cam-2',
      displayName: 'Testcamper Bravo', externalId: null,
    })
    expect(out).toMatchObject({ ok: true })

    // The correction is STILL a correction after the move.
    const moved = db
      .prepare('SELECT * FROM elective_preferences WHERE run_id = ? AND camper_id = ?')
      .all(runId, out.camperId)
    expect(moved).toHaveLength(1)
    expect(isHumanOwned(db, 'elective_preferences', moved[0].id, 'choice_id')).toBe(true)

    // And the OTHER direction, which is the one this guards: cam-1 never edited
    // anything, so their moved rows must still belong to the file.
    db.prepare('UPDATE campers SET is_unattributed = 1 WHERE id = ?').run('cam-1')
    const out1 = attributeElectiveSubject(db, {
      campId, deviceId: 'dev-1', subjectId: 'cam-1',
      displayName: 'Testcamper Alpha', externalId: null,
    })
    expect(out1).toMatchObject({ ok: true })
    const moved1 = db
      .prepare('SELECT * FROM elective_preferences WHERE run_id = ? AND camper_id = ?')
      .all(runId, out1.camperId)
    expect(moved1.length).toBeGreaterThan(0)
    for (const r of moved1) {
      expect(isHumanOwned(db, 'elective_preferences', r.id, 'choice_id')).toBe(false)
    }
  })

  it('leaves an untouched imported preference fully owned by the file', () => {
    const { db, campId } = freshDb()
    const runId = randomUUID()
    expect(importSheet(db, campId, runId)).toMatchObject({ ok: true })
    const before = prefsFor(db, runId, 'cam-2')[0]

    // A DIFFERENT sheet for the same submission: cam-2's cell now names Gaga.
    // Nobody hand-edited it, so the file must win outright and nothing is held —
    // a marker that froze every row would be as broken as no marker at all.
    const out = commitElectiveRun(db, {
      campId, deviceId: 'dev-1', name: 'Week 1 electives', runId,
      parsed: {
        ...PARSED,
        preferences: [
          PARSED.preferences[0],
          { ...PARSED.preferences[1], label: 'Gaga', labelKey: 'gaga' },
        ],
      },
      assignments: ASSIGNMENTS, occurrences: OCCURRENCES,
    })
    expect(out).toMatchObject({ ok: true })
    expect(held(out)).toEqual([])

    const rows = prefsFor(db, runId, 'cam-2')
    expect(rows.some((r) => r.choice_id === deriveElectiveChoiceId(runId, 'gaga'))).toBe(true)
    expect(before.choice_id).toBe(deriveElectiveChoiceId(runId, 'ceramics'))
  })
})
