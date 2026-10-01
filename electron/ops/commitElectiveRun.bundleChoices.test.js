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
import { buildPreferenceLookup, rankLabel, UNORDERED_RANK_LABEL } from '../../src/screens/elective/run/camperElectiveWeek.js'
import { getElectiveRun } from './getElectiveRun.js'

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

  it("binds the ASSIGNMENT to the SAME flat choice the preference got — the join is not broken", () => {
    // Board item 9b's asymmetry: the preference loop already wrote the flat
    // choice minted on demand; the assignment loop used to null it out
    // instead, so an assignment-and-preference join for the same camper+label
    // missed and the run view rendered the unordered bucket for a rank-1
    // request. Both rows must point at the SAME minted choice.
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
        preferences: [{
          camper_id: 'cam-sr', occurrence_id: srOccurrence.id, label: 'Archery', labelKey: ARCHERY_KEY,
          rank: 1, rank_kind: 'cell-choice',
        }],
        sameNameCampers: [],
        skippedRows: [],
      },
      assignments: [{
        camper_id: 'cam-sr', occurrence_id: srOccurrence.id, labelKey: ARCHERY_KEY,
        activity_id: 'act-archery', preference_rank: 1, flags: [],
      }],
    })
    expect(out.ok).toBe(true)

    const pref = db.prepare('SELECT * FROM elective_preferences WHERE run_id = ? AND camper_id = ?').get(runId, 'cam-sr')
    const assignment = db.prepare('SELECT * FROM elective_assignments WHERE run_id = ? AND camper_id = ?').get(runId, 'cam-sr')
    expect(pref.choice_id).not.toBeNull()
    expect(assignment.choice_id).toBe(pref.choice_id)

    // The run view derives its rank label from this exact join
    // (buildPreferenceLookup/rankLabel in camperElectiveWeek.js). Prove the
    // join actually resolves to a numbered choice, not the unordered bucket,
    // which is the user-visible symptom this fix repairs.
    const lookup = buildPreferenceLookup({
      preferences: [pref],
      occurrences,
      days: [{ id: 'day-1', label: 'Monday' }],
      timeBlocks: [{ id: 'tb-1', name: 'Period 1' }],
    })
    const bound = lookup(assignment)
    expect(bound).toBeTruthy()
    expect(rankLabel(assignment.preference_rank, bound.rankKind)).toBe('First choice')
    expect(rankLabel(assignment.preference_rank, bound.rankKind)).not.toBe(UNORDERED_RANK_LABEL)
    db.close()
  })

  it('an assignment-only mismatch (the camper never ranked this label) stays null — no flat choice exists to bind to', () => {
    // `labelsNeedingFlatChoice` is computed from PREFERENCES only. A solver
    // fallback placement for a camper who never ranked this label at all
    // means no flat choice was ever minted, so `resolved.choiceId` is
    // genuinely null here — that is correct, not a leftover of the old bug.
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
        preferences: [],
        sameNameCampers: [],
        skippedRows: [],
      },
      assignments: [{
        camper_id: 'cam-sr', occurrence_id: srOccurrence.id, labelKey: ARCHERY_KEY,
        activity_id: 'act-archery', preference_rank: null, flags: [],
      }],
    })
    expect(out.ok).toBe(true)
    const assignment = db.prepare('SELECT * FROM elective_assignments WHERE run_id = ? AND camper_id = ?').get(runId, 'cam-sr')
    expect(assignment.choice_id).toBeNull()
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

// Round 3 (Red Hat F3) — the finding must carry the TIER COMMIT TIME actually
// resolved, not leave a grouping screen to re-derive it later. The empty-
// division-cell shape: this commit's sheet cell is empty for the camper's
// Division column (so this write clears campers.division_label to null, per
// T279 §12.2a's "an empty cell in a division column IS a fact worth
// recording"), but tier RESOLUTION for this commit fell back to the camper's
// PRE-COMMIT roster division (read before the transaction) — which can be a
// DIFFERENT tier than the camper's roster GROUP names. A render-time
// re-derivation off the POST-commit campers row would silently fall through
// to the group's tier instead, naming a division the mismatch was never
// generated against.
describe('Round 3 F3 — the finding carries the tier commit time resolved, immune to its own division_label write', () => {
  it("tier_id on the finding is the PRE-write roster division's tier, not the POST-write group's tier", () => {
    const { db, campId } = freshDb()
    // bundleTiers: ['tier-jr'] only — Seniors (tier-sr) is NOT covered.
    seedTwoTierCamp(db, campId, { scopeMode: 'only', bundleTiers: ['tier-jr'] })
    // Pre-existing roster row (an earlier import): division_label 'Seniors',
    // but group_id pointing at the JUNIORS group — division beats group per
    // camperElectiveIdentity.js's own stated precedence, so Seniors is what
    // THIS commit's tier resolution actually used.
    db.prepare('INSERT INTO campers (id, camp_id, display_name, group_id, division_label) VALUES (?, ?, ?, ?, ?)')
      .run('cam-x', campId, 'Robin Stale', 'grp-jr', 'Seniors')
    const runId = randomUUID()
    const occurrences = twoTierOccurrences(runId)
    const srOccurrence = occurrences.find((o) => o.tier_id === 'tier-sr' && o.time_block_id === 'tb-1')
    const out = commitElectiveRun(db, {
      campId, deviceId: 'dev-1', name: 'Week 1', runId, occurrences,
      parsed: {
        // THIS sheet's Division column is empty for this camper
        // (division_observed true, division_label absent) — the write below
        // clears campers.division_label to null, AFTER resolution already
        // used the pre-write 'Seniors'.
        campers: [{ id: 'cam-x', display_name: 'Robin Stale', external_id: null, group_id: null, division_observed: true }],
        choices: [{ label: 'Archery', labelKey: ARCHERY_KEY }],
        preferences: [{ camper_id: 'cam-x', occurrence_id: srOccurrence.id, label: 'Archery', labelKey: ARCHERY_KEY, rank: 1 }],
        sameNameCampers: [],
        skippedRows: [],
      },
      assignments: [],
    })
    expect(out.ok).toBe(true)

    // The write DID clear division_label, confirming the trap is real.
    expect(db.prepare('SELECT division_label, group_id FROM campers WHERE id = ?').get('cam-x'))
      .toEqual({ division_label: null, group_id: 'grp-jr' })

    const mismatch = out.findings.find((f) => f.kind === 'BUNDLE_TIER_NOT_COVERED')
    expect(mismatch).toBeTruthy()
    // tier-sr (Seniors), the tier resolution ACTUALLY used — never tier-jr
    // (Juniors), which is only what a POST-write re-derivation would guess
    // via the stale group_id.
    expect(mismatch.tier_id).toBe('tier-sr')
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

// board item 9b round 3 (item 3) — BUNDLE_TIER_NOT_COVERED persists through
// the T320 elective_run_findings path, mirroring SHEET_CAMPER_WITHOUT_PREFERENCE.
// Today it is response-only (commitElectiveRun.js's return `findings` array),
// so a cold-reopened draft shows no grouped bundle-mismatch row at all.
describe('BUNDLE_TIER_NOT_COVERED persists (board item 9b round 3, item 3)', () => {
  it('commit -> elective_run_findings carries NO camper name and NO tier_id column; cold getElectiveRun carries the finding, its label recovered via elective_choices', () => {
    const { db, campId } = freshDb()
    seedTwoTierCamp(db, campId, { scopeMode: 'only', bundleTiers: ['tier-jr'] })
    const runId = randomUUID()
    const occurrences = twoTierOccurrences(runId)
    const srOccurrence = occurrences.find((o) => o.tier_id === 'tier-sr' && o.time_block_id === 'tb-1')
    const out = commitElectiveRun(db, {
      campId, deviceId: 'dev-1', name: 'Week 1', runId, occurrences, assignments: [],
      parsed: {
        campers: [{ id: 'cam-sr', display_name: 'Noa Katz', external_id: null, group_id: null, division_label: 'Seniors' }],
        choices: [{ label: 'Archery', labelKey: ARCHERY_KEY }],
        preferences: [{ camper_id: 'cam-sr', occurrence_id: srOccurrence.id, label: 'Archery', labelKey: ARCHERY_KEY, rank: 2 }],
        sameNameCampers: [],
        skippedRows: [],
      },
    })
    expect(out.ok).toBe(true)

    const row = db.prepare(
      "SELECT * FROM elective_run_findings WHERE run_id = ? AND kind = 'BUNDLE_TIER_NOT_COVERED'"
    ).get(runId)
    expect(row).toBeTruthy()
    expect(row.camper_id).toBe('cam-sr')
    expect(row.choice_id).not.toBeNull()
    expect(row.occurrence_id).toBeNull()
    // NO new column, and no real name in a replicated table — the response
    // message (out.findings) embeds the display name; the persisted row must
    // not (T249/ADR 2026-09-23 Q4).
    expect('tier_id' in row).toBe(false)
    expect(row.message).not.toContain('Noa Katz')

    const state = getElectiveRun(db, { runId })
    const found = state.eligibilityFindings.find((f) => f.kind === 'BUNDLE_TIER_NOT_COVERED')
    expect(found).toBeTruthy()
    expect(found.camper_id).toBe('cam-sr')
    // Recovered via the LEFT JOIN to elective_choices, normalized to the
    // choice's own stored spelling ("Archery") — see the casing-normalization
    // test below for why that is an incidental improvement, not a regression.
    expect(found.label).toBe('Archery')
    db.close()
  })

  it('a regenerate is GENERATION-FILTERED on read: the prior generation’s row still exists, but only the current generation’s is live', () => {
    const { db, campId } = freshDb()
    seedTwoTierCamp(db, campId, { scopeMode: 'only', bundleTiers: ['tier-jr'] })
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
    const first = commitElectiveRun(db, { campId, deviceId: 'dev-1', name: 'Week 1', runId, parsed, assignments: [], occurrences })
    expect(first.ok).toBe(true)
    const second = commitElectiveRun(db, { campId, deviceId: 'dev-1', name: 'Week 1', runId, parsed, assignments: [], occurrences })
    expect(second.ok).toBe(true)
    expect(second.runId).toBe(first.runId)

    const allRows = db.prepare(
      "SELECT solver_generation FROM elective_run_findings WHERE run_id = ? AND kind = 'BUNDLE_TIER_NOT_COVERED'"
    ).all(runId)
    // NOT pruned — both generations' rows physically exist, same as the
    // eligibility kinds and SHEET_CAMPER_WITHOUT_PREFERENCE.
    expect(allRows.length).toBeGreaterThanOrEqual(2)

    const state = getElectiveRun(db, { runId })
    const live = state.eligibilityFindings.filter((f) => f.kind === 'BUNDLE_TIER_NOT_COVERED')
    expect(live).toHaveLength(1)
    db.close()
  })

  it('two distinct bundle-label mismatches for ONE camper write two DISTINCT rows (distinct choice_ids, no collision)', () => {
    const { db, campId } = freshDb()
    seedTwoTierCamp(db, campId, { scopeMode: 'only', bundleTiers: ['tier-jr'] })
    db.prepare('INSERT INTO activities (id, camp_id, name) VALUES (?, ?, ?)').run('act-gaga', campId, 'Gaga')
    db.prepare('INSERT INTO elective_bundles (id, elective_set_id, activity_id, name, scope_mode) VALUES (?, ?, ?, ?, ?)')
      .run('bundle-2', 'set-1', 'act-gaga', 'Gaga', 'only')
    db.prepare('INSERT INTO elective_bundle_periods (id, bundle_id, day_id, time_block_id) VALUES (?, ?, ?, ?)')
      .run('bp-3', 'bundle-2', 'day-1', 'tb-1')
    db.prepare('INSERT INTO elective_bundle_periods (id, bundle_id, day_id, time_block_id) VALUES (?, ?, ?, ?)')
      .run('bp-4', 'bundle-2', 'day-1', 'tb-2')
    db.prepare('INSERT INTO elective_bundle_tiers (id, bundle_id, tier_id) VALUES (?, ?, ?)').run(randomUUID(), 'bundle-2', 'tier-jr')

    const runId = randomUUID()
    const occurrences = twoTierOccurrences(runId)
    const srOccurrence = occurrences.find((o) => o.tier_id === 'tier-sr' && o.time_block_id === 'tb-1')
    const parsed = {
      campers: [{ id: 'cam-sr', display_name: 'Noa Katz', external_id: null, group_id: null, division_label: 'Seniors' }],
      choices: [{ label: 'Archery', labelKey: ARCHERY_KEY }, { label: 'Gaga', labelKey: 'gaga' }],
      preferences: [
        { camper_id: 'cam-sr', occurrence_id: srOccurrence.id, label: 'Archery', labelKey: ARCHERY_KEY, rank: 1 },
        { camper_id: 'cam-sr', occurrence_id: srOccurrence.id, label: 'Gaga', labelKey: 'gaga', rank: 2 },
      ],
      sameNameCampers: [],
      skippedRows: [],
    }
    const out = commitElectiveRun(db, { campId, deviceId: 'dev-1', name: 'Week 1', runId, parsed, assignments: [], occurrences })
    expect(out.ok).toBe(true)

    const rows = db.prepare(
      "SELECT choice_id FROM elective_run_findings WHERE run_id = ? AND kind = 'BUNDLE_TIER_NOT_COVERED'"
    ).all(runId)
    expect(rows).toHaveLength(2)
    expect(new Set(rows.map((r) => r.choice_id)).size).toBe(2)
    db.close()
  })

  // F4 (round 2 review) — KNOWN DEFECT, documented not fixed this round. Two
  // ASSIGNMENT-ONLY mismatches (a solver fallback placement for a camper who
  // never ranked the label — see the "an assignment-only mismatch ... stays
  // null" test above) for ONE camper, on TWO different bundle labels, both
  // have `choice_id: null` (labelsNeedingFlatChoice is built from
  // `parsed.preferences` only, so no flat choice is ever minted for either
  // label). deriveElectiveRunFindingId(runId, gen, 'BUNDLE_TIER_NOT_COVERED',
  // camperId, choiceId, null) is then IDENTICAL for both — same camperId, same
  // null choiceId — so the second write silently collapses into the first and
  // one mismatch is lost from the persisted table.
  //
  // NOT FIXED: the obvious fix (pre-scan assignments in
  // `labelsNeedingFlatChoice` so a flat choice is always minted) is not a
  // small change — a minted choice would then also flow into the assignment
  // loop's `choice_id: resolved.choiceId` write (commitElectiveRun.js
  // ~line 803), changing assignment-write behaviour an earlier round
  // deliberately set to null to fix a real outage (see that loop's "ROUND 2
  // CORRECTION" comment), and it would move the acceptance-fixture numbers.
  // That is a design decision for the owner, not a bugfix for this round.
  //
  // This test PINS the current (wrong) behaviour — ONE row where TWO are
  // expected — as a tripwire: if a future change to `deriveElectiveRunFindingId`
  // or `labelsNeedingFlatChoice` fixes this, the assertion below goes red and
  // must be updated to `toHaveLength(2)` rather than silently drifting.
  it('F4 — two ASSIGNMENT-ONLY mismatches for ONE camper on two different labels collide to ONE persisted row (known defect, pinned)', () => {
    const { db, campId } = freshDb()
    seedTwoTierCamp(db, campId, { scopeMode: 'only', bundleTiers: ['tier-jr'] })
    db.prepare('INSERT INTO activities (id, camp_id, name) VALUES (?, ?, ?)').run('act-gaga', campId, 'Gaga')
    db.prepare('INSERT INTO elective_bundles (id, elective_set_id, activity_id, name, scope_mode) VALUES (?, ?, ?, ?, ?)')
      .run('bundle-2', 'set-1', 'act-gaga', 'Gaga', 'only')
    db.prepare('INSERT INTO elective_bundle_periods (id, bundle_id, day_id, time_block_id) VALUES (?, ?, ?, ?)')
      .run('bp-3', 'bundle-2', 'day-1', 'tb-1')
    db.prepare('INSERT INTO elective_bundle_periods (id, bundle_id, day_id, time_block_id) VALUES (?, ?, ?, ?)')
      .run('bp-4', 'bundle-2', 'day-1', 'tb-2')
    db.prepare('INSERT INTO elective_bundle_tiers (id, bundle_id, tier_id) VALUES (?, ?, ?)').run(randomUUID(), 'bundle-2', 'tier-jr')

    const runId = randomUUID()
    const occurrences = twoTierOccurrences(runId)
    const srOccurrence = occurrences.find((o) => o.tier_id === 'tier-sr' && o.time_block_id === 'tb-1')
    const out = commitElectiveRun(db, {
      campId, deviceId: 'dev-1', name: 'Week 1', runId, occurrences,
      parsed: {
        campers: [{ id: 'cam-sr', display_name: 'Noa Katz', external_id: null, group_id: null, division_label: 'Seniors' }],
        choices: [{ label: 'Archery', labelKey: ARCHERY_KEY }, { label: 'Gaga', labelKey: 'gaga' }],
        // No preferences at all — both mismatches are ASSIGNMENT-ONLY.
        preferences: [],
        sameNameCampers: [],
        skippedRows: [],
      },
      assignments: [
        { camper_id: 'cam-sr', occurrence_id: srOccurrence.id, labelKey: ARCHERY_KEY, activity_id: 'act-archery', preference_rank: null, flags: [] },
        { camper_id: 'cam-sr', occurrence_id: srOccurrence.id, labelKey: 'gaga', activity_id: 'act-gaga', preference_rank: null, flags: [] },
      ],
    })
    expect(out.ok).toBe(true)

    // The session response still has two (noteMismatch dedupes on
    // `${camperId}::${labelKey}`, and the two labels differ) — this defect is
    // specifically in the PERSISTED id, not the in-session array.
    expect(out.findings.filter((f) => f.kind === 'BUNDLE_TIER_NOT_COVERED')).toHaveLength(2)

    const persisted = db.prepare(
      "SELECT * FROM elective_run_findings WHERE run_id = ? AND kind = 'BUNDLE_TIER_NOT_COVERED'"
    ).all(runId)
    // CORRECT VALUE, when this is fixed: 2 (one row per label). Today: 1 —
    // the second write collapses into the first because both share the same
    // derived id (null choice_id, same camper_id).
    expect(persisted).toHaveLength(1)
    db.close()
  })

  // Round 2 F1 — the SESSION response (`out.findings`, what DraftRunView.jsx
  // receives as the `danglingFindings` prop the moment this commit returns)
  // used to carry `label` + `tier_id` but NO `choice_id`, while the
  // PERSISTED finding (read back via getElectiveRun's LEFT JOIN) carries
  // `choice_id`. DraftRunView's merge Map needs both sides to key on the same
  // identity (camper_id + choice_id) for a camper with two distinct mismatches
  // not to collapse to one — see that file's `bundleMismatchFindings` comment.
  it('the session response findings array carries choice_id for a BUNDLE_TIER_NOT_COVERED entry, distinct per label', () => {
    const { db, campId } = freshDb()
    seedTwoTierCamp(db, campId, { scopeMode: 'only', bundleTiers: ['tier-jr'] })
    db.prepare('INSERT INTO activities (id, camp_id, name) VALUES (?, ?, ?)').run('act-gaga', campId, 'Gaga')
    db.prepare('INSERT INTO elective_bundles (id, elective_set_id, activity_id, name, scope_mode) VALUES (?, ?, ?, ?, ?)')
      .run('bundle-2', 'set-1', 'act-gaga', 'Gaga', 'only')
    db.prepare('INSERT INTO elective_bundle_periods (id, bundle_id, day_id, time_block_id) VALUES (?, ?, ?, ?)')
      .run('bp-3', 'bundle-2', 'day-1', 'tb-1')
    db.prepare('INSERT INTO elective_bundle_periods (id, bundle_id, day_id, time_block_id) VALUES (?, ?, ?, ?)')
      .run('bp-4', 'bundle-2', 'day-1', 'tb-2')
    db.prepare('INSERT INTO elective_bundle_tiers (id, bundle_id, tier_id) VALUES (?, ?, ?)').run(randomUUID(), 'bundle-2', 'tier-jr')

    const runId = randomUUID()
    const occurrences = twoTierOccurrences(runId)
    const srOccurrence = occurrences.find((o) => o.tier_id === 'tier-sr' && o.time_block_id === 'tb-1')
    const parsed = {
      campers: [{ id: 'cam-sr', display_name: 'Noa Katz', external_id: null, group_id: null, division_label: 'Seniors' }],
      choices: [{ label: 'Archery', labelKey: ARCHERY_KEY }, { label: 'Gaga', labelKey: 'gaga' }],
      preferences: [
        { camper_id: 'cam-sr', occurrence_id: srOccurrence.id, label: 'Archery', labelKey: ARCHERY_KEY, rank: 1 },
        { camper_id: 'cam-sr', occurrence_id: srOccurrence.id, label: 'Gaga', labelKey: 'gaga', rank: 2 },
      ],
      sameNameCampers: [],
      skippedRows: [],
    }
    const out = commitElectiveRun(db, { campId, deviceId: 'dev-1', name: 'Week 1', runId, parsed, assignments: [], occurrences })
    expect(out.ok).toBe(true)

    const mismatches = out.findings.filter((f) => f.kind === 'BUNDLE_TIER_NOT_COVERED')
    expect(mismatches).toHaveLength(2)
    for (const m of mismatches) expect(m.choice_id).not.toBeNull()
    expect(new Set(mismatches.map((m) => m.choice_id)).size).toBe(2)
    db.close()
  })

  // BOARD ITEM 9b round 3 — today the response-only message's per-entry
  // `label` field is "Archery" (the sheet's own spelling) for a camper whose
  // PREFERENCE hit the mismatch, but only the lowercase canonical labelKey
  // ("archery") for a DIFFERENT camper whose mismatch came from their
  // ASSIGNMENT alone (noteMismatch's `label` param: `p.label` vs
  // `a.labelKey`, commitElectiveRun.js's two call sites) — so a director
  // reading both in one run sees inconsistent casing. Persisting choice_id
  // and recovering `label` by joining elective_choices on the READ side
  // (getElectiveRun.js) normalizes BOTH to the choice's one stored spelling,
  // regardless of which loop first noted the mismatch. Two DIFFERENT campers
  // hitting the SAME label is required to exercise this: one camper's
  // preference mints and mismatches first (sets labelsNeedingFlatChoice and
  // choiceIdByKey for "archery" before either write loop runs), so the
  // second camper's assignment-only mismatch resolves to that SAME
  // already-minted flat choice rather than null.
  it('two DIFFERENT campers hitting the same label — one via preference, one via assignment-only — both read back the choice’s stored spelling', () => {
    const { db, campId } = freshDb()
    seedTwoTierCamp(db, campId, { scopeMode: 'only', bundleTiers: ['tier-jr'] })
    const runId = randomUUID()
    const occurrences = twoTierOccurrences(runId)
    const srOccurrence = occurrences.find((o) => o.tier_id === 'tier-sr' && o.time_block_id === 'tb-1')
    const out = commitElectiveRun(db, {
      campId, deviceId: 'dev-1', name: 'Week 1', runId, occurrences,
      parsed: {
        campers: [
          { id: 'cam-sr1', display_name: 'Noa Katz', external_id: null, group_id: null, division_label: 'Seniors' },
          { id: 'cam-sr2', display_name: 'Omer Levi', external_id: null, group_id: null, division_label: 'Seniors' },
        ],
        choices: [{ label: 'Archery', labelKey: ARCHERY_KEY }],
        preferences: [
          { camper_id: 'cam-sr1', occurrence_id: srOccurrence.id, label: 'Archery', labelKey: ARCHERY_KEY, rank: 1 },
        ],
        sameNameCampers: [],
        skippedRows: [],
      },
      assignments: [{
        camper_id: 'cam-sr2', occurrence_id: srOccurrence.id, labelKey: ARCHERY_KEY,
        activity_id: 'act-archery', preference_rank: null, flags: [],
      }],
    })
    expect(out.ok).toBe(true)

    // Confirms the premise: the OLD response-only shape really did carry two
    // different spellings for the two campers.
    const responseLabels = out.findings
      .filter((f) => f.kind === 'BUNDLE_TIER_NOT_COVERED')
      .map((f) => f.label)
      .sort()
    expect(responseLabels).toEqual(['Archery', 'archery'])

    const state = getElectiveRun(db, { runId })
    const found = state.eligibilityFindings.filter((f) => f.kind === 'BUNDLE_TIER_NOT_COVERED')
    expect(found).toHaveLength(2)
    for (const f of found) expect(f.label).toBe('Archery')
    db.close()
  })
})
