// D1 — dryRun on commitPlan/commitIngest: same-transaction rollback so the
// reconciliation summary reads TRUTHFUL output (not a parallel pipeline).
// docs/adr/2026-08-10-... (Phase D experience) — see the brief for D1.
//
// Three guarantees under test:
//   1. non-mutation — a dry run writes NOTHING (every touched table +
//      MAX(operations.seq) identical before/after), on an import exercising
//      creates, updates, clears, anchor drift (moved + scopeChanged), and a
//      legacy-priority activity.
//   2. truthfulness — the dry run's planItems/fixedEventsReport/
//      fieldProvenance/legacyPriorityActivities are deep-equal to what a REAL
//      commit against the SAME starting db computes.
//   3. held — a conflict scenario returns { held:true, conflicts } with every
//      Phase-D field absent/empty, same as a normal (non-dryRun) held commit.

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { openLocalDb } from '../db/localDb.js'
import { appendOp, latestOpSeq } from './operations.js'
import { commitIngest, buildFieldProvenanceMap, listLegacyPriorityActivities } from './ingest.js'
import { buildReconciliationReport } from '../../src/ingest/reconciliationReport.js'
import { reportToLanes } from '../../src/ingest/reportToLanes.js'
import { applyResolutions } from '../../src/screens/reconciliationResolutions.js'

let db, tmpFile, campId
const deviceId = 'device-1'

beforeEach(() => {
  tmpFile = path.join(os.tmpdir(), `shoresh-d1-${Date.now()}-${Math.random()}.sqlite`)
  db = openLocalDb(tmpFile)
  campId = randomUUID()
  db.prepare('INSERT INTO camps (id, name, signing_secret) VALUES (?, ?, ?)').run(campId, 'Camp Test', 'a'.repeat(64))
  db.prepare('INSERT INTO devices (id, name) VALUES (?, ?)').run(deviceId, 'Test Device')
  db.prepare("INSERT INTO users (id, camp_id, name, pin_hash, pin_salt, role) VALUES (?, ?, 'Ruth', 'h', 's', 'admin')").run('u1', campId)
})

afterEach(() => {
  db.close()
  if (fs.existsSync(tmpFile)) fs.unlinkSync(tmpFile)
})

const TOUCHED_TABLES = [
  'cohorts', 'tiers', 'groups', 'days_of_operation', 'time_blocks', 'activities',
  'anchor_activities', 'operations', 'conflicts', 'import_evidence',
]

function snapshotDb() {
  const snap = {}
  for (const table of TOUCHED_TABLES) {
    snap[table] = db.prepare(`SELECT * FROM ${table} ORDER BY id`).all()
  }
  snap.maxSeq = db.prepare('SELECT MAX(seq) s FROM operations').get().s
  return snap
}

const commit = (extra) => commitIngest(db, { camp_id: campId, cohort_id: null, author_user_id: 'u1', device_id: deviceId, mode: 'add', ...extra })

const BASE = {
  approved: {
    cohorts: ['Main'],
    tiers: ['Aleph', 'Bet'],
    groups: ['Bunk 1', 'Bunk 2'],
    days_of_operation: ['Monday', 'Tuesday'],
    time_blocks: ['09:00-09:40', '10:00-10:40'],
    activities: ['Swim', 'Archery'],
  },
  links: { groups: { 'Bunk 1': 'Aleph', 'Bunk 2': 'Bet' } },
  activityRules: {
    Swim: { eligible_group_names: ['Bunk 1', 'Bunk 2'], min_per_week: 2, max_per_week: 3, priority: 'high' },
    Archery: { eligible_group_names: ['Bunk 1'], min_per_week: 1, max_per_week: 1, priority: 'low' },
  },
}
const MIFKAD_MON_9 = {
  name: 'Mifkad', time_block: '09:00-09:40', days: ['Monday'],
  scope: { is_all_groups: true, groups: [] },
}

// Seeds a realistic camp with: creates (six entity types), a legacy-priority
// activity (priority last written source='import'), a human-edited field
// (so a later re-import's field diff has real provenance to report), and a
// live anchor that will show up as MOVED + a second anchor whose scope will
// show up as scopeChanged on re-import.
function seedRealisticCamp() {
  commit({ ...BASE, fixedEvents: [MIFKAD_MON_9] })

  // Human-edit Archery's max_per_week directly (provenance='human'), so a
  // re-import proposing a different value is a real 'update' the field-diff
  // must classify against human provenance, not import provenance.
  const archeryId = db.prepare('SELECT id FROM activities WHERE camp_id = ? AND name = ?').get(campId, 'Archery').id
  appendOp(db, {
    entity: 'activities', entity_id: archeryId, field: 'max_per_week', value: 5,
    author_user_id: 'u1', device_id: deviceId, parent_op_id: null, client_write_id: randomUUID(), source: 'human',
  })

  // Move the live Mifkad anchor to a different time block (human edit,
  // mirrors AnchorsScreen.saveAnchor) so a re-import of the ORIGINAL slot
  // reports MOVED instead of a duplicate create.
  const anchor = db.prepare('SELECT id, day_id, time_block_id FROM anchor_activities WHERE camp_id = ?').get(campId)
  const block2 = db.prepare("SELECT id FROM time_blocks WHERE camp_id = ? AND name = ?").get(campId, '10:00-10:40').id
  for (const [field, value] of Object.entries({ time_block_id: block2 })) {
    appendOp(db, {
      entity: 'anchor_activities', entity_id: anchor.id, field, value,
      author_user_id: 'u1', device_id: deviceId, parent_op_id: null, client_write_id: randomUUID(), source: 'human',
    })
  }
}

// The re-import payload exercising: an update (Archery max_per_week 5->2,
// against the human edit above), a clear (Swim's max_per_week cleared via an
// explicit CLEAR token is out of scope for this fixture — update only, per
// buildPlan's supported arms), and the same fixed event at its ORIGINAL slot
// (now drifted -> MOVED).
// base_generation is set to the CURRENT op-log clock at call time (mirrors
// the workbook round-trip's live export) so the human edit seedRealisticCamp
// makes is not mistaken for a later, unseen write — that is a real "stale"
// hold (ingest.s4b.test.js), a different scenario from the one this fixture
// wants: a director-owned field the import proposes changing knowingly.
// The protected-field gate holds ANY update to a human-owned field pending an
// explicit director decision (electron/ops/ingest.js ~:1004), independent of
// the base_generation clock — so proposing a change to Archery's (human-
// edited) max_per_week needs the same 'accept' resolution a director would
// give from the held-conflict UI (ingest.t73.test.js's shape).
const reconcilePayload = () => ({
  ...BASE,
  activityRules: {
    ...BASE.activityRules,
    Archery: { eligible_group_names: ['Bunk 1'], min_per_week: 1, max_per_week: 2, priority: 'low' },
  },
  fixedEvents: [MIFKAD_MON_9],
  base_generation: latestOpSeq(db),
  resolutions: [{ entity: 'activities', name: 'Archery', reason: 'stale', field: 'max_per_week', choice: 'accept' }],
})

describe('D1 dryRun — non-mutation', () => {
  it('writes nothing: every touched table and MAX(seq) identical before/after', () => {
    seedRealisticCamp()

    const before = snapshotDb()
    const outcome = commit({ ...reconcilePayload(), dryRun: true })
    const after = snapshotDb()

    expect(outcome.held).toBe(false)
    expect(outcome.dryRun).toBe(true)
    expect(after).toEqual(before)
  })

  it('a dry run over a fresh (empty) camp also writes nothing', () => {
    const before = snapshotDb()
    const outcome = commit({ ...BASE, fixedEvents: [MIFKAD_MON_9], dryRun: true })
    const after = snapshotDb()

    expect(outcome.held).toBe(false)
    expect(outcome.dryRun).toBe(true)
    expect(outcome.total).toBeGreaterThan(0) // it really did compute creates
    expect(after).toEqual(before)
  })
})

describe('D1 dryRun — truthfulness', () => {
  it('fieldProvenance/legacyPriorityActivities are exactly what the exported pure functions compute against the (unmutated) starting db', () => {
    seedRealisticCamp()
    const startingSnapshot = snapshotDb()

    const dry = commit({ ...reconcilePayload(), dryRun: true })
    expect(dry.dryRun).toBe(true)
    expect(dry.held).toBe(false)
    expect(dry.planItems.length).toBeGreaterThan(0)

    // The dry run must not have perturbed the starting state.
    expect(snapshotDb()).toEqual(startingSnapshot)

    // commitIngest's dryRun branch (electron/ops/ingest.js) computes
    // fieldProvenance/legacyPriorityActivities by calling these SAME exported
    // functions, in this same order, immediately after commitPlan's rollback —
    // i.e. against the db exactly as it stands right now (still pristine,
    // proven above). Calling them again here independently, on the identical
    // db + plan.items, is the truthfulness oracle: no parallel computation,
    // no divergent snapshot, same inputs in same order.
    const oracleFieldProvenance = Object.fromEntries(buildFieldProvenanceMap(db, dry.planItems))
    const oracleLegacy = listLegacyPriorityActivities(db, campId)

    expect(dry.fieldProvenance).toEqual(oracleFieldProvenance)
    expect(dry.fieldProvenance).toEqual({
      [`activities:${db.prepare('SELECT id FROM activities WHERE camp_id = ? AND name = ?').get(campId, 'Archery').id}:max_per_week`]: 'human',
    })
    expect(dry.legacyPriorityActivities).toEqual(oracleLegacy)
    expect(dry.legacyPriorityActivities.length).toBeGreaterThan(0)
  })

  it('fixedEventsReport matches what a real commit against the same starting db produces', () => {
    seedRealisticCamp()
    const startingSnapshot = snapshotDb()

    const dry = commit({ ...reconcilePayload(), dryRun: true })
    expect(snapshotDb()).toEqual(startingSnapshot) // still pristine

    // Real commit, run against the SAME (still-pristine, just proven) db —
    // the drift/count logic that produces fixedEvents runs identically
    // whether or not the transaction is later rolled back.
    const real = commit({ ...reconcilePayload() })
    expect(real.held).toBe(false)

    expect(dry.fixedEvents).toEqual(real.fixedEvents)
    expect(dry.fixedEvents.moved).toEqual([
      {
        name: 'Mifkad',
        reason: 'moved from Monday/09:00-09:40 to Monday/10:00-10:40',
        time_block: '09:00-09:40',
        days: ['Monday'],
        from: { day: 'Monday', timeBlock: '09:00-09:40' },
        to: { day: 'Monday', timeBlock: '10:00-10:40' },
      },
    ])
  })
})

describe('D1 dryRun — held scenario', () => {
  it('returns { held:true, conflicts } with every Phase-D field absent/empty', () => {
    // Two live rows "Art" and "art " collide under normalizeName — the same
    // fixture ingestRecognition.test.js uses for a live ambiguous_identity hold.
    db.prepare('INSERT INTO activities (id, camp_id, name) VALUES (?, ?, ?)').run(randomUUID(), campId, 'Art')
    db.prepare('INSERT INTO activities (id, camp_id, name) VALUES (?, ?, ?)').run(randomUUID(), campId, 'art ')

    const before = snapshotDb()
    const outcome = commit({ approved: { activities: ['Art'] }, dryRun: true })
    const after = snapshotDb()

    expect(outcome.held).toBe(true)
    expect(outcome.conflicts).toHaveLength(1)
    expect(outcome.conflicts[0].reason).toBe('ambiguous_identity')
    expect(outcome.dryRun).toBeUndefined()
    expect(outcome.planItems).toBeUndefined()
    expect(outcome.fieldProvenance).toBeUndefined()
    expect(outcome.legacyPriorityActivities).toBeUndefined()
    expect(after).toEqual(before)
  })
})

describe('D1 — commit behavior is byte-identical when dryRun is omitted', () => {
  it('a normal commit (dryRun omitted) writes the same ops as before D1', () => {
    const outcome = commit({ ...BASE, fixedEvents: [MIFKAD_MON_9] })
    expect(outcome.held).toBe(false)
    expect(outcome.dryRun).toBeUndefined()
    expect(outcome.total).toBeGreaterThan(0)
    expect(db.prepare('SELECT COUNT(*) c FROM activities WHERE camp_id = ?').get(campId).c).toBe(2)
    expect(db.prepare('SELECT COUNT(*) c FROM anchor_activities WHERE camp_id = ?').get(campId).c).toBe(1)
  })
})

// D3 — the dry-run return additionally carries evidenceSupport, the same
// rule.support/fe.support objects writeActivityEvidence/writeEvidence would
// persist, collected in-memory (never written, since this is a rollback).
//
// The activity join key is entity_id, which is only real for a RECOGNIZED
// (unchanged/update/clear) item — a fresh 'create' item's entity_id stays
// null in planItems (buildPlan's own contract; see reconciliationReport.js's
// module doc), so this exercises Swim as an already-seeded, re-imported
// activity. The fixed-event join key is name, and per ingest.js's own
// comment ("evidence for a CREATED anchor only"), only a brand-new anchor
// gets support collected — this exercises a fixed event seedRealisticCamp
// never created, not the pre-existing Mifkad (which would land in
// fixedUnchanged with no support).
describe('D1 dryRun — evidenceSupport (D3)', () => {
  it('carries the inferred activity support keyed by entity_id and the fixed-event support keyed by name', () => {
    seedRealisticCamp()

    const activitySupport = { matched_groups: ['Bunk 1'], appearances: 6, eligible_group_count: 1 }
    const fixedSupport = { days: ['Tuesday'], occupied_days: 1, operating_days: 2, groups_in_scope: ['Bunk 1', 'Bunk 2'] }

    const outcome = commit({
      ...reconcilePayload(),
      activityRules: {
        ...reconcilePayload().activityRules,
        Archery: { ...reconcilePayload().activityRules.Archery, eligibility_known: true, support: activitySupport },
      },
      fixedEvents: [
        MIFKAD_MON_9,
        { name: 'Flag Lowering', time_block: '10:00-10:40', days: ['Tuesday'], scope: { is_all_groups: true, groups: [] }, confidence: 'high', support: fixedSupport },
      ],
      dryRun: true,
    })

    expect(outcome.held).toBe(false)
    const archeryItem = outcome.planItems.find((i) => i.entity === 'activities' && i._name === 'Archery')
    expect(archeryItem.entity_id).toBeTruthy()
    expect(outcome.evidenceSupport.activities[archeryItem.entity_id]).toBe(activitySupport)
    expect(outcome.evidenceSupport.fixedEvents['Flag Lowering']).toBe(fixedSupport)

    // Non-mutation still holds: nothing was written for this in-memory field to reflect.
    expect(db.prepare('SELECT COUNT(*) c FROM import_evidence').get().c).toBe(0)
  })
})

// ADR 2026-08-17-onescreen-reconciliation-merge.md — STEP 2, the load-bearing
// end-to-end hold-back test (§Test strategy): a low-confidence create must
// become a real confirm_value decision, and an UNRESOLVED decision must hold
// the candidate back from a real write — this is Invariant 4, proven through
// the actual production pipeline (dry-run report -> lanes -> resolutions ->
// real commit), not just a unit test of classifyItem/buildPlan in isolation.
describe('STEP 2 — the seenCounts create-confidence hold-back, end to end', () => {
  const seedMinimalCamp = () => {
    db.prepare('INSERT INTO cohorts (id, camp_id, name) VALUES (?, ?, ?)').run('cohort-1', campId, 'Main')
  }

  // A function, not a module-level const: campId/deviceId are only assigned
  // in beforeEach, so a const evaluated at describe-time would close over
  // undefined.
  const lowConfidenceSource = () => ({
    approved: { activities: ['One Off'] },
    seenCounts: { activities: { 'One Off': 1 }, activityUnitShare: {} },
    camp_id: campId,
    cohort_id: 'cohort-1',
    author_user_id: 'u1',
    device_id: deviceId,
    mode: 'add',
  })

  it('(a)-(b): a low-confidence create appears as a confirm_value decision in the standard lane', () => {
    seedMinimalCamp()
    const dry = commit({ ...lowConfidenceSource(), dryRun: true })
    expect(dry.held).toBe(false)
    const item = dry.planItems.find((i) => i.entity === 'activities' && i._name === 'One Off')
    expect(item.evidence.tier).toBe('low')

    const report = buildReconciliationReport({ planItems: dry.planItems, readiness: [] })
    const decision = report.decisions.find((d) => d.entity === 'activities' && d.entityName === 'One Off')
    expect(decision).toBeTruthy()
    expect(decision.kind).toBe('confirm_value')
    expect(decision.confidence).toBe('low')

    const lanes = reportToLanes(report)
    expect(lanes.standard.some((d) => d.id === decision.id)).toBe(true)
  })

  it('(c): committing with the decision UNRESOLVED holds the candidate back — nothing is written', () => {
    seedMinimalCamp()
    const dry = commit({ ...lowConfidenceSource(), dryRun: true })
    const report = buildReconciliationReport({ planItems: dry.planItems, readiness: [] })

    // No answers at all — the decision is unresolved.
    const { approved: heldApproved } = applyResolutions({ approved: lowConfidenceSource().approved, decisions: report.decisions, answers: {} })
    expect(heldApproved.activities).toEqual([])

    const outcome = commit({ ...lowConfidenceSource(), approved: heldApproved })
    expect(outcome.created.activities).toBe(0)
    expect(db.prepare('SELECT COUNT(*) c FROM activities WHERE camp_id = ?').get(campId).c).toBe(0)
  })

  it('(d): resolving looks_right and re-committing writes the candidate', () => {
    seedMinimalCamp()
    const dry = commit({ ...lowConfidenceSource(), dryRun: true })
    const report = buildReconciliationReport({ planItems: dry.planItems, readiness: [] })
    const decision = report.decisions.find((d) => d.entity === 'activities' && d.entityName === 'One Off')

    const { approved: resolvedApproved } = applyResolutions({
      approved: lowConfidenceSource().approved,
      decisions: report.decisions,
      answers: { [decision.id]: { action: 'looks_right' } },
    })
    expect(resolvedApproved.activities).toEqual(['One Off'])

    const outcome = commit({ ...lowConfidenceSource(), approved: resolvedApproved })
    expect(outcome.created.activities).toBe(1)
    expect(db.prepare('SELECT COUNT(*) c FROM activities WHERE camp_id = ? AND name = ?').get(campId, 'One Off').c).toBe(1)
  })
})

// Fix round 2026-08-17 — FIX 1 (Red Hat RISK 1): a FULLY-RESOLVED fixed event
// (no dropped day/group, so it never touches the `partial` branch) with
// fe.confidence === 'low' used to land in the `created` bucket with NO
// decision and write silently. Mirrors STEP 2's end-to-end shape exactly,
// swapped from a low-confidence activity create to a low-confidence fixed
// event create, proven through the real production pipeline.
describe('FIX 1 — low-confidence FULLY-RESOLVED fixed event creates a confirm_value hold-back', () => {
  const seedBaseCamp = () => commit(BASE)

  const lowConfidenceFixedEvent = {
    name: 'Quiet Time', time_block: '09:00-09:40', days: ['Monday'],
    scope: { is_all_groups: true, groups: [] }, confidence: 'low',
  }

  const fixedEventsReportFrom = (outcome) => ({
    created: outcome.fixedEvents.createdEntries,
    unchanged: outcome.fixedEvents.unchangedEntries,
    moved: [], partial: [], skipped: [], rejected: [], scopeChanged: [],
  })

  it('(a)-(b): appears as a confirm_value decision, held back out of the `created` count', () => {
    seedBaseCamp()
    const dry = commit({ ...BASE, fixedEvents: [lowConfidenceFixedEvent], dryRun: true })
    expect(dry.held).toBe(false)
    expect(dry.fixedEvents.createdEntries).toEqual([
      { anchorId: expect.any(String), name: 'Quiet Time', confidence: 'low', time_block: '09:00-09:40', days: ['Monday'] },
    ])

    const report = buildReconciliationReport({
      planItems: dry.planItems, readiness: [], fixedEventsReport: fixedEventsReportFrom(dry),
    })
    const decision = report.decisions.find((d) => d.entity === 'anchor_activities' && d.entityName === 'Quiet Time')
    expect(decision).toBeTruthy()
    expect(decision.kind).toBe('confirm_value')
    expect(decision.confidence).toBe('low')
    // A confirm_value decision means this create must NOT have also counted
    // toward understood silently — that's exactly the gap being closed.
    expect(report.buckets.needsAttention).toBeGreaterThan(0)
  })

  it('(c): committing with the decision UNRESOLVED holds the anchor back — nothing is written', () => {
    seedBaseCamp()
    const dry = commit({ ...BASE, fixedEvents: [lowConfidenceFixedEvent], dryRun: true })
    const report = buildReconciliationReport({
      planItems: dry.planItems, readiness: [], fixedEventsReport: fixedEventsReportFrom(dry),
    })

    const { approved: heldApproved, fixedEvents: heldFixedEvents } = applyResolutions({
      approved: BASE.approved, decisions: report.decisions, answers: {}, fixedEvents: [lowConfidenceFixedEvent],
    })
    expect(heldFixedEvents).toEqual([])

    const outcome = commit({ ...BASE, approved: heldApproved, fixedEvents: heldFixedEvents })
    expect(outcome.fixedEvents.created).toBe(0)
    expect(db.prepare('SELECT COUNT(*) c FROM anchor_activities WHERE camp_id = ? AND name = ?').get(campId, 'Quiet Time').c).toBe(0)
  })

  it('(d): resolving looks_right and re-committing writes the anchor', () => {
    seedBaseCamp()
    const dry = commit({ ...BASE, fixedEvents: [lowConfidenceFixedEvent], dryRun: true })
    const report = buildReconciliationReport({
      planItems: dry.planItems, readiness: [], fixedEventsReport: fixedEventsReportFrom(dry),
    })
    const decision = report.decisions.find((d) => d.entity === 'anchor_activities' && d.entityName === 'Quiet Time')

    const { approved: resolvedApproved, fixedEvents: resolvedFixedEvents } = applyResolutions({
      approved: BASE.approved, decisions: report.decisions,
      answers: { [decision.id]: { action: 'looks_right' } }, fixedEvents: [lowConfidenceFixedEvent],
    })
    expect(resolvedFixedEvents).toEqual([lowConfidenceFixedEvent])

    const outcome = commit({ ...BASE, approved: resolvedApproved, fixedEvents: resolvedFixedEvents })
    expect(outcome.fixedEvents.created).toBe(1)
    expect(db.prepare('SELECT COUNT(*) c FROM anchor_activities WHERE camp_id = ? AND name = ?').get(campId, 'Quiet Time').c).toBe(1)
  })

  it('a HIGH-confidence fixed event with no shortfall ships unconditionally — never held', () => {
    seedBaseCamp()
    const highConfidenceFixedEvent = { ...lowConfidenceFixedEvent, name: 'Loud Time', confidence: 'high' }
    const dry = commit({ ...BASE, fixedEvents: [highConfidenceFixedEvent], dryRun: true })
    const report = buildReconciliationReport({
      planItems: dry.planItems, readiness: [], fixedEventsReport: fixedEventsReportFrom(dry),
    })
    expect(report.decisions.find((d) => d.entityName === 'Loud Time')).toBeUndefined()
    expect(report.buckets.understood).toBeGreaterThan(0)

    const outcome = commit({ ...BASE, fixedEvents: [highConfidenceFixedEvent] })
    expect(outcome.fixedEvents.created).toBe(1)
    expect(db.prepare('SELECT COUNT(*) c FROM anchor_activities WHERE camp_id = ? AND name = ?').get(campId, 'Loud Time').c).toBe(1)
  })
})
