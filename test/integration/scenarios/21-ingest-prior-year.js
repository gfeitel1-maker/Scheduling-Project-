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
 *   e. importing the same file twice adds nothing the second time.
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
import { buildPreview } from '../../../src/ingest/preview.js'

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
    const preview = buildPreview(campB, {})
    assert.ok(preview.createTotal > 0, 'the preview has something to add')

    // The director removes one group from the proposal.
    const rejected = preview.perEntity.groups.create[0]
    const approved = {
      groups: preview.perEntity.groups.create.filter((n) => n !== rejected),
      days_of_operation: preview.perEntity.days_of_operation.create,
      activities: preview.perEntity.activities.create,
      time_blocks: preview.perEntity.time_blocks.create,
    }

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

    // ---- d. a failed commit changes nothing ---------------------------------
    const groupsBefore = countOf('groups')
    const activitiesBefore = countOf('activities')
    const opsBefore = countOf('operations')

    // A name that already exists collides with UNIQUE(camp_id, name). This is
    // the real race: someone adds a record in another window between the
    // preview and the confirm.
    assert.throws(
      () => commitIngest(db, {
        approved: { groups: ['A Brand New Bunk'], activities: [listNames('activities')[0]] },
        camp_id: campId, device_id: deviceId,
      }),
      'a colliding import throws'
    )
    assert.equal(countOf('groups'), groupsBefore, 'the new group was rolled back too')
    assert.equal(countOf('activities'), activitiesBefore, 'no activity was added')
    assert.equal(countOf('operations'), opsBefore, 'no op survived the rollback')

    // ---- e. importing the same file twice adds nothing -----------------------
    const existing = {}
    for (const [key, table] of Object.entries({
      groups: 'groups', activities: 'activities', time_blocks: 'time_blocks',
    })) {
      existing[key] = db.prepare(`SELECT id, name FROM ${table}`).all()
    }
    existing.days_of_operation = db.prepare('SELECT id, label AS name FROM days_of_operation').all()

    const second = buildPreview(campB, existing)
    assert.equal(
      second.perEntity.activities.create.length, 0,
      'no activity is proposed a second time'
    )
    assert.ok(second.perEntity.activities.skip.length > 0, 'the skipped rows are named')
    assert.ok(
      second.perEntity.activities.skip.every((s) => s.matched),
      'every skipped row says what it matched'
    )
    // The one rejected group is still missing, so it is the only thing left.
    assert.deepEqual(second.perEntity.groups.create, [rejected], 'only the rejected group remains to add')

    db.close()
    return 'PASS'
  } finally {
    cleanupDirs(dirs)
  }
}
