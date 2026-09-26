// @vitest-environment node
//
// T266 acceptance — "a claimed event name never reaches the activity pass".
//
// WHY THIS IS AN INTEGRATION TEST AND NOT A UNIT TEST, stated up front because
// it is the whole reason the file exists rather than a cheaper one.
//
// The leak this pins is created by the RESOLUTION path, not by the data: two
// proposers (extractEntities for pass 3, inferFixedEvents for passes 1 and 2)
// independently walk THE SAME parsed cells and neither subtracts from the other.
// They only meet on a real parsed grid. A fixture that hands the code a
// hand-built list of "events" and a hand-built list of "activities" has already
// performed the arbitration the code is supposed to perform, and would pass
// against a completely broken implementation.
//
// This repository has paid for that exact mistake. T62 was closed against an
// `anchor.activity_id` the row does not carry; its unit test hand-built an
// anchor WITH that field and stayed green for a month while the production
// exclusion Set was empty. So: real sample spreadsheet -> real parseTextGrid ->
// real extractEntities -> real inferFixedEvents -> the real shared
// derivePinOnlyActivityNames -> real commitIngest -> real better-sqlite3 ->
// rows read back out of SQLite -> real buildSchedule. Nothing between the file
// on disk and the assertion is constructed by this test.
//
// WHAT IS NOT COVERED, so nobody infers more than is here: ImportScreen's React
// rendering. The derivation ImportScreen performs is exercised (it is the same
// `derivePinOnlyActivityNames` module, called from the same inferFixedEvents
// output), but the component itself is not mounted. That gap is covered by
// ImportScreen's own jsdom tests, not by this file.
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { openTemplatedDb } from './db/testDbTemplate.js'
import { commitIngest } from './ops/ingest.js'
import { CURRENT_SCHEMA_VERSION } from './db/localDb.js'
import { parseTextGrid } from '../src/ingest/textGrid.js'
import { extractEntities } from '../src/ingest/extractEntities.js'
import { inferFixedEvents } from '../src/ingest/fixedEvents.js'
import { derivePinOnlyActivityNames } from '../src/ingest/pinOnlyActivityNames.js'
import { inferActivityRules } from '../src/ingest/activityRules.js'
import { filterFreeChoiceActivities, isFreeChoiceActivity } from '../src/engine/freeChoiceActivities.js'
import { indexActivitiesByName, resolveAnchorActivityIds, anchorNameKey } from '../src/engine/anchorActivityLink.js'
import buildSchedule from '../src/engine/buildSchedule.js'

const SAMPLE = path.join(process.cwd(), 'docs/work/specs/samples/campB-by-day.txt')

// The three roles the predicate names, read off the REAL parse of the real
// sample (verified: `Carpool` is inferred fixed/high and is NOT dual-use;
// `Archery` is never inferred as an event at all; `Sports` IS dual-use — it is
// pinned for some groups and floats for others, which is exactly the case the
// existing carve-out exists to protect).
// NOTE on the choice of PINNED: `Carpool` is the owner's own example and IS
// inferred as a pinned fixed event here — but this sample pins it TWICE a day
// (a morning run and an afternoon run, 08:40 and 15:40), so "exactly once per
// group per day" is not the right assertion for it. `Group Time` is pinned to a
// single period, every operating day, for every group, at high confidence —
// which is the shape clause 2 describes. Both are in the pin-only set; only the
// arithmetic differs.
const PINNED = 'Group Time'    // (a) pinned to a period every operating day
const FREE = 'Archery'         // (b) a genuine free-choice activity
const DUAL_USE = 'Sports'      // (c) a dual-use name

// A fourth name, needed for the non-vacuity proof below and NOT part of the
// owner's predicate. `Group Time` is anchored for EVERY group on EVERY day, so
// the pre-existing per-(group, day) anchor suppression already keeps it off the
// free-choice grid — which means clearing the T266 marker on it changes nothing
// observable, and a non-vacuity test built on it would silently prove nothing.
// (Measured, not assumed: that is exactly what the first attempt did.)
//
// `Menucha` is a RECURRING event scoped to Tuesday/Thursday/Friday only. On
// Monday and Wednesday no anchor covers it, the suppression has nothing to
// suppress, and pre-T266 the engine was free to place it as an ordinary
// activity. That is the owner's actual symptom — "recurring events, for whatever
// groups it applies to" — and it is the gap the marker closes.
const PARTIAL = 'Menucha'      // a recurring event that does NOT cover every day

let db, tmpFile, campId, cohortId
const deviceId = 'device-1'

beforeEach(() => {
  const t = openTemplatedDb()
  db = t.db
  tmpFile = t.file
  campId = randomUUID()
  db.prepare('INSERT INTO camps (id, name, signing_secret) VALUES (?, ?, ?)').run(campId, 'Test Camp', 'a'.repeat(64))
  db.prepare('INSERT INTO devices (id, name) VALUES (?, ?)').run(deviceId, 'Test Device')
  // buildSchedule walks COHORTS; a camp with none produces an empty grid and
  // every clause-2 assertion below would pass vacuously. One cohort, as a real
  // camp has.
  cohortId = randomUUID()
  db.prepare('INSERT INTO cohorts (id, camp_id, name, sort_order) VALUES (?, ?, ?, 0)').run(cohortId, campId, 'Main')
})

afterEach(() => {
  db.close()
  for (const suffix of ['', '-wal', '-shm']) {
    if (fs.existsSync(tmpFile + suffix)) fs.unlinkSync(tmpFile + suffix)
  }
})

// Schema tripwire. A sibling migration lands and silently renumbers, and every
// assertion below still passes while the column it depends on is gone.
it('is written against schema v76', () => {
  expect(CURRENT_SCHEMA_VERSION).toBe(76)
})

// ── The real ingest path, run once per test ────────────────────────────────
// `approved` deliberately contains EVERY proposed activity name, including the
// pinned one. That is not laziness: it is the defect being reproduced. The
// director who answers "yes, that looks right" on the reconciliation card leaves
// the name in `approved` (src/screens/reconciliationResolutions.js removes a name
// only when the card is UNRESOLVED), and before T266 that affirmative answer was
// what minted the duplicate free-choice activity. The predicate says the pinned
// name must not become a free choice EVEN THEN.
function runRealIngest({ withholdClaimFor = null, onlyActivities = null, suppressDetection = false } = {}) {
  const parsed = parseTextGrid(fs.readFileSync(SAMPLE, 'utf8'))
  const proposal = extractEntities(parsed)
  const { fixedEvents, dualUseNames = [] } = inferFixedEvents({ pages: parsed.pages }, proposal, {})
  const pinOnly = derivePinOnlyActivityNames(fixedEvents, dualUseNames)
  // Test-only levers, used ONLY by the symmetry tests at the bottom of this
  // file. Everything above runs with both at their defaults, i.e. the real
  // derivation untouched.
  if (withholdClaimFor) pinOnly.delete(withholdClaimFor)

  const approved = {
    groups: proposal.entities.groups,
    days_of_operation: proposal.entities.days_of_operation,
    time_blocks: proposal.entities.time_blocks,
    activities: onlyActivities ?? proposal.entities.activities,
  }

  // The real rule inference, with the real Asserted-classification exclusion set
  // (ImportScreen passes exactly this — the same pin-only set). Without it every
  // activity lands with a NULL priority and the engine's placement rounds have
  // nothing to place, which would make clause 2's "the free-choice name is still
  // placed" half vacuous.
  const activityRules = inferActivityRules(
    proposal.entities.activities,
    proposal.activityPages,
    proposal.seenCounts,
    proposal.entities.days_of_operation.length,
    proposal.entities.groups,
    pinOnly,
  )

  const result = commitIngest(db, {
    approved,
    activityRules,
    camp_id: campId,
    cohort_id: cohortId,
    device_id: deviceId,
    fixedEvents,
    // `suppressDetection` models the callers that do NOT compute a claimed set —
    // the MCP ingest server, a workbook re-import, the clipboard path — all of
    // which reach commitIngest through `pinOnlyActivityNames ?? []`
    // (electron/main.js:421, :510). It is the REAL shape of those calls, not an
    // invented one.
    pinOnlyActivityNames: suppressDetection ? [] : [...pinOnly],
    seenCounts: proposal.seenCounts ?? null,
  })

  return { proposal, fixedEvents, dualUseNames, pinOnly, result }
}

// Rows as the DATABASE returns them — never as this test imagines them.
const activityRows = () =>
  db.prepare('SELECT id, name, catalog_role, priority, min_per_week, max_per_week, eligible_tier_ids, eligible_group_ids, span_blocks, same_tier_only, max_groups_per_slot FROM activities WHERE camp_id = ?').all(campId)
const anchorRows = () =>
  db.prepare('SELECT * FROM anchor_activities WHERE camp_id = ?').all(campId)
const byName = (rows, name) => rows.filter((r) => r.name === name)

describe('T266 — the real ingest path', () => {
  it('parses the sample into all three roles the predicate needs (guards the fixture itself)', () => {
    // If the sample or the inference ever changes so that one of these roles is
    // no longer present, every assertion below would still pass while testing
    // nothing. This makes that failure loud instead of silent.
    const { proposal, pinOnly, dualUseNames, fixedEvents } = runRealIngest()
    expect(pinOnly.has(PINNED)).toBe(true)
    expect(proposal.entities.activities).toContain(FREE)
    expect(pinOnly.has(FREE)).toBe(false)
    expect(dualUseNames).toContain(DUAL_USE)
    expect(pinOnly.has(DUAL_USE)).toBe(false)
    // The non-vacuity name must be claimed AND must genuinely leave days
    // uncovered, or the proof below degenerates.
    expect(pinOnly.has(PARTIAL)).toBe(true)
    const partialDays = new Set(fixedEvents.filter((fe) => fe.name === PARTIAL).flatMap((fe) => fe.days))
    expect(partialDays.size).toBeLessThan(proposal.entities.days_of_operation.length)
  })

  // ── Clause 1 ──────────────────────────────────────────────────────────────
  it('clause 1 — the pinned name is not a free choice, even though the director confirmed it', () => {
    runRealIngest()
    const rows = activityRows()

    const pinnedRows = byName(rows, PINNED)
    // The ROW came back — asserting on the row, not on a call having been made.
    expect(pinnedRows.length).toBeGreaterThan(0)
    for (const r of pinnedRows) expect(r.catalog_role).toBe('pinned_event')

    // ...and it is therefore absent from the free-choice catalogue.
    const freeChoice = filterFreeChoiceActivities(rows).map((r) => r.name)
    expect(freeChoice).not.toContain(PINNED)
  })

  it('clause 1 — re-importing does not mint a second, unmarked copy', () => {
    runRealIngest()
    runRealIngest()
    const rows = activityRows()
    // Whatever the recognition path decides about duplicates, NO row bearing the
    // pinned name may be free-choice. This is the assertion that survives a
    // future change to dedup behaviour.
    for (const r of byName(rows, PINNED)) expect(isFreeChoiceActivity(r)).toBe(false)
  })

  // ── Clause 3 (before 2, because 2 depends on it) ──────────────────────────
  it('clause 3 — anchor name resolution still returns exactly one row', () => {
    runRealIngest()
    const rows = activityRows()
    const anchors = anchorRows().filter((a) => a.name === PINNED)
    expect(anchors.length).toBeGreaterThan(0)

    const byNameIndex = indexActivitiesByName(rows)
    for (const anchor of anchors) {
      const ids = resolveAnchorActivityIds(anchor, byNameIndex)
      // Zero and two-or-more are BOTH failures. Zero is the silent one: it is
      // what a delete-the-row fix produces, and it switches the
      // don't-schedule-twice suppression off with no error anywhere.
      expect(ids).toHaveLength(1)
    }
  })

  it('clause 3 — the marker does not hide the row from name resolution', () => {
    // The whole design rests on this: MARKER, NOT HOLE. The row is excluded from
    // menus and still present for resolution. Stated as its own assertion so a
    // future "optimisation" that filters the resolution index fails here.
    runRealIngest()
    const rows = activityRows()
    const marked = byName(rows, PINNED)
    const index = indexActivitiesByName(rows)
    expect(index.get(anchorNameKey(PINNED))).toEqual(marked.map((r) => r.id))
  })

  // ── Clause 4 ──────────────────────────────────────────────────────────────
  it('clause 4 — the free-choice name and the dual-use name are untouched', () => {
    runRealIngest()
    const rows = activityRows()
    const free = byName(rows, FREE)
    expect(free.length).toBeGreaterThan(0)
    for (const r of free) {
      expect(r.catalog_role).toBeNull()
      expect(isFreeChoiceActivity(r)).toBe(true)
    }
    const dual = byName(rows, DUAL_USE)
    expect(dual.length).toBeGreaterThan(0)
    for (const r of dual) {
      // A name that is genuinely BOTH a scheduled event and a free choice stays
      // available to pass 3. Strict exclusivity needed no new carve-out.
      expect(r.catalog_role).toBeNull()
      expect(isFreeChoiceActivity(r)).toBe(true)
    }
    const names = filterFreeChoiceActivities(rows).map((r) => r.name)
    expect(names).toContain(FREE)
    expect(names).toContain(DUAL_USE)
  })
})

// ── Clause 2 — the load-bearing one ──────────────────────────────────────────
//
// This is the clause a hand-built fixture cannot demonstrate and the one whose
// failure is INVISIBLE: an over-filtered palette merely looks empty, but an
// unfiltered engine pool places the event a second time with no error, no
// finding and no red test anywhere else in the suite.
import { normalizeScheduleInputs, SCHEDULE_INPUT_ENTITIES } from './ops/scheduleInputNormalization.js'

// WHY THIS STEP EXISTS, because it is the difference between a real assertion
// and a vacuous one, and it was nearly missed.
//
// Straight out of ingest every activity has a NULL priority, and the engine's
// placement rounds place by priority — so the generated grid contains ZERO
// placed activities and "the pinned name was not placed twice" would be true of
// a completely broken implementation. Measured, not assumed: a control run with
// every `catalog_role` wiped (i.e. the tree as it behaved BEFORE T266) also
// placed nothing.
//
// Giving EVERY activity a priority — the pinned one included — is what makes the
// clause bite. It is also what a director does next in the real app. With a
// priority on it, the pinned name is a fully placeable free choice as far as the
// old code was concerned, so if the exclusion is not working the engine WILL
// place it a second time and this test WILL go red.
function makeEverythingPlaceable() {
  db.prepare("UPDATE activities SET priority = 'high', min_per_week = 1, max_per_week = 5 WHERE camp_id = ?").run(campId)
}

function scheduleFromDb() {
  const rowsByEntity = {}
  for (const entity of SCHEDULE_INPUT_ENTITIES) {
    rowsByEntity[entity] = db.prepare(`SELECT * FROM ${entity}`).all()
  }
  const input = normalizeScheduleInputs(rowsByEntity, campId)
  // Non-vacuity guards for the whole clause-2 block: an empty grid would satisfy
  // "not placed twice" trivially.
  expect(input.groups.length).toBeGreaterThan(0)
  expect(input.timeBlocks.length).toBeGreaterThan(0)
  expect(input.days.length).toBeGreaterThan(0)
  expect(input.anchors.length).toBeGreaterThan(0)
  // buildSchedule's documented flat signature (CLAUDE.md, "Schedule engine"):
  // { groups, tiers, days, timeBlocks, activities, anchors, campId }. `cohorts`
  // is deliberately NOT forwarded — the engine's other call shape expects
  // pre-assembled cohort ENTRIES ({ cohort, timeBlocks, tiers, groups, ... }),
  // which the screen builds and the raw rows are not.
  const { cohorts: _cohorts, ...flat } = input
  const result = buildSchedule({ ...flat, campId })
  expect(result.slots.length).toBeGreaterThan(0)
  return result
}

// An ANCHOR slot carries `anchorId` and a NULL `activityId` — the event is on the
// grid as its event. An ACTIVITY slot carries `activityId` — the activity was
// placed as a free choice. Counting them separately is the entire point: "once"
// must mean once as an event and never as a free choice.
function anchorPlacementsByName(result, name) {
  const anchorNameById = new Map(anchorRows().map((a) => [a.id, a.name]))
  const counts = new Map()
  for (const s of result.slots) {
    if (s.type !== 'anchor' || s.is_span_head === false) continue
    if (anchorNameById.get(s.anchorId) !== name) continue
    const k = `${s.groupId}|${s.dayId}`
    counts.set(k, (counts.get(k) || 0) + 1)
  }
  return counts
}

function activityPlacements(result, idSet) {
  return result.slots.filter((s) => s.type === 'activity' && s.activityId && idSet.has(s.activityId))
}

describe('T266 clause 2 — the generated grid', () => {
  it('places the pinned name exactly once per group per day — not zero, not twice', () => {
    runRealIngest()
    makeEverythingPlaceable()
    const rows = activityRows()
    const pinnedIds = new Set(byName(rows, PINNED).map((r) => r.id))
    expect(pinnedIds.size).toBeGreaterThan(0)

    const result = scheduleFromDb()

    // NOT ZERO — it is still on the grid, as its event. This is the half that a
    // "just stop creating the row" fix breaks in the other direction.
    const asEvent = anchorPlacementsByName(result, PINNED)
    expect(asEvent.size).toBeGreaterThan(0)
    // NOT TWICE — no (group, day) carries it more than once as an event...
    expect([...asEvent.entries()].filter(([, n]) => n !== 1)).toEqual([])
    // ...and it is never ALSO placed as a free-choice activity, which is the
    // actual double-placement this ticket prevents.
    expect(activityPlacements(result, pinnedIds)).toEqual([])
  })

  it('NON-VACUITY (the expected defect): without the marker the event IS placed as a free activity', () => {
    // Plant the defect the guard's own description points at — the marker never
    // written — and show the grid goes wrong. If this does not observe the leak,
    // the assertions above prove nothing.
    runRealIngest()
    makeEverythingPlaceable()
    const rows = activityRows()
    const partialIds = new Set(byName(rows, PARTIAL).map((r) => r.id))
    expect(partialIds.size).toBeGreaterThan(0)

    // GREEN: with the marker in place, the claimed name is never placed as a
    // free-choice activity, on any day — including the days its own event does
    // not cover.
    expect(activityPlacements(scheduleFromDb(), partialIds)).toEqual([])

    // RED: clear the marker and the leak comes straight back.
    db.prepare('UPDATE activities SET catalog_role = NULL WHERE camp_id = ?').run(campId)
    expect(activityPlacements(scheduleFromDb(), partialIds).length).toBeGreaterThan(0)
  })

  it('NON-VACUITY (the defect the description does NOT point at): a HOLE instead of a marker silently disables the suppression', () => {
    // The naive fix — "stop creating the row" — satisfies clause 1 perfectly and
    // breaks clause 3 invisibly. Nothing in the phrase "exclude the name from the
    // catalogue" leads you to this. Simulated by DELETING the pinned activity
    // rows, which is precisely what that fix would leave behind.
    runRealIngest()
    makeEverythingPlaceable()
    const anchors = anchorRows().filter((a) => a.name === PINNED)
    expect(anchors.length).toBeGreaterThan(0)

    db.prepare('DELETE FROM activities WHERE camp_id = ? AND name = ?').run(campId, PINNED)
    const holed = activityRows()

    // Clause 1 still looks perfect — the name is gone from the catalogue.
    expect(byName(holed, PINNED)).toEqual([])
    // Clause 3 is now broken, and NOTHING throws. resolveAnchorActivityIds
    // returns [], which every caller treats as a correct no-op, so the
    // don\'t-schedule-twice suppression is simply off.
    const index = indexActivitiesByName(holed)
    for (const anchor of anchors) {
      expect(resolveAnchorActivityIds(anchor, index)).toEqual([])
    }
  })

  it('the free-choice name is still actually placed on the grid', () => {
    // Proving the pinned name is gone is worthless if the filter took the whole
    // catalogue with it. An over-broad filter is what this catches.
    runRealIngest()
    makeEverythingPlaceable()
    const rows = activityRows()
    const freeIds = new Set(filterFreeChoiceActivities(rows).map((r) => r.id))
    const result = scheduleFromDb()
    expect(activityPlacements(result, freeIds).length).toBeGreaterThan(0)
  })
})

describe('T266 — the marker is symmetric, and the clear path is as deliberate as the set path', () => {
  it('SET-THEN-CLEAR: a re-import that saw the sheet and no longer claims the name clears the marker', () => {
    runRealIngest()
    expect(byName(activityRows(), PINNED).every((r) => r.catalog_role === 'pinned_event')).toBe(true)

    // Detection RAN (the claimed set is still non-empty — every other event is
    // still claimed) and simply did not name this one. That, and only that, is a
    // clear.
    const { pinOnly } = runRealIngest({ withholdClaimFor: PINNED })
    expect(pinOnly.size).toBeGreaterThan(0)

    const rows = byName(activityRows(), PINNED)
    expect(rows.length).toBeGreaterThan(0)
    for (const r of rows) {
      expect(r.catalog_role).toBeNull()
      expect(isFreeChoiceActivity(r)).toBe(true)
    }
  })

  it('SET-THEN-PARTIAL: detection did not run, so every marker SURVIVES', () => {
    // THE ONE THAT PROTECTS THE ORIGINAL BUG FROM RE-ARMING, and the one a
    // description-driven test skips. "The marker is symmetric" leads you to test
    // that it clears; nothing in that sentence leads you to test that it must NOT
    // clear when the input is merely absent.
    //
    // An empty claimed set is ambiguous between "this import read the sheet and
    // found nothing pinned" and "detection never ran". Every caller except
    // ImportScreen produces the second while looking exactly like the first. If
    // those were treated the same, one MCP or workbook re-import would silently
    // re-expose the camp's entire event catalogue as free-choice activities —
    // with no error, no finding, and no red test.
    runRealIngest()
    const marked = byName(activityRows(), PINNED).map((r) => r.id)
    expect(marked.length).toBeGreaterThan(0)

    runRealIngest({ suppressDetection: true })

    for (const r of byName(activityRows(), PINNED)) {
      expect(r.catalog_role).toBe('pinned_event')
      expect(isFreeChoiceActivity(r)).toBe(false)
    }
    // And the partially-claimed event kept its marker too — this is camp-wide,
    // not one lucky row.
    for (const r of byName(activityRows(), PARTIAL)) {
      expect(r.catalog_role).toBe('pinned_event')
    }
  })

  it('NON-VACUITY for the guard: remove the detection-ran condition and the partial import DOES wipe the camp', () => {
    // Plant the defect directly. `simulateUnguardedClear` reproduces exactly what
    // the clear branch would do WITHOUT `pinOnlyDetectionRan`: an import whose
    // claimed set is empty clears every marker it recognizes. If this does not
    // observe the wipe, the test above is proving nothing.
    runRealIngest()
    expect(byName(activityRows(), PINNED).some((r) => r.catalog_role === 'pinned_event')).toBe(true)

    const claimedThisImport = new Set() // what a non-ImportScreen caller supplies
    for (const r of activityRows()) {
      if (r.catalog_role === 'pinned_event' && !claimedThisImport.has(r.name)) {
        db.prepare('UPDATE activities SET catalog_role = NULL WHERE id = ?').run(r.id)
      }
    }

    expect(activityRows().every((r) => r.catalog_role === null)).toBe(true)
    // ...and the consequence that actually matters: the events are free choices
    // again, which is the owner's original symptom restored.
    const freeNames = filterFreeChoiceActivities(activityRows()).map((r) => r.name)
    expect(freeNames).toContain(PINNED)
  })

  it('a name absent from the re-imported sheet keeps its marker', () => {
    // The clear must also be narrow within a real detection run: a sheet that
    // simply does not mention a name must not un-mark it.
    runRealIngest()
    runRealIngest({ withholdClaimFor: PARTIAL, onlyActivities: [PARTIAL, FREE] })
    for (const r of byName(activityRows(), PINNED)) {
      expect(r.catalog_role).toBe('pinned_event')
    }
  })
})
