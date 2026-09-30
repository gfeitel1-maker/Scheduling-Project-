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
import { createUser } from './auth/localAuth.js'
import { appendOp } from './ops/operations.js'
import { openTemplatedDb } from './db/testDbTemplate.js'
import { makeHandlers } from './main.js'
import { bootstrapDevice, buildAcceptanceCamp } from './fixtures/electiveAcceptanceCamp.js'

export async function openAcceptanceCamp() {
  const templated = openTemplatedDb()
  const db = templated.db
  const { campId, deviceId, cohortId } = bootstrapDevice(db)

  // The user goes through createUser + the real appendOp, NOT a direct INSERT:
  // createUser is the only path that mints the Host `auth_sig` the projection
  // layer verifies (electron/main.js's write() refuses credential fields for
  // exactly that reason).
  const user = await createUser(
    db,
    { camp_id: campId, name: 'Director', pin: '123400', role: 'admin' },
    async ({ entity, entity_id, field, value }) => {
      const op = appendOp(db, { entity, entity_id, field, value, author_user_id: null, device_id: deviceId, parent_op_id: null })
      return { status: 'applied', op }
    }
  )

  const handlers = makeHandlers(db, deviceId, {})
  const { token } = await handlers.login({ name: 'Director', pin: '123400' })
  // write()/bulkReplace() refuse until a mode is chosen — that is where
  // syncClient is created (electron/main.js:986).
  await handlers.chooseMode({ mode: 'host', token })

  const fixture = await buildAcceptanceCamp(db, {
    handlers, token, campId, deviceId, cohortId, authorUserId: user.id,
  })

  return {
    db,
    file: templated.file,
    handlers,
    token,
    deviceId,
    userId: user.id,
    fixture,
    close() {
      db.close()
      for (const suffix of ['', '-wal', '-shm']) {
        if (fs.existsSync(templated.file + suffix)) fs.unlinkSync(templated.file + suffix)
      }
    },
  }
}
