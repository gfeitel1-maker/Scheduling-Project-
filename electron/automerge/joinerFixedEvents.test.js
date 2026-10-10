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
