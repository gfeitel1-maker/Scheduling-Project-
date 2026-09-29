// @vitest-environment node
//
// T285 — THE IDENTITY KEY for an unattributed grid subject.
//
// THE DEFECT, reproduced by execution before anything was written. A planner grid
// is one camper's own sheet and carries no name column, so the reader falls back
// to the filename for a provisional subject — and `deriveCamperId` keys on the
// canonicalized display name. Two children whose portal exported each of their
// planners as the ordinary basename `planner.csv`, imported in sequence into one
// camp:
//
//   campers: [{ display_name: 'planner', is_unattributed: 1 }]   <- ONE row
//   elective_preferences: 8                                       <- TWO children
//   Monday Period 1  -> Swim, Gaga        (two rank-1 cell choices, one coordinate)
//   Monday Period 2  -> Ceramics, Archery
//   Tuesday Period 1 -> Archery, Drama
//   Tuesday Period 2 -> Nature, Swim
//
// ok=true both times, no refusal, no collision residue. `hasContradictoryRanks`
// and the parse-level collision pass run PER IMPORT and structurally cannot see
// across two. **That is the "merge two real children" case the ADR names as the
// ONLY legitimate refusal, happening silently, on the default path.** The converse
// also holds: one child's file renamed forks them into two campers.
//
// THE FIX IS THREE PARTS AND ALL THREE ARE LOAD-BEARING. Keying per submission
// alone turns the merge into a fork the moment somebody names the child, because a
// caller-supplied name derives a different id and leaves the provisional row behind
// holding the preferences — and a forked pair is WORSE than a merged row, because a
// merged row is visibly wrong while both halves of a fork look correct.
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { randomUUID } from 'node:crypto'

import { openLocalDb } from '../electron/db/localDb.js'
import { runPreferenceSheetCli } from '../scripts/preferenceSheetCli.js'
import { attributeElectiveSubject } from '../electron/ops/attributeElectiveSubject.js'
import { deriveCamperId } from '../electron/ops/electiveDerivedIds.js'
import { buildStructureIssues } from '../src/ingest/attentionList.js'

const ACTIVITIES = ['Swim', 'Archery', 'Ceramics', 'Nature', 'Gaga', 'Drama']

// Two DIFFERENT children's planners. Same geometry, different answers — so a merge
// is detectable by content, not only by row count.
const AVIVA = 'Period,Monday,Tuesday\nPeriod 1,Swim,Archery\nPeriod 2,Ceramics,Nature\n'
const BEN = 'Period,Monday,Tuesday\nPeriod 1,Gaga,Drama\nPeriod 2,Archery,Swim\n'

let dir
let dbPath
let campId
let deviceId

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'shoresh-identity-'))
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

/** Import `content` under `basename`, from its own directory so the name can repeat. */
function importAs(basename, content, options = {}) {
  const sub = fs.mkdtempSync(path.join(dir, 'sub-'))
  const file = path.join(sub, basename)
  fs.writeFileSync(file, content)
  return runPreferenceSheetCli({ file, dbPath, action: 'commit', ...options })
}

const campers = () =>
  withDb((db) => db.prepare('SELECT id, display_name, is_unattributed FROM campers ORDER BY id').all())

const prefRows = (camperId) =>
  withDb((db) =>
    db
      .prepare(
        `SELECT p.coordinate_day_label AS day, p.coordinate_period_label AS period, ch.label
           FROM elective_preferences p
           JOIN elective_choices ch ON ch.id = p.choice_id
          WHERE p.camper_id = ?
          ORDER BY p.coordinate_day_label, p.coordinate_period_label`
      )
      .all(camperId)
  )

describe('an unattributed subject is keyed per SUBMISSION, not per filename', () => {
  it('two DIFFERENT sheets with the SAME basename are TWO subjects, never merged', () => {
    // THE DEFECT. This is the "merge two real children" case, and it must never be
    // reachable silently — least of all on the default path.
    const a = importAs('planner.csv', AVIVA)
    const b = importAs('planner.csv', BEN)
    expect(a.ok).toBe(true)
    expect(b.ok).toBe(true)

    const rows = campers()
    expect(rows).toHaveLength(2)
    expect(new Set(rows.map((r) => r.id)).size).toBe(2)
    for (const r of rows) expect(r.is_unattributed).toBe(1)

    // And each subject holds only ITS OWN child's answers. Counting rows is not
    // enough: a merge would also be visible as two answers at one coordinate.
    for (const r of rows) {
      const mine = prefRows(r.id)
      expect(mine).toHaveLength(4)
      const coordinates = mine.map((m) => `${m.day}|${m.period}`)
      expect(new Set(coordinates).size).toBe(4) // no coordinate holds two answers
    }

    // The two subjects' Monday-Period-1 answers differ, which is what proves they
    // are two children and not one row read twice.
    const mondays = rows.map((r) => prefRows(r.id).find((m) => m.day === 'Monday' && m.period === 'Period 1').label)
    expect(new Set(mondays)).toEqual(new Set(['Swim', 'Gaga']))
  })

  it('the SAME file imported twice is ONE subject, converged, with no duplicate rows', () => {
    // The other half of the key's contract, and the reason the key is the CONTENT
    // hash rather than something per-run: re-sending one submission is an
    // idempotent retry, not a second child.
    const first = importAs('planner.csv', AVIVA)
    const second = importAs('planner.csv', AVIVA)
    expect(first.ok).toBe(true)
    expect(second.ok).toBe(true)

    expect(campers()).toHaveLength(1)
    expect(withDb((db) => db.prepare('SELECT COUNT(*) c FROM elective_preferences').get().c)).toBe(4)
  })

  // T303 — WAS A KNOWN LIMIT, NOW THE DOCUMENTED DEFAULT. Deliberately changed, and
  // the change is in the SECOND assertion rather than the first.
  //
  // What T299 pinned here: two DIFFERENT children whose planners happen to be
  // byte-identical (both picked archery and swim) land as ONE subject on this path,
  // because the CLI derives its arrival from the file's bytes so an agent retrying
  // after an ambiguous MCP timeout converges rather than duplicating. That row count
  // is UNCHANGED and must stay unchanged: never say no at the machine interface, so a
  // caller that declares nothing is not refused and its behaviour does not move.
  //
  // What T303 changed: the merge is no longer SILENT. The caller is told the two
  // submissions could not be told apart, and told how to say they are two — which is
  // the whole difference between a limit and a default. An agent that can see the
  // collision re-calls with explicit arrivals; an agent that cannot has lost a
  // child's answers and will never know.
  //
  // A caller that DOES declare gets two subjects, and the retry stays idempotent.
  // Both halves are asserted on camper rows in test/callerDeclaredArrival.test.js
  // through the CLI core and the MCP tools alike; this file keeps the no-declaration
  // case, where it has always lived.
  it('two children with byte-identical planners are ONE subject when nothing declares otherwise', () => {
    const a = importAs('ari.csv', AVIVA)
    const b = importAs('noa.csv', AVIVA)
    expect(a.ok).toBe(true)
    expect(b.ok).toBe(true)
    expect(campers()).toHaveLength(1)

    // AND THE SECOND SUBMISSION IS TOLD, which the first cannot be — there was
    // nothing to collide with yet. That asymmetry is what makes this non-vacuous.
    const kinds = (r) => (r.residue ?? []).filter((x) => x.kind === 'INDISTINGUISHABLE_SUBMISSION')
    expect(kinds(a)).toEqual([])
    expect(kinds(b)).toHaveLength(1)
    expect(kinds(b)[0].message).toMatch(/arrival_id/)
  })

  it('a renamed file is still ONE subject — the filename is a LABEL, not the key', () => {
    // The converse defect: keying on the filename forks one child in two the moment
    // the file is renamed. The bytes are what identify the submission.
    importAs('planner.csv', AVIVA)
    importAs('aviva-planner-final.csv', AVIVA)
    expect(campers()).toHaveLength(1)
  })

  it('the filename is still shown, so a director recognises the submission', () => {
    // Keying per submission must not cost the human-readable label.
    const result = importAs('aviva-planner.csv', AVIVA)
    expect(result.ok).toBe(true)
    expect(campers()[0].display_name).toBe('aviva-planner')
  })
})

describe('attribution REKEYS onto the canonical id', () => {
  it('lands on exactly the id a normal import of that name produces', () => {
    // THE PART THAT STOPS A MERGE BUG BECOMING A FORK BUG. If attribution minted a
    // new record instead, the provisional row would keep `is_unattributed = 1` and
    // its preferences forever, and both halves would look correct.
    importAs('planner.csv', AVIVA)
    const provisional = campers()[0]

    const out = withDb((db) =>
      attributeElectiveSubject(db, {
        campId,
        deviceId,
        subjectId: provisional.id,
        displayName: 'Aviva Feldspar',
      })
    )
    expect(out.ok).toBe(true)

    const expectedId = deriveCamperId(campId, { externalId: null, displayName: 'Aviva Feldspar' })
    const rows = campers()
    expect(rows).toHaveLength(1)
    expect(rows[0].id).toBe(expectedId)
    expect(rows[0].display_name).toBe('Aviva Feldspar')
    // The flag is CLEARED, not merely ignored.
    expect(rows[0].is_unattributed).toBeNull()
  })

  it('a later ordinary import of that name lands on the SAME row', () => {
    // The point of matching deriveCamperId: the child is now findable by name, so a
    // roster import or a named preference sheet converges instead of forking.
    importAs('planner.csv', AVIVA)
    const provisional = campers()[0]
    withDb((db) =>
      attributeElectiveSubject(db, { campId, deviceId, subjectId: provisional.id, displayName: 'Aviva Feldspar' })
    )

    importAs('named.csv', 'Camper Name,#1,#2\nAviva Feldspar,Swim,Archery\n')
    expect(campers()).toHaveLength(1)
  })

  it('moves the preferences — asserted by COUNT and by COORDINATE', () => {
    // "The camper exists under the new id" is not enough. The preferences are the
    // thing that must not be orphaned, and their coordinates are what make them
    // per-cell answers rather than an undifferentiated pile.
    importAs('planner.csv', AVIVA)
    const provisional = campers()[0]
    const before = prefRows(provisional.id)
    expect(before).toHaveLength(4)

    withDb((db) =>
      attributeElectiveSubject(db, { campId, deviceId, subjectId: provisional.id, displayName: 'Aviva Feldspar' })
    )

    const newId = deriveCamperId(campId, { externalId: null, displayName: 'Aviva Feldspar' })
    const after = prefRows(newId)
    expect(after).toEqual(before) // same coordinates, same labels, nothing lost
    // Nothing left behind under the old id, and no total change.
    expect(prefRows(provisional.id)).toEqual([])
    expect(withDb((db) => db.prepare('SELECT COUNT(*) c FROM elective_preferences').get().c)).toBe(4)
  })

  it('refuses to attribute a camper who is not an unattributed subject', () => {
    // An ordinary named camper is not a subject awaiting a name, and renaming one
    // through this path would re-key a real child's identity as a side effect.
    importAs('named.csv', 'Camper Name,#1,#2\nAviva Feldspar,Swim,Archery\n')
    const real = campers()[0]
    const out = withDb((db) =>
      attributeElectiveSubject(db, { campId, deviceId, subjectId: real.id, displayName: 'Someone Else' })
    )
    expect(out.ok).toBe(false)
    expect(out.error).toMatch(/not an unattributed/i)
    expect(campers()[0].display_name).toBe('Aviva Feldspar')
  })

  it('attributing the two same-basename subjects separates them by name', () => {
    // End to end: the merge that used to happen silently is now two subjects, and
    // naming them gives two real children with their own answers.
    importAs('planner.csv', AVIVA)
    importAs('planner.csv', BEN)
    const [one, two] = campers()

    withDb((db) => {
      attributeElectiveSubject(db, { campId, deviceId, subjectId: one.id, displayName: 'Aviva Feldspar' })
      attributeElectiveSubject(db, { campId, deviceId, subjectId: two.id, displayName: 'Ben Quartzite' })
    })

    const rows = campers()
    expect(rows).toHaveLength(2)
    expect(rows.map((r) => r.display_name).sort()).toEqual(['Aviva Feldspar', 'Ben Quartzite'])
    for (const r of rows) {
      expect(r.is_unattributed).toBeNull()
      expect(prefRows(r.id)).toHaveLength(4)
    }
  })
})

describe('an unattributed subject is in the ATTENTION SURFACE', () => {
  // Owner ruling: it goes in the existing "Needs your attention" vocabulary, not a
  // bespoke screen and not a banner. Same list for a director and for an agent.
  const issuesFor = () =>
    buildStructureIssues({
      tiers: [{ id: 't' }],
      groups: [],
      days_of_operation: [{ id: 'd' }],
      time_blocks: [{ id: 'b' }],
      activities: [{ id: 'a', name: 'Swim' }],
      campers: withDb((db) => db.prepare('SELECT id, display_name, is_unattributed FROM campers').all()),
    })

  it('appears, named by its label, with a why a director can act on', () => {
    importAs('planner.csv', AVIVA)
    const items = issuesFor().filter((i) => i.sourceKind === 'unattributed-camper')
    expect(items).toHaveLength(1)
    expect(items[0].name).toBe('planner')
    expect(items[0].why).toMatch(/who/i)
    expect(items[0].id).toContain(campers()[0].id)
  })

  it('leaves the surface once attributed', () => {
    importAs('planner.csv', AVIVA)
    const provisional = campers()[0]
    withDb((db) =>
      attributeElectiveSubject(db, { campId, deviceId, subjectId: provisional.id, displayName: 'Aviva Feldspar' })
    )
    expect(issuesFor().filter((i) => i.sourceKind === 'unattributed-camper')).toEqual([])
  })

  it('an ordinary named camper never appears there', () => {
    // Non-vacuity: the reader must key on the FLAG, not on every camper.
    importAs('named.csv', 'Camper Name,#1,#2\nAviva Feldspar,Swim,Archery\n')
    expect(issuesFor().filter((i) => i.sourceKind === 'unattributed-camper')).toEqual([])
  })
})

describe('the CLI can name the subject at import time', () => {
  it('a supplied camperName attributes it immediately, with no flag and no residue', () => {
    // Step 1 of the identity order existed as a parameter with no way to reach it:
    // no argv parser, no MCP tool passing it. A parameter nothing can set is not a
    // feature.
    const result = importAs('planner.csv', AVIVA, { camperName: 'Aviva Feldspar' })
    expect(result.ok).toBe(true)

    const rows = campers()
    expect(rows).toHaveLength(1)
    expect(rows[0].display_name).toBe('Aviva Feldspar')
    expect(rows[0].is_unattributed).toBeNull()
    expect(rows[0].id).toBe(deriveCamperId(campId, { externalId: null, displayName: 'Aviva Feldspar' }))
    expect((result.residue ?? []).filter((r) => r.kind === 'UNATTRIBUTED_SUBJECT')).toEqual([])
  })
})
