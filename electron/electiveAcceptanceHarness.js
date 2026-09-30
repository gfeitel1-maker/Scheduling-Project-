// The five T251 test files' shared preamble, and nothing else.
//
// docs/work/tickets/T251-t199-acceptance-fixture.md.
//
// It is a MODULE rather than five copies for the same reason
// ./fixtures/electiveAcceptanceCamp.js is: five hand-copied harnesses are five
// chances to drift, and a harness that differs between two files makes a
// disagreement between those files uninterpretable.
//
// The shape is copied from electron/electiveRunOuterSchedule.integration.test.js:
// openTemplatedDb, a real getOrCreateDeviceId, an authorized device row, a real
// createUser over a real appendOp, a real login, and makeHandlers — the REAL IPC
// handlers. `vi.mock('electron', ...)` cannot live here (a mock must be hoisted
// in the file that imports the mocked module), so each test file declares it.
import fs from 'node:fs'
import { openTemplatedDb } from './db/testDbTemplate.js'
import { makeHandlers } from './main.js'
import { seedAcceptanceCamp } from './fixtures/electiveAcceptanceCamp.js'

export async function openAcceptanceCamp() {
  const templated = openTemplatedDb()
  const db = templated.db
  // The six-step preamble is `seedAcceptanceCamp` in the fixture module — ONE
  // copy, shared with scripts/fixtures/electiveAcceptanceCamp.mjs, so the
  // manual half of T251's acceptance cannot be looking at a differently-built
  // camp from this one.
  const seeded = await seedAcceptanceCamp(db, { makeHandlers })

  return {
    db,
    file: templated.file,
    handlers: seeded.handlers,
    token: seeded.token,
    deviceId: seeded.deviceId,
    userId: seeded.userId,
    fixture: seeded.fixture,
    close() {
      db.close()
      for (const suffix of ['', '-wal', '-shm']) {
        if (fs.existsSync(templated.file + suffix)) fs.unlinkSync(templated.file + suffix)
      }
    },
  }
}
