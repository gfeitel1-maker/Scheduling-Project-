// @vitest-environment node
// Two-instance E2E on 714d1b32 (2026-10-10): a device that JOINED a camp whose host imported campB
// logged 222 "projector: skipping doc 'fixed_events' row ... CHECK constraint failed" and never
// got the imported fixed events. The host's own writes put `kind` first (REQUIRED_FIRST_ON_WRITE);
// the projector applied a row's fields in PROJECTIONS order, so on a fresh device the row was
// created with the defaults kind='fixed', is_all_groups=1 and is_all_groups=0 for a recurring
// event hit the CHECK before kind='recurring' arrived. This projects the host's real imported
// document onto a fresh SQLite, as a joiner does.
import { it, expect } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { openTemplatedDb } from '../db/testDbTemplate.js'
import { openLocalDb } from '../db/localDb.js'
import { runIngestCli } from '../../scripts/ingestCli.js'
import { setUserDataDirGetter, setDocCipher, resetForTests, flushPendingWrites, ensureSeeded } from '../sync/automerge/liveDoc.js'
import { loadDoc } from '../sync/automerge/docStore.js'
import { projectAll } from './projector.js'

const CAMPB = path.join(process.cwd(), 'docs/work/specs/samples/campB-by-day.txt')
const fixedEvents = (db) => db.prepare('SELECT id, kind, is_all_groups FROM fixed_events ORDER BY id').all()

it("a joiner projects every fixed event of the host's imported campB", () => {
  const ud = fs.mkdtempSync(path.join(os.tmpdir(), 'joiner-fe-'))
  resetForTests(); setUserDataDirGetter(() => ud); setDocCipher(null)
  const campId = randomUUID()
  const { db: seed, file: hostPath } = openTemplatedDb()
  seed.prepare('INSERT INTO camps (id, name, signing_secret) VALUES (?, ?, ?)').run(campId, 'Camp Test', 'a'.repeat(64))
  seed.prepare('INSERT INTO devices (id, name) VALUES (?, ?)').run(randomUUID(), 'Host')
  ensureSeeded(seed); flushPendingWrites(); seed.close()

  const result = runIngestCli({ file: CAMPB, dbPath: hostPath, action: 'commit' })
  expect(result.ok).toBe(true)
  flushPendingWrites()
  const host = openLocalDb(hostPath)
  const hostEvents = fixedEvents(host)
  expect(hostEvents.some((e) => e.kind === 'recurring' && e.is_all_groups === 0)).toBe(true)
  const doc = loadDoc(ud, campId)
  expect(doc).not.toBeNull()

  const { db: joiner } = openTemplatedDb()
  joiner.prepare('INSERT INTO camps (id, name, signing_secret) VALUES (?, ?, ?)').run(campId, 'Camp Test', 'a'.repeat(64))
  const failures = projectAll(joiner, doc)?.failures ?? []
  expect(failures.filter((f) => f.entity === 'fixed_events')).toEqual([])
  expect(fixedEvents(joiner)).toEqual(hostEvents)
  host.close(); joiner.close()
}, 120_000)

// Red Hat, PR #891: writing kind first must not break the reverse transition. A device holding a
// recurring row (is_all_groups=0) that the document turns into a fixed one must write the scope
// columns before kind='fixed', or the same CHECK fails the other way.
it('an existing recurring fixed event that becomes fixed still projects', async () => {
  const { createEmptyDoc, applyWrites } = await import('./campDocument.js')
  const campId = randomUUID()
  const { db } = openTemplatedDb()
  db.prepare('INSERT INTO camps (id, name, signing_secret) VALUES (?, ?, ?)').run(campId, 'Camp Test', 'a'.repeat(64))
  const row = (fields) => Object.entries(fields).map(([field, value]) => ({ entity: 'fixed_events', entity_id: 'fe-1', field, value }))
  let doc = applyWrites(createEmptyDoc(), row({ camp_id: campId, name: 'Lunch', kind: 'recurring', is_all_groups: '0', group_ids: '["g1"]' }))
  projectAll(db, doc)
  expect(db.prepare('SELECT kind, is_all_groups FROM fixed_events WHERE id = ?').get('fe-1')).toEqual({ kind: 'recurring', is_all_groups: 0 })
  doc = applyWrites(doc, row({ kind: 'fixed', is_all_groups: '1', group_ids: '[]' }))
  const failures = projectAll(db, doc)?.failures ?? []
  expect(failures.filter((f) => f.entity === 'fixed_events')).toEqual([])
  expect(db.prepare('SELECT kind, is_all_groups FROM fixed_events WHERE id = ?').get('fe-1')).toEqual({ kind: 'fixed', is_all_groups: 1 })
  db.close()
})
