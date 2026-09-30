// Board item 9b — the two ways a bundle choice failed to reach a camper's row,
// and the rule that replaces them.
//
// Kept out of commitElectiveRun.test.js because both need a TWO-TIER camp with
// occurrences for each, which that file's single-tier `seedBundleFixture` is
// deliberately not. Fixtures are fabricated; no real camper data is in this
// repo and none may be added.
import { describe, it, expect, afterEach } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { openLocalDb } from '../db/localDb.js'
import { commitElectiveRun } from './commitElectiveRun.js'
import {
  deriveElectiveOccurrenceId, deriveLinkedElectiveChoiceId, deriveElectiveChoiceId, electiveChoiceLabelKey,
} from './electiveDerivedIds.js'
import { buildElectiveAssignments } from '../../src/engine/buildElectiveAssignments.js'
import { deriveChoices } from '../../src/screens/elective/assignment/deriveChoices.js'

const dirs = []
function freshDb() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'shoresh-bundlechoice-'))
  dirs.push(dir)
  const db = openLocalDb(path.join(dir, 'shoresh.sqlite'))
  const campId = randomUUID()
  db.prepare('INSERT INTO camps (id, name, signing_secret) VALUES (?, ?, ?)').run(campId, 'Camp Test', 'a'.repeat(64))
  db.prepare('INSERT INTO devices (id, name) VALUES (?, ?)').run('dev-1', 'Host')
  return { db, campId }
}
afterEach(() => {
  for (const d of dirs) fs.rmSync(d, { recursive: true, force: true })
  dirs.length = 0
})

// A camp divisioned by TIER, which is the shape this whole file is about: the
// sheet's Division column carries "Juniors"/"Seniors" — the camp's own tier
// names, not bunk names — so `parsePreferenceSheet` resolves `division_label`
// and leaves `group_id` NULL (T279 §12.2a: it never invents a group).
function seedTwoTierCamp(db, campId, { scopeMode = 'all', bundleTiers = [] } = {}) {
  db.prepare('INSERT INTO tiers (id, camp_id, name) VALUES (?, ?, ?)').run('tier-jr', campId, 'Juniors')
  db.prepare('INSERT INTO tiers (id, camp_id, name) VALUES (?, ?, ?)').run('tier-sr', campId, 'Seniors')
  db.prepare('INSERT INTO groups (id, camp_id, name, tier_id) VALUES (?, ?, ?, ?)').run('grp-jr', campId, 'Bunk 1', 'tier-jr')
  db.prepare('INSERT INTO groups (id, camp_id, name, tier_id) VALUES (?, ?, ?, ?)').run('grp-sr', campId, 'Bunk 9', 'tier-sr')
  db.prepare('INSERT INTO elective_sets (id, camp_id, name) VALUES (?, ?, ?)').run('set-1', campId, 'Afternoon Electives')
  db.prepare('INSERT INTO activities (id, camp_id, name) VALUES (?, ?, ?)').run('act-archery', campId, 'Archery')
  db.prepare('INSERT INTO elective_bundles (id, elective_set_id, activity_id, name, scope_mode) VALUES (?, ?, ?, ?, ?)')
    .run('bundle-1', 'set-1', 'act-archery', 'Archery', scopeMode)
  db.prepare('INSERT INTO elective_bundle_periods (id, bundle_id, day_id, time_block_id) VALUES (?, ?, ?, ?)')
    .run('bp-1', 'bundle-1', 'day-1', 'tb-1')
  db.prepare('INSERT INTO elective_bundle_periods (id, bundle_id, day_id, time_block_id) VALUES (?, ?, ?, ?)')
    .run('bp-2', 'bundle-1', 'day-1', 'tb-2')
  for (const t of bundleTiers) {
    db.prepare('INSERT INTO elective_bundle_tiers (id, bundle_id, tier_id) VALUES (?, ?, ?)')
      .run(randomUUID(), 'bundle-1', t)
  }
}

// Real derived occurrence ids, never literals: `deriveChoices` recomputes each
// member offering's occurrence_id internally, so a hand-picked id would miss
// and the fixture would exhibit a false "period not part of this run".
function twoTierOccurrences(runId) {
  return ['tier-jr', 'tier-sr'].flatMap((tierId) =>
    ['tb-1', 'tb-2'].map((tb) => ({
      id: deriveElectiveOccurrenceId(runId, 'set-1', 'day-1', tb, tierId),
      elective_set_id: 'set-1', day_id: 'day-1', time_block_id: tb, tier_id: tierId,
    }))
  )
}

const ARCHERY_KEY = 'archery'

describe('a tier-divisioned camp — the sheet names a TIER, so group_id is null', () => {
  it("binds the preference AND the assignment to the camper's OWN tier's bundle choice, with no mismatch finding", () => {
    const { db, campId } = freshDb()
    seedTwoTierCamp(db, campId)
    const runId = randomUUID()
    const occurrences = twoTierOccurrences(runId)
    const srOccurrence = occurrences.find((o) => o.tier_id === 'tier-sr' && o.time_block_id === 'tb-1')

    const parsed = {
      campers: [{ id: 'cam-sr', display_name: 'Noa Katz', external_id: null, group_id: null, division_label: 'Seniors' }],
      choices: [{ label: 'Archery', labelKey: ARCHERY_KEY }],
      preferences: [{ camper_id: 'cam-sr', occurrence_id: srOccurrence.id, label: 'Archery', labelKey: ARCHERY_KEY, rank: 1 }],
      sameNameCampers: [],
      skippedRows: [],
    }
    const assignments = [{
      camper_id: 'cam-sr', occurrence_id: srOccurrence.id, labelKey: ARCHERY_KEY,
      activity_id: 'act-archery', preference_rank: 1, flags: [],
    }]

    const out = commitElectiveRun(db, {
      campId, deviceId: 'dev-1', name: 'Week 1', runId, parsed, assignments, occurrences,
    })
    expect(out.ok).toBe(true)

    // SENIORS' entry, not Juniors' — the tier came from the sheet's division,
    // which is the only place it exists for this camp.
    const expected = deriveLinkedElectiveChoiceId(out.runId, 'bundle-1', 'tier-sr')
    expect(db.prepare('SELECT choice_id FROM elective_preferences WHERE run_id = ?').get(runId).choice_id).toBe(expected)
    expect(db.prepare('SELECT choice_id FROM elective_assignments WHERE run_id = ?').get(runId).choice_id).toBe(expected)
    expect(out.findings.filter((f) => f.kind === 'BUNDLE_TIER_NOT_COVERED')).toEqual([])
    db.close()
  })
})

describe("a camper the bundle's scope genuinely does not cover", () => {
  // scope_mode 'only' listing Juniors alone. A Seniors camper is therefore
  // correctly identified AND genuinely outside the bundle — the one case the
  // resolver cannot fix, as opposed to the one above, which it can.
  function commitUncovered(db, campId) {
    seedTwoTierCamp(db, campId, { scopeMode: 'only', bundleTiers: ['tier-jr'] })
    const runId = randomUUID()
    const occurrences = twoTierOccurrences(runId)
    const srOccurrence = occurrences.find((o) => o.tier_id === 'tier-sr' && o.time_block_id === 'tb-1')
    const parsed = {
      campers: [
        { id: 'cam-jr', display_name: 'Ari Green', external_id: null, group_id: null, division_label: 'Juniors' },
        { id: 'cam-sr', display_name: 'Noa Katz', external_id: null, group_id: null, division_label: 'Seniors' },
      ],
      choices: [{ label: 'Archery', labelKey: ARCHERY_KEY }],
      preferences: [
        {
          camper_id: 'cam-jr', label: 'Archery', labelKey: ARCHERY_KEY, rank: 1,
          occurrence_id: occurrences.find((o) => o.tier_id === 'tier-jr' && o.time_block_id === 'tb-1').id,
        },
        { camper_id: 'cam-sr', occurrence_id: srOccurrence.id, label: 'Archery', labelKey: ARCHERY_KEY, rank: 2 },
      ],
      sameNameCampers: [],
      skippedRows: [],
    }
    const out = commitElectiveRun(db, {
      campId, deviceId: 'dev-1', name: 'Week 1', runId, parsed, assignments: [], occurrences,
    })
    return { out, runId, occurrences }
  }

  it('KEEPS their ranking as an ordinary choice AND still tells the director', () => {
    const { db, campId } = freshDb()
    const { out, runId } = commitUncovered(db, campId)
    expect(out.ok).toBe(true)

    // (a) the flat row exists, minted on demand for this label.
    const flatId = deriveElectiveChoiceId(runId, ARCHERY_KEY)
    const flat = db.prepare('SELECT * FROM elective_choices WHERE id = ?').get(flatId)
    expect(flat).toBeTruthy()
    expect(flat.is_linked).toBe(0)

    // (b) the preference is KEPT, bound to it, carrying the SHEET'S OWN rank.
    // Art. V: the engine surfaces a conflict, it never absorbs the answer.
    const pref = db.prepare('SELECT * FROM elective_preferences WHERE run_id = ? AND camper_id = ?').get(runId, 'cam-sr')
    expect(pref).toBeTruthy()
    expect(pref.choice_id).toBe(flatId)
    expect(pref.rank).toBe(2)

    // (c) AND the finding still fires. Keep-and-surface, not keep-or-surface.
    const mismatch = out.findings.find((f) => f.kind === 'BUNDLE_TIER_NOT_COVERED')
    expect(mismatch).toBeTruthy()
    expect(mismatch.camper_id).toBe('cam-sr')
    expect(mismatch.message).toContain('Noa Katz')
    // The old tail claimed the choice "could not be resolved" and that the
    // camper got nothing. Both are now false, and a false reassurance is worse
    // than silence.
    expect(mismatch.message).not.toContain('could not be resolved')
    expect(mismatch.message).toMatch(/ranking still counts/i)
    db.close()
  })

  it('is reported ONCE when the same camper hits it on a preference AND an assignment', () => {
    // The two loops hold the label differently — the preference loop has the
    // sheet's own spelling, the assignment loop only the canonical key — so a
    // dedupe keyed on whichever one the caller passes reports one camper's
    // single problem twice. Pinned because a refactor of the recorder made
    // exactly that mistake.
    const { db, campId } = freshDb()
    seedTwoTierCamp(db, campId, { scopeMode: 'only', bundleTiers: ['tier-jr'] })
    const runId = randomUUID()
    const occurrences = twoTierOccurrences(runId)
    const srOccurrence = occurrences.find((o) => o.tier_id === 'tier-sr' && o.time_block_id === 'tb-1')
    const out = commitElectiveRun(db, {
      campId, deviceId: 'dev-1', name: 'Week 1', runId, occurrences,
      parsed: {
        campers: [{ id: 'cam-sr', display_name: 'Noa Katz', external_id: null, group_id: null, division_label: 'Seniors' }],
        choices: [{ label: 'Archery', labelKey: ARCHERY_KEY }],
        preferences: [{ camper_id: 'cam-sr', occurrence_id: srOccurrence.id, label: 'Archery', labelKey: ARCHERY_KEY, rank: 1 }],
        sameNameCampers: [],
        skippedRows: [],
      },
      assignments: [{
        camper_id: 'cam-sr', occurrence_id: srOccurrence.id, labelKey: ARCHERY_KEY,
        activity_id: 'act-archery', preference_rank: 1, flags: [],
      }],
    })
    expect(out.ok).toBe(true)
    expect(out.findings.filter((f) => f.kind === 'BUNDLE_TIER_NOT_COVERED')).toHaveLength(1)
    db.close()
  })

  it("the COVERED camper is unaffected — they still get the bundle's own choice", () => {
    const { db, campId } = freshDb()
    const { runId } = commitUncovered(db, campId)
    const pref = db.prepare('SELECT * FROM elective_preferences WHERE run_id = ? AND camper_id = ?').get(runId, 'cam-jr')
    expect(pref.choice_id).toBe(deriveLinkedElectiveChoiceId(runId, 'bundle-1', 'tier-jr'))
    db.close()
  })

  it('mints NO flat row when every camper naming the label resolves — the minting is on demand', () => {
    // Otherwise this fix would change the stored row set of every camp that was
    // never broken, which is a migration by stealth.
    const { db, campId } = freshDb()
    seedTwoTierCamp(db, campId)
    const runId = randomUUID()
    const occurrences = twoTierOccurrences(runId)
    const out = commitElectiveRun(db, {
      campId, deviceId: 'dev-1', name: 'Week 1', runId, assignments: [], occurrences,
      parsed: {
        campers: [{ id: 'cam-jr', display_name: 'Ari Green', external_id: null, group_id: null, division_label: 'Juniors' }],
        choices: [{ label: 'Archery', labelKey: ARCHERY_KEY }],
        preferences: [{
          camper_id: 'cam-jr', label: 'Archery', labelKey: ARCHERY_KEY, rank: 1,
          occurrence_id: occurrences.find((o) => o.tier_id === 'tier-jr' && o.time_block_id === 'tb-1').id,
        }],
        sameNameCampers: [],
        skippedRows: [],
      },
    })
    expect(out.ok).toBe(true)
    expect(db.prepare('SELECT * FROM elective_choices WHERE id = ?').get(deriveElectiveChoiceId(runId, ARCHERY_KEY)))
      .toBeUndefined()
    db.close()
  })
})

// T301's own invariant, carried onto the new state: a bundle must place
// IDENTICALLY on the parsed-first-solve path and on a re-solve reconstructed
// from the stored rows. The flat choice is new state on that path, so the
// invariant has to be re-proved with it present — if the uncovered camper's
// preference were bound to some tier's bundle choice instead, the reconstructed
// solve would read a rank at a cell the first solve never saw one at.
describe('T301 invariant — a re-solve from the stored rows places identically', () => {
  it('produces the same assignments across the bundle occurrences', () => {
    const { db, campId } = freshDb()
    seedTwoTierCamp(db, campId, { scopeMode: 'only', bundleTiers: ['tier-jr'] })
    const runId = randomUUID()
    const occurrences = twoTierOccurrences(runId)
    const jrFirst = occurrences.find((o) => o.tier_id === 'tier-jr' && o.time_block_id === 'tb-1')
    const srFirst = occurrences.find((o) => o.tier_id === 'tier-sr' && o.time_block_id === 'tb-1')
    const offerings = occurrences.map((o) => ({
      occurrence_id: o.id, activity_id: 'act-archery', labelKey: ARCHERY_KEY, capacity: 999, minimum: null,
    }))
    const campers = [
      { id: 'cam-jr', display_name: 'Ari Green', external_id: null, group_id: null, division_label: 'Juniors' },
      { id: 'cam-sr', display_name: 'Noa Katz', external_id: null, group_id: null, division_label: 'Seniors' },
    ]
    const attendance = {
      'cam-jr': occurrences.filter((o) => o.tier_id === 'tier-jr').map((o) => o.id),
      'cam-sr': occurrences.filter((o) => o.tier_id === 'tier-sr').map((o) => o.id),
    }
    const parsedPreferences = [
      { camper_id: 'cam-jr', occurrence_id: jrFirst.id, label: 'Archery', labelKey: ARCHERY_KEY, rank: 1 },
      { camper_id: 'cam-sr', occurrence_id: srFirst.id, label: 'Archery', labelKey: ARCHERY_KEY, rank: 2 },
    ]
    const { choices: bundleChoices } = deriveChoices({
      bundles: db.prepare('SELECT * FROM elective_bundles').all(),
      bundlePeriods: db.prepare('SELECT * FROM elective_bundle_periods').all(),
      bundleTiers: db.prepare('SELECT * FROM elective_bundle_tiers').all(),
      occurrences, runId,
    })

    const first = buildElectiveAssignments({
      campers, occurrences, offerings, preferences: parsedPreferences, attendance, choices: bundleChoices,
    })

    const out = commitElectiveRun(db, {
      campId, deviceId: 'dev-1', name: 'Week 1', runId, assignments: first.assignments, occurrences,
      parsed: {
        campers, choices: [{ label: 'Archery', labelKey: ARCHERY_KEY }],
        preferences: parsedPreferences, sameNameCampers: [], skippedRows: [],
      },
    })
    expect(out.ok).toBe(true)

    // Reconstructed exactly as AssignmentPanel's re-solve does: stored rows,
    // choice_id and nothing else, plus the run's own choices.
    const storedChoices = db.prepare('SELECT * FROM elective_choices WHERE run_id = ?').all(runId)
    const storedPreferences = db
      .prepare('SELECT camper_id, occurrence_id, choice_id, rank FROM elective_preferences WHERE run_id = ?')
      .all(runId)

    // THE STORED STATE ITSELF, before any re-solve. A re-solve can only be as
    // right as what it reads, and the uncovered camper's row naming some OTHER
    // tier's linked choice is the specific way this could go wrong invisibly:
    // it would read back as a linked-choice ranking for a bundle that does not
    // reach them.
    const flatId = deriveElectiveChoiceId(runId, ARCHERY_KEY)
    const linkedIds = new Set(['tier-jr', 'tier-sr'].map((t) => deriveLinkedElectiveChoiceId(runId, 'bundle-1', t)))
    expect(storedChoices.some((c) => c.id === flatId)).toBe(true)
    const srRow = storedPreferences.find((p) => p.camper_id === 'cam-sr')
    expect(srRow.choice_id).toBe(flatId)
    expect(linkedIds.has(srRow.choice_id)).toBe(false)

    const second = buildElectiveAssignments({
      campers, occurrences, offerings, preferences: storedPreferences, attendance,
      choices: storedChoices.map((c) => ({
        id: c.id, label: c.label, labelKey: electiveChoiceLabelKey(c.label), is_linked: c.is_linked,
      })),
    })

    // preference_rank JOINS THE SHAPE. Without it this compares only seats, and
    // with one activity on offer the seats cannot differ whatever the choice
    // binding says — measured: a mutation binding the uncovered camper to a
    // foreign tier's choice left a seats-only comparison green.
    const shape = (a) => a
      .map((x) => `${x.camper_id}@${x.occurrence_id}=${x.activity_id}#${x.preference_rank}`)
      .sort()
    expect(shape(second.assignments)).toEqual(shape(first.assignments))
    expect(shape(first.assignments).length).toBeGreaterThan(0)
    db.close()
  })
})
