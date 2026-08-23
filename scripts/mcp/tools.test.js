// Tests for the MCP tool handlers (W10). Mirrors scripts/ingestCli.test.js
// and test/integration/scenarios/21-ingest-prior-year.js's temp-db setup:
// openLocalDb(tmp), manually insert camps/devices/users rows, call the
// exported handler functions directly — no stdio, no MCP client, no
// subprocess (docs/work/specs/2026-08-21-mcp-server-tool-schemas.md, "Test
// seam").

import { describe, it, expect, afterEach, vi } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { randomUUID } from 'node:crypto'

const buildScheduleCalls = []
vi.mock('../../src/engine/buildSchedule.js', async (importOriginal) => {
  const actual = await importOriginal()
  return {
    ...actual,
    default: (input) => {
      buildScheduleCalls.push(input)
      return actual.default(input)
    },
  }
})

import { openLocalDb } from '../../electron/db/localDb.js'
import {
  ingestPreviewTool,
  ingestCommitTool,
  listEntitiesTool,
  setupSummaryTool,
  scheduleStateTool,
  ENTITY_MAP,
} from './tools.js'

const SAMPLE = path.join(process.cwd(), 'docs/work/specs/samples/campB-achva-by-day.txt')

function makeTmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'shoresh-mcp-'))
}

function bootstrapDb(dir, { withDevice = true } = {}) {
  const dbPath = path.join(dir, 'shoresh.sqlite')
  const db = openLocalDb(dbPath)
  const campId = randomUUID()
  db.prepare('INSERT INTO camps (id, name, signing_secret) VALUES (?, ?, ?)').run(campId, 'Camp Test', 'a'.repeat(64))
  let deviceId = null
  if (withDevice) {
    deviceId = randomUUID()
    db.prepare('INSERT INTO devices (id, name) VALUES (?, ?)').run(deviceId, 'Host')
  }
  const userId = randomUUID()
  db.prepare("INSERT INTO users (id, camp_id, name, pin_hash, pin_salt, role) VALUES (?, ?, 'Ruth', 'h', 's', 'admin')")
    .run(userId, campId)
  db.close()
  return { dbPath, campId, deviceId, userId }
}

describe('scripts/mcp/tools.js', () => {
  const dirs = []
  afterEach(() => {
    for (const dir of dirs) fs.rmSync(dir, { recursive: true, force: true })
    dirs.length = 0
    buildScheduleCalls.length = 0
  })

  describe('ingestPreviewTool', () => {
    it('previews an import without writing, regardless of allowWrite', () => {
      const dir = makeTmpDir()
      dirs.push(dir)
      const { dbPath } = bootstrapDb(dir)

      const result = ingestPreviewTool({ file_path: SAMPLE }, { dbPath, allowWrite: false, authorUserId: null })

      expect(result.ok).toBe(true)
      expect(result.action).toBe('preview')
      expect(result.summary.created.groups).toBeGreaterThan(0)

      const after = openLocalDb(dbPath)
      const count = after.prepare('SELECT COUNT(*) c FROM groups').get().c
      after.close()
      expect(count).toBe(0)
    })
  })

  describe('ingestCommitTool', () => {
    it('refuses to commit when allowWrite is false, without touching the db', () => {
      const dir = makeTmpDir()
      dirs.push(dir)
      const { dbPath } = bootstrapDb(dir)

      const result = ingestCommitTool({ file_path: SAMPLE }, { dbPath, allowWrite: false, authorUserId: null })

      expect(result.ok).toBe(false)
      expect(result.error).toMatch(/--allow-write/)

      const after = openLocalDb(dbPath)
      const count = after.prepare('SELECT COUNT(*) c FROM groups').get().c
      after.close()
      expect(count).toBe(0)
    })

    it('commits when allowWrite is true', () => {
      const dir = makeTmpDir()
      dirs.push(dir)
      const { dbPath, userId } = bootstrapDb(dir)

      const result = ingestCommitTool({ file_path: SAMPLE }, { dbPath, allowWrite: true, authorUserId: userId })

      expect(result.ok).toBe(true)
      expect(result.action).toBe('commit')

      const after = openLocalDb(dbPath)
      const count = after.prepare('SELECT COUNT(*) c FROM groups').get().c
      after.close()
      expect(count).toBeGreaterThan(0)
    })

    it('errors clearly when the db has no device registered yet', () => {
      const dir = makeTmpDir()
      dirs.push(dir)
      const { dbPath } = bootstrapDb(dir, { withDevice: false })

      const result = ingestCommitTool({ file_path: SAMPLE }, { dbPath, allowWrite: true, authorUserId: 'u1' })

      expect(result.ok).toBe(false)
      expect(result.error).toMatch(/no device registered/)
    })
  })

  describe('listEntitiesTool', () => {
    it('lists rows for each mapped entity, empty on a fresh camp', () => {
      const dir = makeTmpDir()
      dirs.push(dir)
      const { dbPath } = bootstrapDb(dir)

      for (const friendly of Object.keys(ENTITY_MAP)) {
        const result = listEntitiesTool({ entity: friendly }, { dbPath })
        expect(result.ok, friendly).toBe(true)
        expect(result.entity).toBe(friendly)
        expect(result.rows).toEqual([])
      }
    })

    it('maps the friendly "groups" name to groups rows after an import', () => {
      const dir = makeTmpDir()
      dirs.push(dir)
      const { dbPath, userId } = bootstrapDb(dir)
      ingestCommitTool({ file_path: SAMPLE }, { dbPath, allowWrite: true, authorUserId: userId })

      const result = listEntitiesTool({ entity: 'groups' }, { dbPath })

      expect(result.ok).toBe(true)
      expect(result.rows.length).toBeGreaterThan(0)
    })

    it('returns an actionable error for an unknown friendly entity name', () => {
      const dir = makeTmpDir()
      dirs.push(dir)
      const { dbPath } = bootstrapDb(dir)

      const result = listEntitiesTool({ entity: 'not_a_real_entity' }, { dbPath })

      expect(result.ok).toBe(false)
      expect(result.error).toMatch(/unknown entity: not_a_real_entity/)
    })
  })

  describe('setupSummaryTool', () => {
    it('returns a count of 0 for every entity on a fresh camp', () => {
      const dir = makeTmpDir()
      dirs.push(dir)
      const { dbPath } = bootstrapDb(dir)

      const result = setupSummaryTool({}, { dbPath })

      expect(result.ok).toBe(true)
      for (const friendly of Object.keys(ENTITY_MAP)) {
        expect(result.counts[friendly], friendly).toBe(0)
      }
    })

    it('reflects real counts after an import', () => {
      const dir = makeTmpDir()
      dirs.push(dir)
      const { dbPath, userId } = bootstrapDb(dir)
      ingestCommitTool({ file_path: SAMPLE }, { dbPath, allowWrite: true, authorUserId: userId })

      const result = setupSummaryTool({}, { dbPath })

      expect(result.ok).toBe(true)
      expect(result.counts.groups).toBeGreaterThan(0)
      expect(result.counts.activities).toBeGreaterThan(0)
    })
  })

  describe('scheduleStateTool', () => {
    it('returns a null template with no slots when the route has never been built', () => {
      const dir = makeTmpDir()
      dirs.push(dir)
      const { dbPath } = bootstrapDb(dir)

      const result = scheduleStateTool({ route: 'generated' }, { dbPath })

      expect(result.ok).toBe(true)
      expect(result.route).toBe('generated')
      expect(result.template).toBeNull()
      expect(result.slots).toEqual([])
      expect(result.overlays).toEqual([])
      expect(result.findings).toEqual([])
      expect(result.conflicts).toEqual([])
    })

    it('single-week camp: resolves the one week automatically when week_id is omitted', () => {
      const dir = makeTmpDir()
      dirs.push(dir)
      const { dbPath, campId, userId } = bootstrapDb(dir)
      ingestCommitTool({ file_path: SAMPLE }, { dbPath, allowWrite: true, authorUserId: userId })

      const db = openLocalDb(dbPath)
      const weekId = randomUUID()
      db.prepare('INSERT INTO schedule_weeks (id, camp_id, name, sort_order) VALUES (?, ?, ?, ?)').run(weekId, campId, 'Week 1', 0)
      const templateId = randomUUID()
      db.prepare('INSERT INTO schedule_templates (id, camp_id, kind, name, week_id) VALUES (?, ?, ?, ?, ?)')
        .run(templateId, campId, 'generated', 'Week 1', weekId)
      const group = db.prepare('SELECT id FROM groups LIMIT 1').get()
      const activity = db.prepare('SELECT id FROM activities LIMIT 1').get()
      const day = db.prepare('SELECT id FROM days_of_operation LIMIT 1').get()
      const block = db.prepare('SELECT id FROM time_blocks LIMIT 1').get()
      db.prepare(
        'INSERT INTO template_slots (id, template_id, group_id, activity_id, day_id, time_block_id) VALUES (?, ?, ?, ?, ?, ?)'
      ).run(randomUUID(), templateId, group.id, activity.id, day.id, block.id)
      db.close()

      const result = scheduleStateTool({ route: 'generated' }, { dbPath })

      expect(result.ok).toBe(true)
      expect(result.needs_week).toBeUndefined()
      expect(result.week_id).toBe(weekId)
      expect(result.template).not.toBeNull()
      expect(result.template.id).toBe(templateId)
      expect(result.slots.length).toBe(1)
      expect(Array.isArray(result.findings)).toBe(true)
      expect(Array.isArray(result.conflicts)).toBe(true)
    })

    it('maps the friendly "weeks" name to schedule_weeks rows', () => {
      const dir = makeTmpDir()
      dirs.push(dir)
      const { dbPath, campId } = bootstrapDb(dir)
      const db = openLocalDb(dbPath)
      db.prepare('INSERT INTO schedule_weeks (id, camp_id, name, sort_order) VALUES (?, ?, ?, ?)').run(randomUUID(), campId, 'Week 1', 0)
      db.close()

      const result = listEntitiesTool({ entity: 'weeks' }, { dbPath })

      expect(result.ok).toBe(true)
      expect(result.rows.length).toBe(1)
      expect(setupSummaryTool({}, { dbPath }).counts.weeks).toBe(1)
    })

    describe('multi-week camp', () => {
      function bootstrapTwoWeeksTwoTemplates(dbPath, campId) {
        const db = openLocalDb(dbPath)
        const week1 = randomUUID()
        const week2 = randomUUID()
        db.prepare('INSERT INTO schedule_weeks (id, camp_id, name, sort_order) VALUES (?, ?, ?, ?)').run(week1, campId, 'Week 1', 0)
        db.prepare('INSERT INTO schedule_weeks (id, camp_id, name, sort_order) VALUES (?, ?, ?, ?)').run(week2, campId, 'Week 2', 1)
        const template1 = randomUUID()
        const template2 = randomUUID()
        db.prepare('INSERT INTO schedule_templates (id, camp_id, kind, name, week_id) VALUES (?, ?, ?, ?, ?)')
          .run(template1, campId, 'generated', 'Week 1', week1)
        db.prepare('INSERT INTO schedule_templates (id, camp_id, kind, name, week_id) VALUES (?, ?, ?, ?, ?)')
          .run(template2, campId, 'generated', 'Week 2', week2)
        db.close()
        return { week1, week2, template1, template2 }
      }

      it('resolves the correct template when week_id is provided', () => {
        const dir = makeTmpDir()
        dirs.push(dir)
        const { dbPath, campId } = bootstrapDb(dir)
        const { week1, week2, template1, template2 } = bootstrapTwoWeeksTwoTemplates(dbPath, campId)

        const result1 = scheduleStateTool({ route: 'generated', week_id: week1 }, { dbPath })
        expect(result1.ok).toBe(true)
        expect(result1.week_id).toBe(week1)
        expect(result1.template.id).toBe(template1)

        const result2 = scheduleStateTool({ route: 'generated', week_id: week2 }, { dbPath })
        expect(result2.ok).toBe(true)
        expect(result2.week_id).toBe(week2)
        expect(result2.template.id).toBe(template2)
      })

      // Red Hat HIGH: scheduleStateTool resolved weekId but did not thread it
      // into buildSchedule(...), so week-bound anchors for the queried week
      // were silently dropped from every findings/conflicts computation.
      it('passes the resolved weekId through to buildSchedule so week-bound anchors are honored', () => {
        const dir = makeTmpDir()
        dirs.push(dir)
        const { dbPath, campId } = bootstrapDb(dir)
        const { week1, week2 } = bootstrapTwoWeeksTwoTemplates(dbPath, campId)

        scheduleStateTool({ route: 'generated', week_id: week1 }, { dbPath })
        expect(buildScheduleCalls.length).toBe(1)
        expect(buildScheduleCalls[0].weekId).toBe(week1)

        scheduleStateTool({ route: 'generated', week_id: week2 }, { dbPath })
        expect(buildScheduleCalls.length).toBe(2)
        expect(buildScheduleCalls[1].weekId).toBe(week2)
      })

      it('returns needs_week with the week list when week_id is omitted and multiple weeks exist', () => {
        const dir = makeTmpDir()
        dirs.push(dir)
        const { dbPath, campId } = bootstrapDb(dir)
        const { week1, week2 } = bootstrapTwoWeeksTwoTemplates(dbPath, campId)

        const result = scheduleStateTool({ route: 'generated' }, { dbPath })

        expect(result.ok).toBe(true)
        expect(result.needs_week).toBe(true)
        expect(result.weeks.map((w) => w.id).sort()).toEqual([week1, week2].sort())
        expect(result.template).toBeUndefined()
      })
    })
  })
})
