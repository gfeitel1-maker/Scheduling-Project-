// @vitest-environment node
//
// T279 — the RESOLVE stage: five resolvers under one rule.
// docs/adr/2026-09-27-elective-preference-etl-canonical-record-and-learned-axis-binding.md
// §12.0: "the elective importer never writes a value it could not resolve
// without saying so."
//
// EVERY TEST HERE ENTERS AT FILE BYTES AND ASSERTS AT THE DATABASE. That is not
// a style preference. This repo has three recorded instances in ONE DAY of
// tests that hand-built a fixture and then asserted on the fixture rather than
// on the system (T62, T197 round 1, the v78 fallback row), plus a whole ticket
// caused by exactly that. A test that constructs a `parsed` object and asserts
// on its contents proves that the test author can build an object. So the input
// is always a real file on disk, read through `runPreferenceSheetCli` — the same
// exported core the CLI and the MCP tools drive — and every assertion is a
// SELECT.
//
// The corpus (test/fixtures/preference-corpus/) is the regression surface, and
// the probe ids below are the measured silent misses from ADR §8.1 that this
// ticket closes, traced in §12.4.
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { fileURLToPath } from 'node:url'

import { openLocalDb } from '../electron/db/localDb.js'
import { runPreferenceSheetCli } from '../scripts/preferenceSheetCli.js'
import { deriveCamperId } from '../electron/ops/electiveDerivedIds.js'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const PROBES = path.join(ROOT, 'test/fixtures/preference-corpus/probes')

// The activity names the corpus generator draws from (scripts/fixtures/
// make-preference-corpus.mjs `ACT`). Seeded as the camp's catalog so the label
// resolver has something real to resolve AGAINST — an empty catalog is a
// different case entirely (an abstention, not a miss) and has its own test.
//
// Duplicated from the generator rather than imported: the generator is a
// one-shot script that writes files on import, so importing it here would
// rewrite the corpus during a test run. If it drifts, the P09/P13 tests below
// fail loudly on a label that no longer resolves, which is the failure we want.
const CORPUS_ACTIVITIES = [
  'Swim', 'Archery', 'Ceramics', 'Woodworking', 'Basketball', 'Drama', 'Nature',
  'Photography', 'Rock Climbing', 'Gaga', 'Dance', 'Cooking', 'Soccer', 'Tennis',
  'Arts And Crafts', 'Sailing', 'Yoga', 'Fishing', 'Hockey', 'Music',
]

let dir
let dbPath
let campId

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'shoresh-t279-'))
  dbPath = path.join(dir, 'shoresh.sqlite')
  const db = openLocalDb(dbPath)
  campId = randomUUID()
  db.prepare('INSERT INTO camps (id, name, signing_secret) VALUES (?, ?, ?)').run(campId, 'Probe Camp', 'a'.repeat(64))
  db.prepare('INSERT INTO devices (id, name) VALUES (?, ?)').run(randomUUID(), 'Host')
  db.prepare("INSERT INTO users (id, camp_id, name, pin_hash, pin_salt, role) VALUES (?, ?, 'Probe', 'h', 's', 'admin')")
    .run(randomUUID(), campId)
  db.close()
})

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true })
})

const withDb = (fn) => {
  const db = openLocalDb(dbPath)
  try {
    return fn(db)
  } finally {
    db.close()
  }
}

/** Seed the camp's activity catalog — what the LABEL resolver resolves against. */
function seedActivities(names) {
  withDb((db) => {
    const insert = db.prepare('INSERT INTO activities (id, camp_id, name) VALUES (?, ?, ?)')
    for (const name of names) insert.run(randomUUID(), campId, name)
  })
}

/** Seed the camp's groups — what the DIVISION resolver resolves against first. */
function seedGroups(names) {
  withDb((db) => {
    const insert = db.prepare('INSERT INTO groups (id, camp_id, name) VALUES (?, ?, ?)')
    for (const name of names) insert.run(randomUUID(), campId, name)
  })
}

function seedTiers(names) {
  withDb((db) => {
    const insert = db.prepare('INSERT INTO tiers (id, camp_id, name) VALUES (?, ?, ?)')
    for (const name of names) insert.run(randomUUID(), campId, name)
  })
}

const commitProbe = (probeFile) =>
  runPreferenceSheetCli({ file: path.join(PROBES, probeFile), dbPath, action: 'commit' })

/** Write a bespoke sheet for a case the fixed corpus does not carry, and commit it. */
function commitBytes(name, csv) {
  const file = path.join(dir, name)
  fs.writeFileSync(file, csv)
  return runPreferenceSheetCli({ file, dbPath, action: 'commit' })
}

const residueKinds = (result) => (result.residue ?? []).map((r) => r.kind)
const residueOf = (result, kind) => (result.residue ?? []).filter((r) => r.kind === kind)

// ---------------------------------------------------------------------------
// The cross-cutting loss: division parsed, previewed, and dropped (15/33
// probes). ADR §12.2a, traceability row "cross-cutting".
// ---------------------------------------------------------------------------
describe('the DIVISION resolver (ADR §12.2a, §13.5)', () => {
  it('P01: stores every division verbatim AND resolves it to an existing group', () => {
    seedActivities(CORPUS_ACTIVITIES)
    seedGroups(['Upper Division', 'Middle Division', 'Lower Division'])

    const result = commitProbe('P01-kind3-canonical.csv')
    expect(result.error).toBeNull()
    expect(result.ok).toBe(true)

    const campers = withDb((db) =>
      db.prepare('SELECT display_name, division_label, group_id FROM campers ORDER BY display_name').all()
    )
    expect(campers.length).toBeGreaterThan(0)
    // Verbatim, for EVERY camper — this is the half that was silently lost.
    for (const c of campers) expect(c.division_label).not.toBeNull()
    // And resolved, because a matching group exists.
    for (const c of campers) expect(c.group_id).not.toBeNull()

    const ari = campers.find((c) => c.display_name === 'Ari Feldspar')
    expect(ari.division_label).toBe('Upper Division')
  })

  it('P35: a Group column holding an activity track is stored verbatim, resolves to NOTHING, and is residue', () => {
    // The mis-binding is still MADE — `DIVISION_HEADER` matches /group/, so
    // 'Sports Track' is read as a division. What this closes is that it is no
    // longer INVISIBLE.
    seedActivities(CORPUS_ACTIVITIES)
    seedGroups(['Upper Division', 'Middle Division', 'Lower Division'])

    const result = commitProbe('P35-group-column-is-a-track.csv')
    expect(result.ok).toBe(true)

    const ari = withDb((db) =>
      db.prepare("SELECT division_label, group_id FROM campers WHERE display_name = 'Ari Feldspar'").get()
    )
    expect(ari.division_label).toBe('Sports Track')
    expect(ari.group_id).toBeNull()

    const unmatched = residueOf(result, 'UNMATCHED_DIVISION')
    expect(unmatched.length).toBeGreaterThan(0)
    expect(unmatched.map((r) => r.label)).toContain('Sports Track')

    // ROUND 6 / §13.5: `group_id IS NULL` being the success condition DISABLES
    // the coverage check for these campers, so the page must be reported
    // UNMEASURED rather than passing. A silent denominator would destroy
    // metric 2's "must be zero" property.
    expect(result.coverage.measurable).toBe(false)
    expect(result.coverage.unmeasuredCampers).toBe(unmatched.length)
  })

  it('a division naming a TIER resolves referentially to nothing, and says which tier it matched', () => {
    // §13.5 — two target sets in order: `groups`, then `tiers`. A tiers match
    // sets NOTHING referential (campers.tier_id is deliberately not added:
    // groups.tier_id is the single path from a camper to a tier) and is
    // reported so the director can assign groups.
    seedActivities(['Swim', 'Archery', 'Ceramics'])
    seedGroups(['Bunk Aleph'])
    seedTiers(['Grades 7-8'])

    const result = commitBytes(
      'tier-division.csv',
      'Camper Name,Division,#1,#2,#3\nDalia Tuff,Grades 7-8,Swim,Archery,Ceramics\n'
    )
    expect(result.ok).toBe(true)

    const camper = withDb((db) => db.prepare('SELECT division_label, group_id FROM campers').get())
    expect(camper.division_label).toBe('Grades 7-8')
    expect(camper.group_id).toBeNull()

    const matched = residueOf(result, 'DIVISION_MATCHED_TIER')
    expect(matched).toHaveLength(1)
    expect(matched[0].label).toBe('Grades 7-8')
    expect(result.coverage.measurable).toBe(false)
  })

  it('never CLEARS a group it merely failed to resolve (roster-owned field)', () => {
    // REGRESSION, caught by the full gate rather than by this file. An earlier
    // draft wrote `group_id: c.group_id ?? null` unconditionally, so a camper
    // already in Bunk Alpha whose sheet division matched no group had their
    // group silently cleared — an ordinary per-field LWW op clobbering real
    // group membership campwide. A preference sheet may SET a group it resolved;
    // it may never clear one it did not.
    seedActivities(['Swim', 'Archery', 'Ceramics'])
    seedGroups(['Bunk Alpha'])
    const groupId = withDb((db) => db.prepare("SELECT id FROM groups WHERE name = 'Bunk Alpha'").get().id)

    // Put the camper on the roster in a group FIRST, which is the real order of
    // events: a camp builds its roster, then imports preference sheets.
    commitBytes('roster-first.csv', 'Camper Name,#1\nDalia Tuff,Swim\n')
    withDb((db) => db.prepare('UPDATE campers SET group_id = ?').run(groupId))

    // Now import a sheet whose division matches nothing.
    const result = commitBytes(
      'unmatched-division-later.csv',
      'Camper Name,Division,#1,#2\nDalia Tuff,A Division Nobody Has,Swim,Archery\n'
    )
    expect(result.ok).toBe(true)
    expect(residueKinds(result)).toContain('UNMATCHED_DIVISION')

    const camper = withDb((db) => db.prepare('SELECT group_id, division_label FROM campers').get())
    // The group SURVIVES.
    expect(camper.group_id).toBe(groupId)
    // And the unresolved label is still recorded beside it.
    expect(camper.division_label).toBe('A Division Nobody Has')
  })

  it('a sheet with NO division column does not erase a division already recorded', () => {
    seedActivities(['Swim', 'Archery'])
    commitBytes('with-division.csv', 'Camper Name,Division,#1\nDalia Tuff,Grades 7-8,Swim\n')
    expect(withDb((db) => db.prepare('SELECT division_label FROM campers').get().division_label)).toBe('Grades 7-8')

    // A later sheet that says nothing about divisions says nothing — it does
    // not assert emptiness.
    const result = commitBytes('no-division-column.csv', 'Camper Name,#1,#2\nDalia Tuff,Swim,Archery\n')
    expect(result.ok).toBe(true)
    expect(withDb((db) => db.prepare('SELECT division_label FROM campers').get().division_label)).toBe('Grades 7-8')
  })

  it('NEVER creates a group or a tier from a file (T224 as a rule)', () => {
    seedActivities(['Swim', 'Archery', 'Ceramics'])
    const before = withDb((db) => ({
      groups: db.prepare('SELECT COUNT(*) c FROM groups').get().c,
      tiers: db.prepare('SELECT COUNT(*) c FROM tiers').get().c,
    }))

    const result = commitBytes(
      'invented-division.csv',
      'Camper Name,Division,#1,#2,#3\nDalia Tuff,A Division Nobody Has,Swim,Archery,Ceramics\n'
    )
    expect(result.ok).toBe(true)

    const after = withDb((db) => ({
      groups: db.prepare('SELECT COUNT(*) c FROM groups').get().c,
      tiers: db.prepare('SELECT COUNT(*) c FROM tiers').get().c,
    }))
    expect(after).toEqual(before)
    expect(residueKinds(result)).toContain('UNMATCHED_DIVISION')
  })
})

// ---------------------------------------------------------------------------
// P02 — printed 200, wrote 160. ADR §12.2b, §13.3.
// ---------------------------------------------------------------------------
describe('the RANK collision rule (ADR §12.2b, §13.3)', () => {
  it('P02: the reported preference count EQUALS the number of rows written', () => {
    seedActivities(CORPUS_ACTIVITIES)

    const result = commitProbe('P02-kind3-top25.csv')
    expect(result.ok).toBe(true)

    const written = withDb((db) => db.prepare('SELECT COUNT(*) c FROM elective_preferences').get().c)
    // ONE number by construction. The old report said 200 and wrote 160.
    expect(result.counts.preferences).toBe(written)
  })

  it('P02: the surviving row keeps the BETTER (lowest) rank, and the drop is residue', () => {
    seedActivities(CORPUS_ACTIVITIES)

    const result = commitProbe('P02-kind3-top25.csv')
    expect(result.ok).toBe(true)

    // Ari lists Swim at #1 and again at #21 (the corpus cycles the vocabulary).
    const rows = withDb((db) =>
      db
        .prepare(
          `SELECT p.rank FROM elective_preferences p
             JOIN campers c ON c.id = p.camper_id
             JOIN elective_choices ch ON ch.id = p.choice_id
            WHERE c.display_name = 'Ari Feldspar' AND ch.label = 'Swim'`
        )
        .all()
    )
    expect(rows).toHaveLength(1)
    expect(rows[0].rank).toBe(1)

    const dropped = residueOf(result, 'DROPPED_DUPLICATE_RANK')
    expect(dropped.length).toBeGreaterThan(0)
    // The residue must name the rank that was dropped, not merely that one was.
    expect(dropped.some((r) => r.label === 'Swim' && r.droppedRank === 21)).toBe(true)
  })

  it('a RANKED value beats an UNRANKED one, and residue names the rank_kind disagreement', () => {
    // §13.3's third collision row: an explicit rank is strictly more
    // information than its absence.
    seedActivities(['Swim', 'Archery'])

    const result = commitBytes(
      'ranked-beats-unranked.csv',
      'Camper Name,#1,Acceptable Activities\nDalia Tuff,Swim,Swim\n'
    )
    expect(result.ok).toBe(true)

    const rows = withDb((db) =>
      db.prepare('SELECT rank, rank_kind FROM elective_preferences').all()
    )
    expect(rows).toHaveLength(1)
    expect(rows[0].rank).toBe(1)
    expect(rows[0].rank_kind).toBe('ordered-fallback')
    expect(residueKinds(result)).toContain('RANK_KIND_DISAGREEMENT')
  })

  it('same rank on two DIFFERENT choices is still REFUSED (unchanged)', () => {
    // §12.2b's asymmetry: nothing distinguishes them, so there is no rule to
    // resolve it by. Non-vacuity for the best-rank-wins rule above — it must
    // not have widened into accepting this.
    seedActivities(['Swim', 'Archery'])

    const result = commitBytes(
      'same-rank-two-choices.csv',
      'Camper Name,#1,Acceptable Activities\nDalia Tuff,Swim,Archery\nDalia Tuff,Archery,Swim\n'
    )
    expect(result.ok).toBe(false)
    expect(result.error).toMatch(/same preference rank twice|more than one row/)
  })

  it('rank_kind is written for every preference, or §4.2 is unimplementable', () => {
    seedActivities(CORPUS_ACTIVITIES)
    const result = commitProbe('P01-kind3-canonical.csv')
    expect(result.ok).toBe(true)

    const kinds = withDb((db) =>
      db.prepare('SELECT DISTINCT rank_kind FROM elective_preferences').all().map((r) => r.rank_kind)
    )
    expect(kinds).toEqual(['ordered-fallback'])
  })
})

// ---------------------------------------------------------------------------
// P09 / P13 — the label resolver. ADR §12.3.
// ---------------------------------------------------------------------------
describe('the LABEL resolver, against the camp activity catalog (ADR §12.3)', () => {
  it('P09: never mints a choice whose label matches no activity, and residues each ambiguous cell', () => {
    seedActivities(CORPUS_ACTIVITIES)

    const result = commitProbe('P09-kind3-packed-cells.csv')
    expect(result.ok).toBe(true)

    const known = new Set(CORPUS_ACTIVITIES.map((n) => n.toLowerCase().replace(/\s+/g, '')))
    const labels = withDb((db) => db.prepare('SELECT label FROM elective_choices').all().map((r) => r.label))
    expect(labels.length).toBeGreaterThan(0)
    for (const label of labels) {
      expect(known.has(label.toLowerCase().replace(/\s+/g, ''))).toBe(true)
    }
    // 'Archery, Ceramics, Woodworking' splits into three KNOWN activities, so
    // it is genuinely ambiguous (a packed alternative set, or an activity name
    // containing a comma) and must be asked about, not guessed.
    const ambiguous = residueOf(result, 'AMBIGUOUS_PACKED_CELL')
    expect(ambiguous.length).toBeGreaterThan(0)
    expect(ambiguous.some((r) => r.label === 'Archery, Ceramics, Woodworking')).toBe(true)
  })

  it('P13: a row whose rank cells resolve to no known activity is not a camper', () => {
    seedActivities(CORPUS_ACTIVITIES)

    const result = commitProbe('P13-trailing-junk-rows.csv')
    expect(result.ok).toBe(true)

    const campers = withDb((db) => db.prepare('SELECT display_name FROM campers').all().map((r) => r.display_name))
    expect(campers).toHaveLength(8)
    expect(campers).not.toContain('Total Campers')
    expect(campers).not.toContain('Please Return')
    expect(campers).not.toContain('Camp Office Use Only')

    // Named, with the row number and what was on it — a skip nobody is told
    // about is the same defect one step along.
    const skipped = result.skippedRows.filter((r) => r.reason === 'no rank cell names a known activity')
    expect(skipped).toHaveLength(3)
    for (const s of skipped) {
      expect(typeof s.rowNumber).toBe('number')
      expect(s.contents.length).toBeGreaterThan(0)
    }
  })

  it('an unresolvable label is residue and is NOT written', () => {
    seedActivities(['Swim', 'Archery'])

    const result = commitBytes(
      'unknown-label.csv',
      'Camper Name,#1,#2\nDalia Tuff,Swim,Underwater Basket Weaving\n'
    )
    expect(result.ok).toBe(true)

    const labels = withDb((db) => db.prepare('SELECT label FROM elective_choices').all().map((r) => r.label))
    expect(labels).toEqual(['Swim'])
    const unresolved = residueOf(result, 'UNRESOLVED_CHOICE_LABEL')
    expect(unresolved.map((r) => r.label)).toContain('Underwater Basket Weaving')
  })

  it('an EMPTY catalog makes the resolver ABSTAIN, not miss: every label is written AND flagged unverified', () => {
    // §12.3's degenerate case, and the distinction matters. With nothing to
    // resolve against, "no match" is not evidence of a wrong label — it is
    // evidence of an empty catalog. Refusing to write anything here would be
    // the refuse-everything class §3.1a had to correct twice: a camp's FIRST
    // import is exactly the case with no catalog yet. So the labels land, and
    // every one of them is reported as unverified — loud and useless-looking,
    // which is correct, rather than quiet and wrong.
    const result = commitBytes(
      'no-catalog.csv',
      'Camper Name,#1,#2\nDalia Tuff,Swim,Archery\n'
    )
    expect(result.ok).toBe(true)

    const labels = withDb((db) => db.prepare('SELECT label FROM elective_choices').all().map((r) => r.label))
    expect(labels.sort()).toEqual(['Archery', 'Swim'])

    const unverified = residueOf(result, 'UNVERIFIED_CHOICE_LABEL')
    expect(unverified.map((r) => r.label).sort()).toEqual(['Archery', 'Swim'])
    expect(result.coverage.measurable).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// P10 — an unordered set is not a rank. ADR §4.1.
// ---------------------------------------------------------------------------
describe('an unordered SET is never coerced into a ranking (ADR §4.1)', () => {
  it('P10: a packed set column yields rank NULL for every member, and says so', () => {
    // "Swim, Archery, Ceramics" in one column headed 'Activities Chosen' is one
    // camper naming three ACCEPTABLE activities. An unordered set of acceptable
    // activities is a different FACT from a ranking, and cell order is not
    // ordering evidence — inventing a rank from it would fabricate a
    // preference the child never stated.
    seedActivities(CORPUS_ACTIVITIES)

    const result = commitProbe('P10-unordered-set-no-rank.csv')
    expect(result.ok).toBe(true)

    const rows = withDb((db) => db.prepare('SELECT rank, rank_kind FROM elective_preferences').all())
    expect(rows.length).toBeGreaterThan(0)
    for (const r of rows) {
      expect(r.rank).toBeNull()
      expect(r.rank_kind).toBe('unordered-set')
    }

    // §4.1 requires the residue item, not just the null rank: the director has
    // to know the app is holding a tie among equals rather than a ranking,
    // because the solver cannot consume it the same way.
    const sets = residueOf(result, 'UNORDERED_SET')
    expect(sets.length).toBeGreaterThan(0)
    expect(sets[0].column).toMatch(/^[A-Z]+$/)
  })

  it('P10 is NOT refused for holding the same (absent) rank many times', () => {
    // An unranked preference cannot contradict anything. Keying every null onto
    // one rank refused this sheet with "a camper holds the same preference rank
    // twice" — about a file that states no ranks at all.
    seedActivities(CORPUS_ACTIVITIES)
    const result = commitProbe('P10-unordered-set-no-rank.csv')
    expect(result.error).toBeNull()
    expect(withDb((db) => db.prepare('SELECT COUNT(*) c FROM campers').get().c)).toBeGreaterThan(0)
  })
})

// ---------------------------------------------------------------------------
// P18 / P38 — the column resolver. ADR §12.0, §12.3.
// ---------------------------------------------------------------------------
describe('the COLUMN resolver (ADR §12.0)', () => {
  it('P18: the swim opt-out and the comments box are each reported by name', () => {
    seedActivities(CORPUS_ACTIVITIES)

    const result = commitProbe('P18-kind3-optout-and-comments.csv')
    expect(result.ok).toBe(true)

    const unrecognised = residueOf(result, 'UNRECOGNISED_COLUMN')
    const headers = unrecognised.map((r) => r.header)
    expect(headers).toContain('Opt Out of Instructional Swim')
    expect(headers).toContain('Additional Comments')
    // The director sees the spreadsheet column letter, not a zero-based index.
    for (const r of unrecognised) expect(r.column).toMatch(/^[A-Z]+$/)
  })

  it('P18: neither the opt-out nor the comments box enters elective_preferences (§4.3)', () => {
    seedActivities(CORPUS_ACTIVITIES)

    const result = commitProbe('P18-kind3-optout-and-comments.csv')
    expect(result.ok).toBe(true)

    const labels = withDb((db) => db.prepare('SELECT label FROM elective_choices').all().map((r) => r.label))
    expect(labels).not.toContain('Yes')
    expect(labels).not.toContain('Please keep with a friend')
  })

  it('P38: a rank column renamed to prose is READ as rank 3, not dropped and not merely reported', () => {
    // THE HISTORY MATTERS HERE, so it is recorded rather than quietly replaced.
    //
    // P37 -> P38 renames '#3' to 'Third Choice'. Originally that silently dropped
    // rank 3 for all 13 campers with ok=true and no residue at all. T279 made it
    // LOUD: the column became an `UNRECOGNISED_COLUMN` residue item, which is a
    // strictly better failure but still a failure — the rank was still not read.
    //
    // T285 slice A closes it properly: prose rank headers are now recognised, so
    // rank 3 is READ. This test therefore asserts the STRONGER outcome, and the
    // absence of the residue item is the evidence of the upgrade rather than a
    // regression. ADR §14.1's point exactly — shape was never a reason to refuse
    // or to drop.
    seedActivities(CORPUS_ACTIVITIES)

    const result = commitProbe('P38-kind3-reimport-drifted.csv')
    expect(result.ok).toBe(true)

    // Rank 3 exists, for every camper on the sheet.
    const rank3 = withDb((db) =>
      db.prepare('SELECT COUNT(*) c FROM elective_preferences WHERE rank = 3').get().c
    )
    const campers = withDb((db) => db.prepare('SELECT COUNT(*) c FROM campers').get().c)
    expect(rank3).toBe(campers)
    expect(rank3).toBeGreaterThan(0)

    // And it is no longer reported as a column nobody could place.
    expect(residueOf(result, 'UNRECOGNISED_COLUMN').map((r) => r.header)).not.toContain('Third Choice')
  })
})

// ---------------------------------------------------------------------------
// P06 / F1 — the identity resolver. ADR §12.3, §13.1, §4.4.
// ---------------------------------------------------------------------------
describe('the IDENTITY resolver (ADR §13.1, §12.3, §4.4)', () => {
  it('P06: a partial-id fork is RESIDUE, not a refusal, and names each row', () => {
    // One child on two rows, one carrying an external id and one not, derives
    // TWO ids, so `sameNameCampers` excludes it and nothing is reported today.
    // A refusal would be wrong: two children who really do share a name and
    // ARE distinguished by id is the correct reading of that shape.
    seedActivities(CORPUS_ACTIVITIES)
    seedGroups(['Upper Division', 'Lower Division'])

    const result = commitBytes(
      'partial-id-fork.csv',
      'Camper ID,Camper Name,Division,#1,#2,#3\n' +
        'SYN-1000,Ari Feldspar,Upper Division,Swim,Archery,Ceramics\n' +
        ',Ari Feldspar,Lower Division,Nature,Photography,Gaga\n'
    )
    // NOT refused.
    expect(result.error).toBeNull()
    expect(result.ok).toBe(true)

    // Two camper records for one name — the fork really happens.
    const campers = withDb((db) =>
      db.prepare("SELECT id, division_label FROM campers WHERE display_name = 'Ari Feldspar'").all()
    )
    expect(campers).toHaveLength(2)

    const forked = residueOf(result, 'FORKED_IDENTITY')
    expect(forked).toHaveLength(1)
    expect(forked[0].display_name).toBe('Ari Feldspar')
    expect(forked[0].rows.map((r) => r.rowNumber).sort()).toEqual([2, 3])
    // The division label is the disambiguation evidence §12.2a made available —
    // it is what lets a director say "those are two different kids".
    expect(forked[0].rows.map((r) => r.divisionLabel).sort()).toEqual(['Lower Division', 'Upper Division'])
    expect(forked[0].rows.filter((r) => r.hasExternalId)).toHaveLength(1)
  })

  it('F1: a per-cell planner for ONE camper writes a row per cell and is NOT refused', () => {
    // THE BLOCKER. `sameNameCampers` keeps any name with rowNumbers.length > 1
    // and ids.size === 1, and commitElectiveRun tests it FIRST — so one
    // camper's per-cell answers, read correctly as many rows, were refused
    // before hasContradictoryRanks was even reached. Reproduced by execution,
    // not by reading (ADR §13.1).
    seedActivities(['Swim', 'Archery', 'Ceramics', 'Nature', 'Gaga', 'Drama'])

    // Six distinct coordinates for one child, one row per cell.
    const rows = [
      'Camper Name,Day,Period,#1',
      'Dalia Tuff,Monday,Period 1,Swim',
      'Dalia Tuff,Monday,Period 2,Archery',
      'Dalia Tuff,Tuesday,Period 1,Ceramics',
      'Dalia Tuff,Tuesday,Period 2,Nature',
      'Dalia Tuff,Wednesday,Period 1,Gaga',
      'Dalia Tuff,Wednesday,Period 2,Drama',
    ].join('\n')

    const result = commitBytes('per-cell-planner.csv', rows + '\n')
    expect(result.error).toBeNull()
    expect(result.ok).toBe(true)

    const written = withDb((db) => ({
      campers: db.prepare('SELECT COUNT(*) c FROM campers').get().c,
      prefs: db.prepare('SELECT COUNT(*) c FROM elective_preferences').get().c,
    }))
    expect(written.campers).toBe(1)
    expect(written.prefs).toBe(6)
    expect(result.counts.preferences).toBe(6)

    // Each cell is a CHOICE, not a ranked fallback — rank 1 by construction.
    const kinds = withDb((db) =>
      db.prepare('SELECT DISTINCT rank_kind FROM elective_preferences').all().map((r) => r.rank_kind)
    )
    expect(kinds).toEqual(['cell-choice'])
  })

  it('two cells naming the SAME activity are TWO rows, with their coordinates intact', () => {
    // OWNER RULING, round 2, and this is the whole point of it. A child who asks
    // for Archery in Monday period 3 AND in Monday period 6 has stated TWO
    // things. Storage used to key on (camper, occurrence_id, choice), and
    // occurrence_id is NULL until a template exists — so both answers collapsed
    // onto one row and the second was reported as a dropped duplicate. That is
    // the T278 defect (the importer silently discarding a camper's answer)
    // happening inside the fix for it.
    //
    // The COORDINATE is a fact about what the CHILD asked for, true the moment
    // the sheet is read. The OCCURRENCE is a fact about one candidate schedule,
    // and does not exist yet. Conflating them is what made this lossy.
    seedActivities(['Archery', 'Ceramics'])

    const result = commitBytes(
      'same-activity-two-cells.csv',
      'Camper Name,Day,Period,#1\n' +
        'Dalia Tuff,Monday,Period 3,Archery\n' +
        'Dalia Tuff,Monday,Period 6,Archery\n'
    )
    expect(result.error).toBeNull()
    expect(result.ok).toBe(true)

    const rows = withDb((db) =>
      db
        .prepare(
          `SELECT coordinate_day_label, coordinate_period_label, occurrence_id
             FROM elective_preferences ORDER BY coordinate_period_label`
        )
        .all()
    )
    // TWO rows. Not one, and not a residued drop.
    expect(rows).toHaveLength(2)
    expect(result.counts.preferences).toBe(2)
    expect(rows.map((r) => r.coordinate_period_label)).toEqual(['Period 3', 'Period 6'])
    for (const r of rows) expect(r.coordinate_day_label).toBe('Monday')

    // occurrence_id stays NULL, and that is CORRECT rather than a gap: no
    // template exists at import time, and resolving the coordinate to an
    // occurrence is the caller's job at solve time (ADR §13.2). The file
    // round-trips its coordinates intact and becomes resolvable later WITHOUT
    // being re-imported.
    for (const r of rows) expect(r.occurrence_id).toBeNull()

    // And nothing was reported as dropped, because nothing was.
    expect(residueKinds(result)).not.toContain('DROPPED_DUPLICATE_RANK')
  })

  it('the coordinate is stored exactly as the file wrote it', () => {
    seedActivities(['Swim'])
    const result = commitBytes(
      'coordinate-verbatim.csv',
      'Camper Name,Day Of Week,Period Number,#1\nDalia Tuff,Wednesday,4,Swim\n'
    )
    expect(result.ok).toBe(true)
    const row = withDb((db) =>
      db.prepare('SELECT coordinate_day_label, coordinate_period_label FROM elective_preferences').get()
    )
    expect(row.coordinate_day_label).toBe('Wednesday')
    expect(row.coordinate_period_label).toBe('4')
  })

  it('a whole-run sheet stores NO coordinate, and still collapses a repeated choice', () => {
    // Non-vacuity for the row above. A flat ranked list has no cells, so both
    // coordinate columns are NULL and the pre-existing whole-run uniqueness
    // invariant is untouched: naming one activity at two ranks is still ONE row
    // at the better rank, with the drop residued.
    seedActivities(['Swim', 'Archery'])
    const result = commitBytes(
      'whole-run-repeat.csv',
      'Camper Name,#1,#2,#3\nDalia Tuff,Swim,Archery,Swim\n'
    )
    expect(result.ok).toBe(true)

    const rows = withDb((db) =>
      db.prepare('SELECT rank, coordinate_day_label, coordinate_period_label FROM elective_preferences ORDER BY rank').all()
    )
    expect(rows).toHaveLength(2)
    for (const r of rows) {
      expect(r.coordinate_day_label).toBeNull()
      expect(r.coordinate_period_label).toBeNull()
    }
    expect(rows.map((r) => r.rank)).toEqual([1, 2])
    expect(residueKinds(result)).toContain('DROPPED_DUPLICATE_RANK')
  })

  it('F1 non-vacuity: the same name twice at the SAME coordinate is STILL refused', () => {
    // The widening must be a widening, not a removal. Two rows naming one child
    // at ONE coordinate is the original T226 collision and stays refused.
    seedActivities(['Swim', 'Archery'])

    const result = commitBytes(
      'same-coordinate-collision.csv',
      'Camper Name,Day,Period,#1\n' +
        'Dalia Tuff,Monday,Period 1,Swim\n' +
        'Dalia Tuff,Monday,Period 1,Archery\n'
    )
    expect(result.ok).toBe(false)
    expect(result.error).toMatch(/more than one row/)
  })

  it('F1 non-vacuity: a whole-run sheet with one name on many rows is STILL refused', () => {
    // An absent coordinate collapses to the same empty component for every
    // row, so T226's original behaviour is preserved EXACTLY for that shape.
    // Many rows for one name with no coordinate can only mean many rows for
    // one child.
    seedActivities(['Swim', 'Archery', 'Ceramics', 'Nature'])

    const result = commitBytes(
      'whole-run-collision.csv',
      'Camper Name,#1,#2\n' +
        'Dalia Tuff,Swim,Archery\n' +
        'Dalia Tuff,Ceramics,Nature\n'
    )
    expect(result.ok).toBe(false)
    expect(result.error).toMatch(/more than one row/)
  })

  it('P07: the refusal sentence names each row’s division, so a director can tell the rows apart', () => {
    // §12.2a's consequence: division is disambiguation evidence shown to a
    // human. The refusal did not name it before.
    seedActivities(['Swim', 'Archery', 'Ceramics', 'Nature'])

    const result = commitBytes(
      'same-name-divisions.csv',
      'Camper Name,Division,#1,#2\n' +
        'Ari Feldspar,Upper Division,Swim,Archery\n' +
        'Ari Feldspar,Lower Division,Ceramics,Nature\n'
    )
    expect(result.ok).toBe(false)
    expect(result.error).toContain('Upper Division')
    expect(result.error).toContain('Lower Division')
  })
})

// ---------------------------------------------------------------------------
// §3.4 — residue is non-empty by DEFAULT.
// ---------------------------------------------------------------------------
describe('residue (ADR §3.4)', () => {
  it('is always present as an array on every result, preview and commit alike', () => {
    seedActivities(CORPUS_ACTIVITIES)
    const preview = runPreferenceSheetCli({
      file: path.join(PROBES, 'P01-kind3-canonical.csv'),
      dbPath,
      action: 'preview',
    })
    expect(Array.isArray(preview.residue)).toBe(true)
    const commit = commitProbe('P01-kind3-canonical.csv')
    expect(Array.isArray(commit.residue)).toBe(true)
  })

  it('every residue item carries a human sentence, not just a kind', () => {
    // A residue ledger nobody can read is the silent miss wearing a hat.
    seedActivities(CORPUS_ACTIVITIES)
    const result = commitProbe('P18-kind3-optout-and-comments.csv')
    expect(result.residue.length).toBeGreaterThan(0)
    for (const item of result.residue) {
      expect(typeof item.kind).toBe('string')
      expect(item.message.length).toBeGreaterThan(20)
    }
  })
})

// ---------------------------------------------------------------------------
// T285 SLICE A — header and identity resolution. ADR §14.1: shape is not a
// reason to refuse ingest, and a refusal belongs AFTER the transform if
// anywhere. Every one of these was refused at the HEADER, before any transform
// ran, which is the wrong side of the pipeline.
//
// A bucket change from BREAKS LOUDLY to COMMITTED is NOT evidence on its own, so
// every test here asserts the RIGHT data landed. A probe that commits wrong data
// is worse than one that refuses, because the refusal at least tells the truth.
// ---------------------------------------------------------------------------
describe('T285 slice A — header and identity resolution', () => {
  it('P03: prose rank headers are read as the ranks they name', () => {
    // "First Choice", "Second Choice", "Third Choice". ADR §4.2 already recorded
    // that /^#\s*(\d+)$/ "matches essentially nothing" against real vendor
    // exports, which is what made this the common case rather than an edge one.
    seedActivities(CORPUS_ACTIVITIES)

    const result = commitProbe('P03-kind3-prose-rank-headers.csv')
    expect(result.error).toBeNull()
    expect(result.ok).toBe(true)

    // The RIGHT ranks, not merely three of them: Ari's sheet row reads
    // Swim, Archery, Ceramics across first/second/third.
    const ari = withDb((db) =>
      db
        .prepare(
          `SELECT p.rank, ch.label FROM elective_preferences p
             JOIN campers c ON c.id = p.camper_id
             JOIN elective_choices ch ON ch.id = p.choice_id
            WHERE c.display_name = 'Ari Feldspar' ORDER BY p.rank`
        )
        .all()
    )
    expect(ari).toEqual([
      { rank: 1, label: 'Swim' },
      { rank: 2, label: 'Archery' },
      { rank: 3, label: 'Ceramics' },
    ])
    expect(result.counts.preferences).toBe(
      withDb((db) => db.prepare('SELECT COUNT(*) c FROM elective_preferences').get().c)
    )
  })

  it('P04: a name column headed just `Student` is the name column', () => {
    seedActivities(CORPUS_ACTIVITIES)

    const result = commitProbe('P04-kind3-bare-student-header.csv')
    expect(result.ok).toBe(true)

    const names = withDb((db) =>
      db.prepare('SELECT display_name FROM campers ORDER BY display_name').all().map((r) => r.display_name)
    )
    // Real names, and NOT the header word committed as a camper.
    expect(names).toContain('Ari Feldspar')
    expect(names).not.toContain('Student')
    expect(names).toHaveLength(6)
  })

  it('P34: a split First/Last name joins in the RIGHT order and derives the RIGHT id', () => {
    // THE HIGHEST-VALUE FIX IN THE LIST: split name columns are the default
    // output of most form tools, so this is likely the most common real file the
    // app currently rejects outright.
    //
    // AND THE MOST DANGEROUS TO GET HALF-RIGHT. `deriveCamperId` keys on the
    // canonicalized display name when there is no external id, so joining in the
    // wrong order — or emitting "Feldspar, Ari" — would pass a bucket check,
    // pass a "did it commit?" check, and then silently fail to match the SAME
    // child on every future import and every downstream name lookup. So this
    // asserts the derived id against the canonical derivation, not just the
    // string.
    seedActivities(CORPUS_ACTIVITIES)

    const result = commitProbe('P34-split-name-columns.csv')
    expect(result.error).toBeNull()
    expect(result.ok).toBe(true)

    const campers = withDb((db) =>
      db.prepare('SELECT id, display_name FROM campers ORDER BY display_name').all()
    )
    expect(campers).toHaveLength(8)

    const names = campers.map((c) => c.display_name)
    // FIRST then LAST, one space, nothing else.
    expect(names).toContain('Ari Feldspar')
    expect(names).toContain('Shira Pyrite')
    for (const n of names) {
      expect(n).not.toMatch(/,/)
      expect(n).not.toMatch(/^[A-Z][a-z]+ (Ari|Noa|Eli|Tamar|Yonah|Maya|Dov|Shira)$/)
    }

    // The identity contract: the stored id IS what deriveCamperId produces for
    // that display name. If the join order were reversed this fails, even though
    // the row count and the commit would both look fine.
    const ari = campers.find((c) => c.display_name === 'Ari Feldspar')
    expect(ari.id).toBe(deriveCamperId(campId, { externalId: null, displayName: 'Ari Feldspar' }))
  })

  it('P12: a header that is not row 1 is located, and the preamble is reported', () => {
    // Two title/junk rows sit above the real header. Locating it is not a new
    // shape, it is finding the shape that is already there.
    seedActivities(CORPUS_ACTIVITIES)

    const result = commitProbe('P12-header-not-first-row.csv')
    expect(result.error).toBeNull()
    expect(result.ok).toBe(true)

    const names = withDb((db) =>
      db.prepare('SELECT display_name FROM campers').all().map((r) => r.display_name)
    )
    expect(names).toHaveLength(8)
    // The junk above the header must not become campers.
    expect(names).not.toContain('Activity Selection')
    expect(names).not.toContain('Upper Division')

    // And the rows we skipped are SAID, not silently discarded — §12.0.
    const preamble = residueOf(result, 'SKIPPED_PREAMBLE')
    expect(preamble).toHaveLength(1)
    expect(preamble[0].rows).toEqual([1, 2])
  })

  it('P23: a structured TABLE above the header is not called a title line', () => {
    // FOUND BY MEASURING SLICE A, not by design, and it is the exact failure the
    // adapter program was warned about: a newly-readable shape is a new
    // opportunity to read it WRONGLY.
    //
    // P23 is a planner grid AND a "Next Five Choices" ranked block on one page.
    // Slice A's header locator found the ranked block's header at row 10 and
    // committed it correctly — and then described the 8-row x 5-day grid above it
    // as "usually a title or a season line". That is worse than silence: it is a
    // confident wrong characterization of half the document.
    //
    // Reading the grid is slice F's job (P23 is deliberately last). Slice A's
    // obligation is that the loss is LOUD and ACCURATE, and that the second
    // reading is NAMED — ADR §14.1 constraint 2: an ambiguity is read one way
    // loudly with the alternative stated, never resolved by silence.
    seedActivities(CORPUS_ACTIVITIES)

    const result = commitProbe('P23-grid-plus-ranked-fallback.csv')
    expect(result.ok).toBe(true)

    // The ranked block IS read correctly — 4 campers x 5 ranks.
    expect(result.counts.preferences).toBe(20)
    expect(result.counts.campers).toBe(4)

    // And the grid above it is reported as an UNREAD TABLE, not as a title line.
    const unread = residueOf(result, 'UNREAD_TABLE_ABOVE_HEADER')
    expect(unread).toHaveLength(1)
    expect(unread[0].rows.length).toBeGreaterThan(2)
    // The message must name the second reading, so a director is not told a grid
    // is decoration.
    expect(unread[0].message).toMatch(/grid|table/i)
    expect(unread[0].message).not.toMatch(/title or a season line/)
    // The calm preamble message must NOT also fire for this page.
    expect(residueOf(result, 'SKIPPED_PREAMBLE')).toHaveLength(0)
  })

  it('P12: a genuinely thin preamble still gets the calm message, not the alarm', () => {
    // Non-vacuity for the row above. 'Activity Selection' and
    // 'Upper Division,Summer' really are a title and a season line, and calling
    // them an unread table would cry wolf on every ordinary export.
    seedActivities(CORPUS_ACTIVITIES)

    const result = commitProbe('P12-header-not-first-row.csv')
    expect(result.ok).toBe(true)
    expect(residueOf(result, 'SKIPPED_PREAMBLE')).toHaveLength(1)
    expect(residueOf(result, 'UNREAD_TABLE_ABOVE_HEADER')).toHaveLength(0)
  })

  it('P11: two columns headed #1 are an UNORDERED SET, not a refusal', () => {
    // A correctness fix rather than a new shape. ADR §4.1: an unordered set is a
    // TIE AMONG EQUALS and must never be coerced into a ranking — so two columns
    // claiming rank 1 are two equally-acceptable choices, which is readable. It
    // was refused at the header instead.
    seedActivities(CORPUS_ACTIVITIES)

    const result = commitProbe('P11-kind3-duplicate-rank-header.csv')
    expect(result.error).toBeNull()
    expect(result.ok).toBe(true)

    const ari = withDb((db) =>
      db
        .prepare(
          `SELECT p.rank, p.rank_kind, ch.label FROM elective_preferences p
             JOIN campers c ON c.id = p.camper_id
             JOIN elective_choices ch ON ch.id = p.choice_id
            WHERE c.display_name = 'Ari Feldspar' ORDER BY ch.label`
        )
        .all()
    )
    // Swim and Archery both sat under a '#1' header: equally acceptable, so rank
    // NULL and 'unordered-set'. Ceramics sat under '#3' and keeps its rank.
    expect(ari).toEqual([
      { rank: null, rank_kind: 'unordered-set', label: 'Archery' },
      { rank: 3, rank_kind: 'ordered-fallback', label: 'Ceramics' },
      { rank: null, rank_kind: 'unordered-set', label: 'Swim' },
    ])

    // Loud: the director is told which rank was duplicated and what we did.
    const dup = residueOf(result, 'DUPLICATED_RANK_HEADER')
    expect(dup).toHaveLength(1)
    expect(dup[0].rank).toBe(1)
    expect(dup[0].columns).toEqual(['C', 'D'])
  })
})

// ---------------------------------------------------------------------------
// T285 SLICE B — compound and per-period headers. The coordinate is carried by
// the COLUMN HEADER rather than by a per-row Day/Period column, which is a new
// dimension: one row per camper, and each rank column names its own cell.
// ---------------------------------------------------------------------------
describe('T285 slice B — compound and per-period headers', () => {
  it('P29: a compound header names a day, a period AND a rank, and all three land', () => {
    // "Monday Period 3 - First Choice". Three facts in one string, and getting any
    // of them wrong puts a child in the wrong period.
    seedActivities(CORPUS_ACTIVITIES)

    const result = commitProbe('P29-compound-period-headers.csv')
    expect(result.error).toBeNull()
    expect(result.ok).toBe(true)

    const ari = withDb((db) =>
      db
        .prepare(
          `SELECT p.rank, p.coordinate_day_label AS day, p.coordinate_period_label AS period, ch.label
             FROM elective_preferences p
             JOIN campers c ON c.id = p.camper_id
             JOIN elective_choices ch ON ch.id = p.choice_id
            WHERE c.display_name = 'Ari Feldspar'
            ORDER BY p.coordinate_day_label, p.rank`
        )
        .all()
    )
    // Three coordinates x two ranks, and the sheet row reads
    // Swim, Archery, Ceramics, Woodworking, Basketball, Drama across
    // Monday/Wednesday/Friday.
    expect(ari).toEqual([
      { rank: 1, day: 'Friday', period: 'Period 3', label: 'Basketball' },
      { rank: 2, day: 'Friday', period: 'Period 3', label: 'Drama' },
      { rank: 1, day: 'Monday', period: 'Period 3', label: 'Swim' },
      { rank: 2, day: 'Monday', period: 'Period 3', label: 'Archery' },
      { rank: 1, day: 'Wednesday', period: 'Period 3', label: 'Ceramics' },
      { rank: 2, day: 'Wednesday', period: 'Period 3', label: 'Woodworking' },
    ])
    expect(result.counts.preferences).toBe(
      withDb((db) => db.prepare('SELECT COUNT(*) c FROM elective_preferences').get().c)
    )
  })

  it('P30: a day-scoped hash rank keeps the day and leaves the period unstated', () => {
    // "Monday #1", "Monday #2" name a DAY and a rank, and say nothing about a
    // period. A period must not be invented — an unstated coordinate leg is null,
    // which v79 stores and the 'at' arm keys on.
    seedActivities(CORPUS_ACTIVITIES)

    const result = commitProbe('P30-per-cell-hash-headers.csv')
    expect(result.error).toBeNull()
    expect(result.ok).toBe(true)

    const ari = withDb((db) =>
      db
        .prepare(
          `SELECT p.rank, p.coordinate_day_label AS day, p.coordinate_period_label AS period, ch.label
             FROM elective_preferences p
             JOIN campers c ON c.id = p.camper_id
             JOIN elective_choices ch ON ch.id = p.choice_id
            WHERE c.display_name = 'Ari Feldspar'
            ORDER BY p.coordinate_day_label, p.rank`
        )
        .all()
    )
    expect(ari).toEqual([
      { rank: 1, day: 'Monday', period: null, label: 'Swim' },
      { rank: 2, day: 'Monday', period: null, label: 'Archery' },
      { rank: 1, day: 'Wednesday', period: null, label: 'Ceramics' },
      { rank: 2, day: 'Wednesday', period: null, label: 'Woodworking' },
    ])

    // Two DIFFERENT days are two distinct scopes, so rank 1 twice is not a
    // contradiction and the sheet is not refused. Eight campers x 4 cells.
    expect(result.counts.preferences).toBe(32)
    expect(result.counts.campers).toBe(8)
  })

  it('P30 non-vacuity: the coordinate really is per-COLUMN, not copied from the row', () => {
    // If the reader fell back to a row-level coordinate, every cell on Ari's row
    // would share one day and rank 1 would collide with itself.
    seedActivities(CORPUS_ACTIVITIES)
    commitProbe('P30-per-cell-hash-headers.csv')
    const days = withDb((db) =>
      db.prepare('SELECT DISTINCT coordinate_day_label d FROM elective_preferences ORDER BY d').all().map((r) => r.d)
    )
    expect(days).toEqual(['Monday', 'Wednesday'])
  })
})

// ---------------------------------------------------------------------------
// T285 SLICE C — normalised exports. Neither of these has a rank in its HEADER:
// P31 puts the rank in a CELL (one row per (camper, rank, activity)), and P32
// puts the ACTIVITY in the header with the rank in the cell.
// ---------------------------------------------------------------------------
describe('T285 slice C — tidy/long and inverted layouts', () => {
  it('P31: a tidy/long export reads one preference per row', () => {
    // What a normalised form backend emits. Columns are name, "Choice Rank",
    // "Activity Name", and the rank and the label are both CELL values.
    seedActivities(CORPUS_ACTIVITIES)

    const result = commitProbe('P31-tidy-long-format.csv')
    expect(result.error).toBeNull()
    expect(result.ok).toBe(true)

    expect(result.counts.campers).toBe(8)
    expect(result.counts.preferences).toBe(24) // 8 campers x 3 ranks
    expect(result.counts.preferences).toBe(
      withDb((db) => db.prepare('SELECT COUNT(*) c FROM elective_preferences').get().c)
    )

    const ari = withDb((db) =>
      db
        .prepare(
          `SELECT p.rank, ch.label FROM elective_preferences p
             JOIN campers c ON c.id = p.camper_id
             JOIN elective_choices ch ON ch.id = p.choice_id
            WHERE c.display_name = 'Ari Feldspar' ORDER BY p.rank`
        )
        .all()
    )
    expect(ari).toEqual([
      { rank: 1, label: 'Archery' },
      { rank: 2, label: 'Ceramics' },
      { rank: 3, label: 'Woodworking' },
    ])
  })

  it('P31: one name on many rows at DISTINCT ranks is one camper, not a collision', () => {
    // THE MULTIPLICITY QUESTION AGAIN, in its third costume. A long-format sheet
    // gives one child three rows BY DESIGN. The pre-slice-C rule refused any name
    // on several rows that shared a scope, and a long row has no coordinate, so
    // all three shared the empty one.
    //
    // The general rule this forced: a row occupies the (coordinate, rank) SLOTS it
    // fills, and two rows for one name collide only if their slot sets INTERSECT.
    // A wide row fills every rank, so two wide rows always collide at rank 1; a
    // long row fills exactly one, so rows at different ranks never do.
    seedActivities(CORPUS_ACTIVITIES)
    const result = commitProbe('P31-tidy-long-format.csv')
    expect(result.ok).toBe(true)
    expect(result.sameNameCampers).toEqual([])
    // One camper record per name, holding all three of their choices.
    expect(withDb((db) => db.prepare('SELECT COUNT(*) c FROM campers').get().c)).toBe(8)
  })

  it('P31 non-vacuity: the SAME name at the SAME rank twice is still refused', () => {
    // The widening must stay a widening. Two rows claiming one child's first
    // choice is genuinely unreadable, long format or not.
    seedActivities(['Swim', 'Archery'])
    const result = commitBytes(
      'long-same-rank.csv',
      'Camper Name,Choice Rank,Activity Name\nDalia Tuff,1,Swim\nDalia Tuff,1,Archery\n'
    )
    expect(result.ok).toBe(false)
    expect(result.error).toMatch(/more than one row/)
  })

  it('P32: an inverted matrix reads the HEADER as the activity and the CELL as the rank', () => {
    // One column per ACTIVITY, the cell holds the rank number. Recognising this
    // needs the camp's own catalog — the header names entities the camp already
    // has, which is RESOLVE doing the work rather than a shape heuristic.
    seedActivities(CORPUS_ACTIVITIES)
    seedGroups(['Upper Division'])

    const result = commitProbe('P32-activities-as-columns.csv')
    expect(result.error).toBeNull()
    expect(result.ok).toBe(true)

    const ari = withDb((db) =>
      db
        .prepare(
          `SELECT p.rank, ch.label FROM elective_preferences p
             JOIN campers c ON c.id = p.camper_id
             JOIN elective_choices ch ON ch.id = p.choice_id
            WHERE c.display_name = 'Ari Feldspar' ORDER BY p.rank`
        )
        .all()
    )
    // Ari's row reads Swim=1, Archery=2, Ceramics=3, the rest blank.
    expect(ari).toEqual([
      { rank: 1, label: 'Swim' },
      { rank: 2, label: 'Archery' },
      { rank: 3, label: 'Ceramics' },
    ])
    expect(result.counts.campers).toBe(8)
    expect(result.counts.preferences).toBe(24) // 8 campers x 3 ranks each

    // The division is still resolved — the layout changed, not the resolvers.
    expect(
      withDb((db) => db.prepare("SELECT group_id FROM campers WHERE display_name = 'Ari Feldspar'").get().group_id)
    ).not.toBeNull()
  })

  it('P32 non-vacuity: an empty catalog cannot invent an inverted layout', () => {
    // The layout is recognised BY the catalog. With nothing to match, the headers
    // are not activities as far as this app knows, so the sheet must NOT be read
    // as an inverted matrix — it has no rank columns at all, and saying otherwise
    // would be a shape guess dressed as a resolution.
    const result = commitBytes(
      'inverted-no-catalog.csv',
      'Camper Name,Swim,Archery\nDalia Tuff,1,2\n'
    )
    expect(result.ok).toBe(false)
    expect(result.error).toMatch(/could not find/)
  })
})

// ---------------------------------------------------------------------------
// T285 SLICE D — the workbook reader. `readRows` was FIRST SHEET ONLY by a
// deliberate decision, and the reason recorded there is real: "silently
// concatenating tabs would merge two different submissions into one run."
//
// That hazard is ANSWERED rather than ignored. The fix is per-sheet
// CLASSIFICATION, never concatenation: pick the one sheet that maps as a
// preference sheet, and report every other by name.
// ---------------------------------------------------------------------------
describe('T285 slice D — the multi-sheet workbook', () => {
  it('P26: reads the SELECTIONS sheet, not the first one, and names the sheets it skipped', () => {
    seedActivities(CORPUS_ACTIVITIES)
    seedGroups(['Upper Division', 'Middle Division', 'Lower Division'])

    const result = commitProbe('P26-mixed-workbook-pref.xlsx')
    expect(result.error).toBeNull()
    expect(result.ok).toBe(true)

    // Exactly the Selections sheet: 10 campers x 3 ranks.
    expect(result.counts.campers).toBe(10)
    expect(result.counts.preferences).toBe(30)
    expect(result.counts.preferences).toBe(
      withDb((db) => db.prepare('SELECT COUNT(*) c FROM elective_preferences').get().c)
    )

    const names = withDb((db) =>
      db.prepare('SELECT display_name FROM campers ORDER BY display_name').all().map((r) => r.display_name)
    )
    expect(names).toHaveLength(10)
    expect(names).toContain('Adin Chertwood')
    // Nothing from the menu or the planner became a camper.
    expect(names).not.toContain('Period 1')
    expect(names).not.toContain('Period')

    // The two unread sheets are NAMED. A workbook silently reduced to one tab is
    // the same silence §12.0 forbids everywhere else.
    const unread = residueOf(result, 'UNREAD_SHEET')
    expect(unread.map((r) => r.sheet).sort()).toEqual(['Offerings Menu', 'Planner'])
    for (const u of unread) expect(u.message).toContain(u.sheet)
  })

  it('P26 constraint 1: the OFFERINGS MENU is not read as preferences', () => {
    // The menu tab is a day x period grid of what is OFFERED. Committing its
    // contents as camper choices is T224 verbatim — a selection workbook once
    // committed its column headers as 33 camp groups and again as 33 tiers.
    seedActivities(CORPUS_ACTIVITIES)
    seedGroups(['Upper Division', 'Middle Division', 'Lower Division'])

    const result = commitProbe('P26-mixed-workbook-pref.xlsx')
    expect(result.ok).toBe(true)

    // The menu packs two activities into a cell ("Photography, Rock Climbing").
    // If it had been read, that string would exist as a choice label.
    const labels = withDb((db) => db.prepare('SELECT label FROM elective_choices').all().map((r) => r.label))
    for (const l of labels) expect(l).not.toMatch(/,/)
    // And no group or tier was created from any sheet.
    expect(withDb((db) => db.prepare('SELECT COUNT(*) c FROM groups').get().c)).toBe(3)
    expect(withDb((db) => db.prepare('SELECT COUNT(*) c FROM tiers').get().c)).toBe(0)
  })

  it('a single-sheet file reports no unread sheets', () => {
    // Non-vacuity: the residue must describe this workbook, not fire always.
    seedActivities(CORPUS_ACTIVITIES)
    const result = commitProbe('P01-kind3-canonical.csv')
    expect(result.ok).toBe(true)
    expect(residueOf(result, 'UNREAD_SHEET')).toHaveLength(0)
  })
})
