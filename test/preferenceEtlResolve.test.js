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

  it('P38: a rank column renamed out of recognition is REPORTED, not silently dropped', () => {
    // P37 -> P38 renamed '#3' to 'Third Choice'. Today that silently drops rank
    // 3 for every camper with ok=true and no residue. The loud half (T279) is
    // that the unassignable column is named.
    seedActivities(CORPUS_ACTIVITIES)

    const result = commitProbe('P38-kind3-reimport-drifted.csv')
    expect(result.ok).toBe(true)

    const unrecognised = residueOf(result, 'UNRECOGNISED_COLUMN')
    expect(unrecognised.map((r) => r.header)).toContain('Third Choice')
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
