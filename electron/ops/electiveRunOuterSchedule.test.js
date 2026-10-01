// @vitest-environment node
//
// Unit coverage for deriveElectiveRunOuterRows's v76 additions (T197, docs/adr/2026-09-26-
// elective-run-outer-inheritance-and-linked-choice-export.md): group-template inheritance,
// span-collapsing for inherited cells, the preferences-union-assignments camper universe, and
// choice_id/is_linked_choice passthrough on the elective side. Uses a real db (openLocalDb),
// per TESTING_STANDARD's mandatory-integration-harness rule for electron/ops/**.
import { describe, it, expect, afterEach } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { openLocalDb } from '../db/localDb.js'
import { deriveElectiveRunOuterRows } from './electiveRunOuterSchedule.js'

const files = []
afterEach(() => {
  for (const f of files.splice(0)) {
    for (const suffix of ['', '-wal', '-shm']) {
      if (fs.existsSync(f + suffix)) fs.unlinkSync(f + suffix)
    }
  }
})

function freshDb() {
  const file = path.join(os.tmpdir(), `shoresh-outer-rows-${Date.now()}-${Math.random()}.sqlite`)
  files.push(file)
  return openLocalDb(file)
}

function baseFixture(db) {
  const campId = randomUUID()
  const tierId = randomUUID()
  const groupId = randomUUID()
  const locationId = randomUUID()
  const templateId = 'tpl-1'
  const dayId = 'day-1'

  db.prepare("INSERT INTO camps (id, name, signing_secret) VALUES (?, ?, ?)").run(campId, 'Camp', 'a'.repeat(64))
  db.prepare('INSERT INTO tiers (id, camp_id, name) VALUES (?, ?, ?)').run(tierId, campId, 'Bogrim')
  db.prepare('INSERT INTO groups (id, camp_id, name, tier_id) VALUES (?, ?, ?, ?)').run(groupId, campId, 'Bunk Alpha', tierId)
  db.prepare('INSERT INTO locations (id, camp_id, name) VALUES (?, ?, ?)').run(locationId, campId, 'Field')

  // Three consecutive time blocks so span-collapsing has room to merge.
  const tb = ['tb-0', 'tb-1', 'tb-2'].map((id, i) => {
    db.prepare('INSERT INTO time_blocks (id, camp_id, name, sort_order) VALUES (?, ?, ?, ?)').run(id, campId, `Block ${i}`, i)
    return id
  })

  const run = { id: randomUUID(), camp_id: campId, schedule_template_id: templateId, solver_generation: null }
  db.prepare(
    'INSERT INTO elective_assignment_runs (id, camp_id, schedule_template_id, name) VALUES (?, ?, ?, ?)'
  ).run(run.id, campId, templateId, 'Run')

  return { campId, tierId, groupId, locationId, templateId, dayId, tb, run }
}

function addPreference(db, runId, camperId) {
  const choiceId = randomUUID()
  db.prepare('INSERT INTO elective_choices (id, run_id, label) VALUES (?, ?, ?)').run(choiceId, runId, 'Placeholder')
  db.prepare('INSERT INTO elective_preferences (id, run_id, camper_id, choice_id, rank) VALUES (?, ?, ?, ?, ?)')
    .run(randomUUID(), runId, camperId, choiceId, 1)
}

describe('deriveElectiveRunOuterRows — v76 inheritance and camper universe', () => {
  it('emits an inherited row for a camper whose group template has a plain activity slot', () => {
    const db = freshDb()
    const fx = baseFixture(db)
    const camperId = randomUUID()
    db.prepare('INSERT INTO campers (id, camp_id, display_name, group_id, is_active) VALUES (?, ?, ?, ?, 1)')
      .run(camperId, fx.campId, 'Camper A', fx.groupId)
    addPreference(db, fx.run.id, camperId)
    const activityId = randomUUID()
    db.prepare('INSERT INTO activities (id, camp_id, name, location_id, span_blocks) VALUES (?, ?, ?, ?, 1)')
      .run(activityId, fx.campId, 'Swim', fx.locationId)
    db.prepare(
      'INSERT INTO template_slots (id, template_id, group_id, activity_id, day_id, time_block_id) VALUES (?, ?, ?, ?, ?, ?)'
    ).run(randomUUID(), fx.templateId, fx.groupId, activityId, fx.dayId, fx.tb[0])

    const { rows } = deriveElectiveRunOuterRows(db, fx.run)

    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({
      camper_id: camperId, day_id: fx.dayId, time_block_id: fx.tb[0],
      cell_kind: 'inherited', activity_id: activityId, activity_name: 'Swim',
      span_blocks: 1, solver_generation: null, choice_id: null, is_linked_choice: false,
    })

    db.close()
  })

  // T267 PR2 — the anchor branch of resolveTemplateSlot must return the
  // fixed_events row's real activity_id, not the hardcoded null T197 (PR1)
  // left as a deferred placeholder.
  it('emits activity_id for an inherited row whose template slot is a fixed event (anchor)', () => {
    const db = freshDb()
    const fx = baseFixture(db)
    const camperId = randomUUID()
    db.prepare('INSERT INTO campers (id, camp_id, display_name, group_id, is_active) VALUES (?, ?, ?, ?, 1)')
      .run(camperId, fx.campId, 'Camper A', fx.groupId)
    addPreference(db, fx.run.id, camperId)
    const activityId = randomUUID()
    db.prepare('INSERT INTO activities (id, camp_id, name, location_id, span_blocks, catalog_role) VALUES (?, ?, ?, ?, 1, ?)')
      .run(activityId, fx.campId, 'Lunch', fx.locationId, 'pinned_event')
    const anchorId = randomUUID()
    db.prepare('INSERT INTO fixed_events (id, camp_id, name, kind, activity_id) VALUES (?, ?, ?, ?, ?)')
      .run(anchorId, fx.campId, 'Lunch', 'fixed', activityId)
    db.prepare(
      'INSERT INTO template_slots (id, template_id, group_id, is_fixed_event, fixed_event_id, day_id, time_block_id) VALUES (?, ?, ?, 1, ?, ?, ?)'
    ).run(randomUUID(), fx.templateId, fx.groupId, anchorId, fx.dayId, fx.tb[0])

    const { rows } = deriveElectiveRunOuterRows(db, fx.run)

    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({
      cell_kind: 'inherited', activity_id: activityId, activity_name: 'Lunch',
    })

    db.close()
  })

  // Board finding, 2026-09-29 — Red Hat's export pin: resolveTemplateSlot
  // resolves an anchor cell by the template slot's own fixed_event_id, looked up
  // directly in fixed_events — it can never itself pick the wrong anchor. The
  // real defect (a week-scoped override anchor losing to an all-weeks anchor
  // for the same cell, fixed in src/engine/buildSchedule.js) lives upstream,
  // in which fixed_event_id the engine writes onto the slot. This test pins the
  // export's half of the contract: given a slot whose fixed_event_id already names
  // the week-scoped row, the export must carry THAT row's activity, not the
  // all-weeks row that happens to share the cell.
  it('resolves the week-scoped anchor named by fixed_event_id, not an unrelated all-weeks anchor at the same cell', () => {
    const db = freshDb()
    const fx = baseFixture(db)
    const weekId = 'week-A'
    db.prepare('INSERT INTO schedule_weeks (id, camp_id, name, sort_order, is_archived) VALUES (?, ?, ?, 0, 0)')
      .run(weekId, fx.campId, 'Week A')
    const camperId = randomUUID()
    db.prepare('INSERT INTO campers (id, camp_id, display_name, group_id, is_active) VALUES (?, ?, ?, ?, 1)')
      .run(camperId, fx.campId, 'Camper A', fx.groupId)
    addPreference(db, fx.run.id, camperId)

    const allWeeksActivityId = randomUUID()
    db.prepare('INSERT INTO activities (id, camp_id, name, location_id, span_blocks, catalog_role) VALUES (?, ?, ?, ?, 1, ?)')
      .run(allWeeksActivityId, fx.campId, 'Lunch', fx.locationId, 'pinned_event')
    const allWeeksAnchorId = randomUUID()
    db.prepare('INSERT INTO fixed_events (id, camp_id, name, kind, activity_id, schedule_week_id) VALUES (?, ?, ?, ?, ?, NULL)')
      .run(allWeeksAnchorId, fx.campId, 'Lunch', 'fixed', allWeeksActivityId)

    const weekScopedActivityId = randomUUID()
    db.prepare('INSERT INTO activities (id, camp_id, name, location_id, span_blocks, catalog_role) VALUES (?, ?, ?, ?, 1, ?)')
      .run(weekScopedActivityId, fx.campId, 'Shabbat Lunch', fx.locationId, 'pinned_event')
    const weekScopedAnchorId = randomUUID()
    db.prepare('INSERT INTO fixed_events (id, camp_id, name, kind, activity_id, schedule_week_id) VALUES (?, ?, ?, ?, ?, ?)')
      .run(weekScopedAnchorId, fx.campId, 'Shabbat Lunch', 'fixed', weekScopedActivityId, weekId)

    // The template slot names the week-scoped anchor — this is what the
    // engine fix guarantees for the week the override targets.
    db.prepare(
      'INSERT INTO template_slots (id, template_id, group_id, is_fixed_event, fixed_event_id, day_id, time_block_id) VALUES (?, ?, ?, 1, ?, ?, ?)'
    ).run(randomUUID(), fx.templateId, fx.groupId, weekScopedAnchorId, fx.dayId, fx.tb[0])

    const { rows } = deriveElectiveRunOuterRows(db, fx.run)

    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({
      cell_kind: 'inherited', activity_id: weekScopedActivityId, activity_name: 'Shabbat Lunch',
    })

    db.close()
  })

  it('collapses three contiguous identical-activity template_slots rows into one span-headed row (span_blocks: 3)', () => {
    const db = freshDb()
    const fx = baseFixture(db)
    const camperId = randomUUID()
    db.prepare('INSERT INTO campers (id, camp_id, display_name, group_id, is_active) VALUES (?, ?, ?, ?, 1)')
      .run(camperId, fx.campId, 'Camper A', fx.groupId)
    addPreference(db, fx.run.id, camperId)
    const activityId = randomUUID()
    db.prepare('INSERT INTO activities (id, camp_id, name, location_id, span_blocks) VALUES (?, ?, ?, ?, 1)')
      .run(activityId, fx.campId, 'Swim', fx.locationId)
    for (const tb of fx.tb) {
      db.prepare(
        'INSERT INTO template_slots (id, template_id, group_id, activity_id, day_id, time_block_id) VALUES (?, ?, ?, ?, ?, ?)'
      ).run(randomUUID(), fx.templateId, fx.groupId, activityId, fx.dayId, tb)
    }

    const { rows } = deriveElectiveRunOuterRows(db, fx.run)

    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({ time_block_id: fx.tb[0], span_blocks: 3, cell_kind: 'inherited' })
  })

  it('does not merge a non-contiguous repeat of the same activity (gap in between) into one span', () => {
    const db = freshDb()
    const fx = baseFixture(db)
    const camperId = randomUUID()
    db.prepare('INSERT INTO campers (id, camp_id, display_name, group_id, is_active) VALUES (?, ?, ?, ?, 1)')
      .run(camperId, fx.campId, 'Camper A', fx.groupId)
    addPreference(db, fx.run.id, camperId)
    const activityId = randomUUID()
    db.prepare('INSERT INTO activities (id, camp_id, name, location_id, span_blocks) VALUES (?, ?, ?, ?, 1)')
      .run(activityId, fx.campId, 'Swim', fx.locationId)
    // Occupy blocks 0 and 2, leaving block 1 empty — two separate spans.
    db.prepare(
      'INSERT INTO template_slots (id, template_id, group_id, activity_id, day_id, time_block_id) VALUES (?, ?, ?, ?, ?, ?)'
    ).run(randomUUID(), fx.templateId, fx.groupId, activityId, fx.dayId, fx.tb[0])
    db.prepare(
      'INSERT INTO template_slots (id, template_id, group_id, activity_id, day_id, time_block_id) VALUES (?, ?, ?, ?, ?, ?)'
    ).run(randomUUID(), fx.templateId, fx.groupId, activityId, fx.dayId, fx.tb[2])

    const { rows } = deriveElectiveRunOuterRows(db, fx.run)

    expect(rows).toHaveLength(2)
    expect(rows.map((r) => r.time_block_id).sort()).toEqual([fx.tb[0], fx.tb[2]].sort())
    expect(rows.every((r) => r.span_blocks === 1)).toBe(true)
  })

  it('excludes elective-set template_slots rows from the inheritance query (elective cells are the elective query\'s job)', () => {
    const db = freshDb()
    const fx = baseFixture(db)
    const camperId = randomUUID()
    db.prepare('INSERT INTO campers (id, camp_id, display_name, group_id, is_active) VALUES (?, ?, ?, ?, 1)')
      .run(camperId, fx.campId, 'Camper A', fx.groupId)
    addPreference(db, fx.run.id, camperId)
    const setId = randomUUID()
    db.prepare('INSERT INTO elective_sets (id, camp_id, name) VALUES (?, ?, ?)').run(setId, fx.campId, 'AM Electives')
    db.prepare(
      'INSERT INTO template_slots (id, template_id, group_id, elective_set_id, day_id, time_block_id) VALUES (?, ?, ?, ?, ?, ?)'
    ).run(randomUUID(), fx.templateId, fx.groupId, setId, fx.dayId, fx.tb[0])

    const { rows } = deriveElectiveRunOuterRows(db, fx.run)

    expect(rows).toHaveLength(0)
  })

  it('camper universe: a camper with an elective_preferences row but zero visible assignments still gets their inherited group cell', () => {
    const db = freshDb()
    const fx = baseFixture(db)
    const camperId = randomUUID()
    db.prepare('INSERT INTO campers (id, camp_id, display_name, group_id, is_active) VALUES (?, ?, ?, ?, 1)')
      .run(camperId, fx.campId, 'Camper A', fx.groupId)
    db.prepare('INSERT INTO elective_choices (id, run_id, label) VALUES (?, ?, ?)').run(randomUUID(), fx.run.id, 'Archery')
    const choiceId = db.prepare('SELECT id FROM elective_choices WHERE run_id = ?').get(fx.run.id).id
    db.prepare('INSERT INTO elective_preferences (id, run_id, camper_id, choice_id, rank) VALUES (?, ?, ?, ?, ?)')
      .run(randomUUID(), fx.run.id, camperId, choiceId, 1)
    const activityId = randomUUID()
    db.prepare('INSERT INTO activities (id, camp_id, name, location_id, span_blocks) VALUES (?, ?, ?, ?, 1)')
      .run(activityId, fx.campId, 'Swim', fx.locationId)
    db.prepare(
      'INSERT INTO template_slots (id, template_id, group_id, activity_id, day_id, time_block_id) VALUES (?, ?, ?, ?, ?, ?)'
    ).run(randomUUID(), fx.templateId, fx.groupId, activityId, fx.dayId, fx.tb[0])

    const { rows } = deriveElectiveRunOuterRows(db, fx.run)

    expect(rows.map((r) => r.camper_id)).toContain(camperId)
  })

  it('elective rows carry choice_id and is_linked_choice from elective_choices', () => {
    const db = freshDb()
    const fx = baseFixture(db)
    const camperId = randomUUID()
    db.prepare('INSERT INTO campers (id, camp_id, display_name, group_id, is_active) VALUES (?, ?, ?, ?, 1)')
      .run(camperId, fx.campId, 'Camper A', fx.groupId)
    const activityId = randomUUID()
    db.prepare('INSERT INTO activities (id, camp_id, name, location_id, span_blocks) VALUES (?, ?, ?, ?, 1)')
      .run(activityId, fx.campId, 'Archery', fx.locationId)
    const choiceId = randomUUID()
    db.prepare('INSERT INTO elective_choices (id, run_id, label, is_linked) VALUES (?, ?, ?, 1)').run(choiceId, fx.run.id, 'Bundle')
    const occurrenceId = randomUUID()
    db.prepare(
      'INSERT INTO elective_occurrences (id, run_id, elective_set_id, day_id, time_block_id) VALUES (?, ?, ?, ?, ?)'
    ).run(occurrenceId, fx.run.id, randomUUID(), fx.dayId, fx.tb[0])
    db.prepare(
      'INSERT INTO elective_assignments (id, run_id, occurrence_id, camper_id, activity_id, choice_id) VALUES (?, ?, ?, ?, ?, ?)'
    ).run(randomUUID(), fx.run.id, occurrenceId, camperId, activityId, choiceId)

    const { rows } = deriveElectiveRunOuterRows(db, fx.run)

    const electiveRow = rows.find((r) => r.cell_kind === 'elective')
    expect(electiveRow).toMatchObject({ choice_id: choiceId, is_linked_choice: true })
  })
})

describe('deriveElectiveRunOuterRows — F4: elective placement replaces inherited cell at the same block', () => {
  it('does not emit an inherited row for a (camper, day, time_block) already covered by that camper\'s elective row', () => {
    const db = freshDb()
    const fx = baseFixture(db)
    const camperId = randomUUID()
    db.prepare('INSERT INTO campers (id, camp_id, display_name, group_id, is_active) VALUES (?, ?, ?, ?, 1)')
      .run(camperId, fx.campId, 'Camper A', fx.groupId)

    // Inherited: group template has a plain activity slot at tb[0].
    const inheritedActivityId = randomUUID()
    db.prepare('INSERT INTO activities (id, camp_id, name, location_id, span_blocks) VALUES (?, ?, ?, ?, 1)')
      .run(inheritedActivityId, fx.campId, 'Arts & Crafts', fx.locationId)
    db.prepare(
      'INSERT INTO template_slots (id, template_id, group_id, activity_id, day_id, time_block_id) VALUES (?, ?, ?, ?, ?, ?)'
    ).run(randomUUID(), fx.templateId, fx.groupId, inheritedActivityId, fx.dayId, fx.tb[0])

    // Elective: the SAME camper holds a resolved elective assignment at the SAME day+block.
    const electiveActivityId = randomUUID()
    db.prepare('INSERT INTO activities (id, camp_id, name, location_id, span_blocks) VALUES (?, ?, ?, ?, 1)')
      .run(electiveActivityId, fx.campId, 'Archery', fx.locationId)
    const occurrenceId = randomUUID()
    db.prepare(
      'INSERT INTO elective_occurrences (id, run_id, elective_set_id, day_id, time_block_id) VALUES (?, ?, ?, ?, ?)'
    ).run(occurrenceId, fx.run.id, randomUUID(), fx.dayId, fx.tb[0])
    db.prepare(
      'INSERT INTO elective_assignments (id, run_id, occurrence_id, camper_id, activity_id) VALUES (?, ?, ?, ?, ?)'
    ).run(randomUUID(), fx.run.id, occurrenceId, camperId, electiveActivityId)

    const { rows } = deriveElectiveRunOuterRows(db, fx.run)

    // Only ONE row for this camper at tb[0]: the elective one. The inherited cell it would
    // otherwise generate is suppressed, not silently dropped from a collision — it never exists.
    const atBlock = rows.filter((r) => r.camper_id === camperId && r.time_block_id === fx.tb[0])
    expect(atBlock).toHaveLength(1)
    expect(atBlock[0]).toMatchObject({ cell_kind: 'elective', activity_id: electiveActivityId })

    db.close()
  })

  it('splits a multi-block inherited span around a single-block elective placement in the middle', () => {
    const db = freshDb()
    const fx = baseFixture(db)
    const camperId = randomUUID()
    db.prepare('INSERT INTO campers (id, camp_id, display_name, group_id, is_active) VALUES (?, ?, ?, ?, 1)')
      .run(camperId, fx.campId, 'Camper A', fx.groupId)

    // Inherited: a 3-block contiguous span (tb[0], tb[1], tb[2]) of the same activity.
    const inheritedActivityId = randomUUID()
    db.prepare('INSERT INTO activities (id, camp_id, name, location_id, span_blocks) VALUES (?, ?, ?, ?, 1)')
      .run(inheritedActivityId, fx.campId, 'Arts & Crafts', fx.locationId)
    for (const tb of fx.tb) {
      db.prepare(
        'INSERT INTO template_slots (id, template_id, group_id, activity_id, day_id, time_block_id) VALUES (?, ?, ?, ?, ?, ?)'
      ).run(randomUUID(), fx.templateId, fx.groupId, inheritedActivityId, fx.dayId, tb)
    }

    // Elective placement at the MIDDLE block (tb[1]) for the same camper.
    const electiveActivityId = randomUUID()
    db.prepare('INSERT INTO activities (id, camp_id, name, location_id, span_blocks) VALUES (?, ?, ?, ?, 1)')
      .run(electiveActivityId, fx.campId, 'Archery', fx.locationId)
    const occurrenceId = randomUUID()
    db.prepare(
      'INSERT INTO elective_occurrences (id, run_id, elective_set_id, day_id, time_block_id) VALUES (?, ?, ?, ?, ?)'
    ).run(occurrenceId, fx.run.id, randomUUID(), fx.dayId, fx.tb[1])
    db.prepare(
      'INSERT INTO elective_assignments (id, run_id, occurrence_id, camper_id, activity_id) VALUES (?, ?, ?, ?, ?)'
    ).run(randomUUID(), fx.run.id, occurrenceId, camperId, electiveActivityId)

    const { rows } = deriveElectiveRunOuterRows(db, fx.run)
    const camperRows = rows.filter((r) => r.camper_id === camperId).sort((a, b) => a.time_block_id.localeCompare(b.time_block_id))

    expect(camperRows).toHaveLength(3)
    expect(camperRows.find((r) => r.time_block_id === fx.tb[0])).toMatchObject({ cell_kind: 'inherited', span_blocks: 1 })
    expect(camperRows.find((r) => r.time_block_id === fx.tb[1])).toMatchObject({ cell_kind: 'elective', activity_id: electiveActivityId })
    expect(camperRows.find((r) => r.time_block_id === fx.tb[2])).toMatchObject({ cell_kind: 'inherited', span_blocks: 1 })

    db.close()
  })
})

describe('deriveElectiveRunOuterRows — F2: choice_label passthrough', () => {
  it('elective rows carry the choice_label from elective_choices.label', () => {
    const db = freshDb()
    const fx = baseFixture(db)
    const camperId = randomUUID()
    db.prepare('INSERT INTO campers (id, camp_id, display_name, group_id, is_active) VALUES (?, ?, ?, ?, 1)')
      .run(camperId, fx.campId, 'Camper A', fx.groupId)
    const activityId = randomUUID()
    db.prepare('INSERT INTO activities (id, camp_id, name, location_id, span_blocks) VALUES (?, ?, ?, ?, 1)')
      .run(activityId, fx.campId, 'Archery', fx.locationId)
    const choiceId = randomUUID()
    db.prepare('INSERT INTO elective_choices (id, run_id, label, is_linked) VALUES (?, ?, ?, 1)').run(choiceId, fx.run.id, 'Bundle Pack')
    const occurrenceId = randomUUID()
    db.prepare(
      'INSERT INTO elective_occurrences (id, run_id, elective_set_id, day_id, time_block_id) VALUES (?, ?, ?, ?, ?)'
    ).run(occurrenceId, fx.run.id, randomUUID(), fx.dayId, fx.tb[0])
    db.prepare(
      'INSERT INTO elective_assignments (id, run_id, occurrence_id, camper_id, activity_id, choice_id) VALUES (?, ?, ?, ?, ?, ?)'
    ).run(randomUUID(), fx.run.id, occurrenceId, camperId, activityId, choiceId)

    const { rows } = deriveElectiveRunOuterRows(db, fx.run)

    const electiveRow = rows.find((r) => r.cell_kind === 'elective')
    expect(electiveRow).toMatchObject({ choice_label: 'Bundle Pack' })

    db.close()
  })
})

describe('deriveElectiveRunOuterRows — F9: malformed inherited slot is recorded, not silently dropped', () => {
  it('records a skipped entry for a template_slots row that resolves to no kind (malformed row)', () => {
    const db = freshDb()
    const fx = baseFixture(db)
    const camperId = randomUUID()
    db.prepare('INSERT INTO campers (id, camp_id, display_name, group_id, is_active) VALUES (?, ?, ?, ?, 1)')
      .run(camperId, fx.campId, 'Camper A', fx.groupId)
    addPreference(db, fx.run.id, camperId)
    // A template_slots row with none of event_id/is_fixed_event/activity_id set — resolveTemplateSlot
    // returns { kind: null }, the malformed case.
    db.prepare(
      'INSERT INTO template_slots (id, template_id, group_id, day_id, time_block_id) VALUES (?, ?, ?, ?, ?)'
    ).run(randomUUID(), fx.templateId, fx.groupId, fx.dayId, fx.tb[0])

    const { rows, skipped } = deriveElectiveRunOuterRows(db, fx.run)

    expect(rows).toHaveLength(0)
    expect(skipped).toHaveLength(1)
    expect(skipped[0]).toMatchObject({ reason: expect.stringContaining('unresolved') })

    db.close()
  })
})
