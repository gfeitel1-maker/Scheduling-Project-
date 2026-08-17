/**
 * Scenario 21: Ingesting a prior year's schedule.
 *
 * docs/adr/2026-08-01-ingesting-a-prior-year-schedule.md — completion
 * evidence 2, 3 and 5.
 *
 * Runs a real camp's real schedule file through the whole chain — parse,
 * extract, preview, commit — against a real Host database, and then a second
 * time to prove the duplicate rule.
 *
 * Verifies:
 *   a. both supplied layouts (one page per group, one page per day) produce
 *      correct entity lists, including the wrapped-cell case;
 *   b. only what the director approved is written — a name removed from the
 *      proposal does not reach the database;
 *   c. the whitelist holds: a caller asking for placements is refused, and no
 *      template_slots row appears;
 *   d. a failed commit leaves the camp exactly as it was, with no partial
 *      import and no orphan ops;
 *   e. importing the same file twice adds nothing the second time;
 *   f. Camp A's bunks are filed under the units their own names encode.
 */

import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { makeTmpDir, cleanupDirs } from '../harness.js'
import { openLocalDb } from '../../../electron/db/localDb.js'
import { commitIngest } from '../../../electron/ops/ingest.js'
import { parseTextGrid } from '../../../src/ingest/textGrid.js'
import { extractEntities } from '../../../src/ingest/extractEntities.js'
import { inferFixedEvents } from '../../../src/ingest/fixedEvents.js'

// ADR 2026-08-17-onescreen-reconciliation-merge.md §2 retired buildPreview —
// recognition-against-existing now lives INSIDE buildPlan/commitIngest
// (buildExistingSnapshot queries the live db), not a separate renderer-side
// preview pass. This scenario drives the same real path ImportScreen.jsx's
// buildCommitInputs() does: every name extractEntities offers is "approved"
// unconditionally, and commitIngest itself recognizes what already exists.

const SAMPLES = path.join(process.cwd(), 'docs/work/specs/samples')

export async function run() {
  const dirs = []
  try {
    const dir = makeTmpDir()
    dirs.push(dir)
    const db = openLocalDb(path.join(dir, 'shoresh.sqlite'))

    const campId = randomUUID()
    const deviceId = randomUUID()
    const userId = randomUUID()
    db.prepare('INSERT INTO camps (id, name, signing_secret) VALUES (?, ?, ?)').run(campId, 'Camp Test', 'a'.repeat(64))
    db.prepare('INSERT INTO devices (id, name) VALUES (?, ?)').run(deviceId, 'Host')
    db.prepare("INSERT INTO users (id, camp_id, name, pin_hash, pin_salt, role) VALUES (?, ?, 'Ruth', 'h', 's', 'admin')")
      .run(userId, campId)

    const listNames = (table, column = 'name') =>
      db.prepare(`SELECT ${column} AS name FROM ${table}`).all().map((r) => r.name)
    const countOf = (table) => db.prepare(`SELECT COUNT(*) c FROM ${table}`).get().c

    // ---- a. both layouts read correctly -------------------------------------
    const campB = extractEntities(parseTextGrid(fs.readFileSync(path.join(SAMPLES, 'campB-achva-by-day.txt'), 'utf8')))
    const campA = extractEntities(parseTextGrid(fs.readFileSync(path.join(SAMPLES, 'campA-bunk-schedules.txt'), 'utf8')))

    assert.equal(campB.orientation.pages, 'days', 'Camp B is one page per day')
    assert.equal(campA.orientation.pages, 'groups', 'Camp A is one page per group')
    assert.equal(campB.entities.groups.length, 14, 'Camp B has 14 groups')
    assert.ok(campB.entities.activities.includes('Little Playground'), 'a wrapped cell is reassembled')
    assert.deepEqual(
      campB.entities.days_of_operation,
      ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday'],
      'Camp B runs Monday to Friday'
    )

    // ---- b. only what was approved is written -------------------------------
    // The full set of names campB's file offers — buildCommitInputs() sends
    // every proposed name unconditionally; recognition-against-existing now
    // happens inside commitIngest, not a separate preview pass.
    const fullApproved = {
      groups: campB.entities.groups,
      days_of_operation: campB.entities.days_of_operation,
      activities: campB.entities.activities,
      time_blocks: campB.entities.time_blocks,
    }
    assert.ok(fullApproved.groups.length > 0, 'the file has something to add')

    // The director removes one group from the proposal.
    const rejected = fullApproved.groups[0]
    const approved = { ...fullApproved, groups: fullApproved.groups.filter((n) => n !== rejected) }

    const result = commitIngest(db, { approved, camp_id: campId, author_user_id: userId, device_id: deviceId })
    assert.ok(result.total > 0, 'records were created')

    const groupNames = listNames('groups')
    assert.ok(!groupNames.includes(rejected), `the rejected group "${rejected}" was not written`)
    assert.equal(groupNames.length, 13, '13 of 14 groups written')
    assert.equal(countOf('days_of_operation'), 5, 'five days written')

    // Every creation is attributed, so History and Trash can name who imported.
    const unattributed = db
      .prepare("SELECT COUNT(*) c FROM operations WHERE entity = 'groups' AND author_user_id IS NULL")
      .get().c
    assert.equal(unattributed, 0, 'every import op records its author')

    // ---- c. the whitelist holds --------------------------------------------
    assert.throws(
      () => commitIngest(db, {
        approved: { template_slots: ['anything'] },
        camp_id: campId, device_id: deviceId,
      }),
      /template_slots cannot be created by an import/,
      'placements are refused'
    )
    assert.equal(countOf('template_slots'), 0, 'no placement row was written')

    // ---- d. a held commit changes nothing -----------------------------------
    // S1a recognition (docs/adr/2026-08-08-s1a-import-recognizes-existing-entities.md)
    // changed what a name collision DOES. Before S1a, a name the camp already had
    // was blindly re-created and hit UNIQUE(camp_id, name), so a colliding import
    // THREW. Now such a name is recognized as the same entity — an `unchanged`
    // no-op that writes zero ops (see the F4 unit contract in
    // electron/ops/ingestRecognition.test.js). The genuine preview→confirm race
    // this section stands for — a peer adds, in the review window, a second row
    // whose name normalizes to one the import proposes — is no longer a raw throw
    // either: commit-time re-resolution surfaces it as an `ambiguous_identity`
    // conflict and HOLDS the whole import (`held: true`), rolling everything back
    // atomically. This section proves that atomic no-op still holds, using the
    // modern trigger; the old raw-UNIQUE-throw expectation was retired with S1a.
    const collide = listNames('activities')[0]
    // A second live row that normalizes to the same name — legal under the raw
    // UNIQUE ('Activity' vs 'activity ') — reproducing the peer-added-a-colliding
    // -row race the old throw stood in for. Inserted directly (not via an op), so
    // it is the only change to the camp and is removed again below.
    db.prepare('INSERT INTO activities (id, camp_id, name) VALUES (?, ?, ?)')
      .run(randomUUID(), campId, `${collide} `)

    const groupsBefore = countOf('groups')
    const activitiesBefore = countOf('activities')
    const opsBefore = countOf('operations')

    const held = commitIngest(db, {
      approved: { groups: ['A Brand New Bunk'], activities: [collide] },
      camp_id: campId, device_id: deviceId,
    })
    assert.equal(held.held, true, 'a commit-time name collision holds the whole import instead of throwing')
    assert.equal(held.conflicts[0].reason, 'ambiguous_identity', 'the collision is surfaced for review, not silently applied')
    assert.equal(countOf('groups'), groupsBefore, 'the new group was rolled back too — nothing partial landed')
    assert.equal(countOf('activities'), activitiesBefore, 'no activity was added')
    assert.equal(countOf('operations'), opsBefore, 'no op survived the held rollback')

    // Restore the pre-(d) camp exactly, so the later sections read the same state
    // the throwing version left them (the held import itself wrote nothing).
    db.prepare('DELETE FROM activities WHERE camp_id = ? AND name = ?').run(campId, `${collide} `)

    // ---- e. importing the same file twice adds nothing -----------------------
    // Re-import the FULL proposal — this is the definitive re-import
    // recognize-existing oracle (see the fix-round brief): if recognition is
    // broken, this either re-creates duplicate rows or throws a UNIQUE
    // constraint violation on the second commit.
    const activitiesBeforeSecond = countOf('activities')
    const timeBlocksBeforeSecond = countOf('time_blocks')
    const daysBeforeSecond = countOf('days_of_operation')
    const groupsBeforeSecond = countOf('groups')

    const second = commitIngest(db, { approved: fullApproved, camp_id: campId, author_user_id: userId, device_id: deviceId })

    assert.equal(second.held, false, 'a full re-import of an already-imported file does not hold')
    assert.equal(second.created.activities, 0, 'no activity is proposed a second time')
    assert.equal(second.created.time_blocks, 0, 'no time block is proposed a second time')
    assert.equal(second.created.days_of_operation, 0, 'no day is proposed a second time')
    // The one rejected group is still missing from the camp, so it is the
    // only thing left for the second import to create.
    assert.equal(second.created.groups, 1, 'only the previously-rejected group is created')

    assert.equal(countOf('activities'), activitiesBeforeSecond, 'activity count is unchanged by the re-import')
    assert.equal(countOf('time_blocks'), timeBlocksBeforeSecond, 'time block count is unchanged by the re-import')
    assert.equal(countOf('days_of_operation'), daysBeforeSecond, 'day count is unchanged by the re-import')
    assert.equal(countOf('groups'), groupsBeforeSecond + 1, 'group count grows by exactly the rejected group')
    assert.ok(listNames('groups').includes(rejected), 'the previously-rejected group now exists')

    // ---- f. units are read from the bunk names and linked ------------------
    // "Adom 4's - Matzo Balls" names both the unit and the bunk. 29 of Camp A's
    // 33 titles do; the other four are bunks with no unit, which is a real
    // shape rather than a parse failure.
    const aPreview = campA
    assert.ok(aPreview.entities.tiers.length >= 10, 'Camp A proposes its units')

    const dir2 = makeTmpDir()
    dirs.push(dir2)
    const db2 = openLocalDb(path.join(dir2, 'shoresh.sqlite'))
    const camp2 = randomUUID()
    const dev2 = randomUUID()
    db2.prepare('INSERT INTO camps (id, name, signing_secret) VALUES (?, ?, ?)').run(camp2, 'Camp A', 'b'.repeat(64))
    db2.prepare('INSERT INTO devices (id, name) VALUES (?, ?)').run(dev2, 'Host')

    const aApproved = {
      tiers: aPreview.entities.tiers,
      groups: aPreview.entities.groups,
    }
    const aLinks = { groups: {} }
    for (const name of aApproved.groups) {
      if (aPreview.groupUnits[name]) aLinks.groups[name] = aPreview.groupUnits[name]
    }
    commitIngest(db2, { approved: aApproved, links: aLinks, camp_id: camp2, device_id: dev2 })

    const filed = db2.prepare('SELECT COUNT(*) c FROM groups WHERE tier_id IS NOT NULL').get().c
    const unfiled = db2.prepare('SELECT COUNT(*) c FROM groups WHERE tier_id IS NULL').get().c
    assert.ok(filed >= 25, `most bunks are filed under a unit (${filed})`)
    assert.ok(unfiled > 0 && unfiled <= 6, `the unit-less bunks stay unfiled (${unfiled})`)

    const matzo = db2
      .prepare('SELECT t.name AS unit FROM groups g JOIN tiers t ON t.id = g.tier_id WHERE g.name = ?')
      .get('Matzo Balls')
    assert.equal(matzo?.unit, "Adom 4's", 'Matzo Balls is in Adom 4\'s')

    // ---- g. units and time blocks are filed into the active Program (T33) ----
    // Units and time blocks are Program-scoped; the setup screens list only the
    // active Program's rows, so an import that left cohort_id null created rows
    // the director could never see — and an invisible unit cannot appear tied to
    // its groups. The active Program is threaded into the commit so they land
    // where they show. docs/work/tickets/T33-ingest-creates-cohort-orphaned-entities.md.
    const dir3 = makeTmpDir()
    dirs.push(dir3)
    const db3 = openLocalDb(path.join(dir3, 'shoresh.sqlite'))
    const camp3 = randomUUID()
    const dev3 = randomUUID()
    const coMain = randomUUID()
    db3.prepare('INSERT INTO camps (id, name, signing_secret) VALUES (?, ?, ?)').run(camp3, 'Camp A', 'c'.repeat(64))
    db3.prepare('INSERT INTO devices (id, name) VALUES (?, ?)').run(dev3, 'Host')
    db3.prepare('INSERT INTO cohorts (id, camp_id, name) VALUES (?, ?, ?)').run(coMain, camp3, 'Main')

    commitIngest(db3, {
      approved: { tiers: aApproved.tiers, groups: aApproved.groups, time_blocks: aPreview.entities.time_blocks },
      links: aLinks, camp_id: camp3, cohort_id: coMain, device_id: dev3,
    })

    assert.equal(
      db3.prepare('SELECT COUNT(*) c FROM tiers WHERE cohort_id IS NOT ?').get(coMain).c, 0,
      'every imported unit is filed under the active Program, not orphaned'
    )
    assert.equal(
      db3.prepare('SELECT COUNT(*) c FROM time_blocks WHERE cohort_id IS NOT ?').get(coMain).c, 0,
      'every imported time block is filed under the active Program'
    )
    const matzo3 = db3
      .prepare('SELECT t.cohort_id AS c FROM groups g JOIN tiers t ON t.id = g.tier_id WHERE g.name = ?')
      .get('Matzo Balls')
    assert.equal(matzo3?.c, coMain, 'a filed bunk\'s unit lives in the active Program, so both are visible together')
    db3.close()

    // ---- h. a recurring fixed event is created, and still no template_slots (T34) ----
    // docs/adr/2026-08-03-ingesting-recurring-fixed-events.md — completion
    // evidence 3 and 4. Camp B pins Mifkad/Carpool/etc. to a period for every
    // group every day; ingest proposes them as fixed events (anchor_activities),
    // and a commit that creates one still writes zero template_slots.
    const dir4 = makeTmpDir()
    dirs.push(dir4)
    const db4 = openLocalDb(path.join(dir4, 'shoresh.sqlite'))
    const camp4 = randomUUID()
    const dev4 = randomUUID()
    const coMain4 = randomUUID()
    db4.prepare('INSERT INTO camps (id, name, signing_secret) VALUES (?, ?, ?)').run(camp4, 'Camp B', 'd'.repeat(64))
    db4.prepare('INSERT INTO devices (id, name) VALUES (?, ?)').run(dev4, 'Host')
    db4.prepare('INSERT INTO cohorts (id, camp_id, name) VALUES (?, ?, ?)').run(coMain4, camp4, 'Main')

    const { fixedEvents } = inferFixedEvents(
      parseTextGrid(fs.readFileSync(path.join(SAMPLES, 'campB-achva-by-day.txt'), 'utf8')),
      campB
    )
    assert.ok(fixedEvents.length > 0, 'Camp B implies at least one fixed event')

    const result4 = commitIngest(db4, {
      approved: fullApproved,
      fixedEvents,
      camp_id: camp4, cohort_id: coMain4, device_id: dev4,
    })

    assert.ok(result4.fixedEvents.created > 0, 'at least one fixed event was written')
    assert.equal(
      db4.prepare('SELECT COUNT(*) c FROM anchor_activities').get().c,
      result4.fixedEvents.created,
      'every reported fixed-event row is in anchor_activities'
    )
    assert.equal(
      db4.prepare('SELECT COUNT(*) c FROM anchor_activities WHERE cohort_id IS NOT ?').get(coMain4).c, 0,
      'every fixed event is scoped to the active Program'
    )
    assert.equal(
      db4.prepare('SELECT COUNT(*) c FROM template_slots').get().c, 0,
      'no template_slots row appears, even with a fixed event created — the standing boundary holds under T34'
    )
    db4.close()

    db2.close()
    db.close()
    return 'PASS'
  } finally {
    cleanupDirs(dirs)
  }
}
