// Tests for the MCP tool handlers (W10). Mirrors scripts/ingestCli.test.js
// and test/integration/scenarios/21-ingest-prior-year.js's temp-db setup:
// openLocalDb(tmp), manually insert camps/devices/users rows, call the
// exported handler functions directly — no stdio, no MCP client, no
// subprocess (docs/work/specs/2026-08-21-mcp-ingestion-server.md, "Test
// seam").

import { describe, it, expect, afterEach } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { randomUUID } from 'node:crypto'

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

    it('returns the stored template/slots plus computed findings/conflicts once one exists', () => {
      const dir = makeTmpDir()
      dirs.push(dir)
      const { dbPath, campId, userId } = bootstrapDb(dir)
      ingestCommitTool({ file_path: SAMPLE }, { dbPath, allowWrite: true, authorUserId: userId })

      const db = openLocalDb(dbPath)
      const templateId = randomUUID()
      db.prepare('INSERT INTO schedule_templates (id, camp_id, kind, name) VALUES (?, ?, ?, ?)').run(templateId, campId, 'generated', 'Week 1')
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
      expect(result.template).not.toBeNull()
      expect(result.template.id).toBe(templateId)
      expect(result.slots.length).toBe(1)
      expect(Array.isArray(result.findings)).toBe(true)
      expect(Array.isArray(result.conflicts)).toBe(true)
    })
  })
})
