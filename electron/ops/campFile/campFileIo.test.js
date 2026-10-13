// @vitest-environment node
import { describe, it, expect, beforeEach, afterEach, afterAll } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { openTemplatedDb, cleanupTemplatedDbs } from '../../db/testDbTemplate.js'
import { setUserDataDirGetter, resetForTests } from '../../sync/automerge/liveDoc.js'
import { saveCampFileToDisk } from './campFileIo.js'
import { makeFreshCamp, buildFixtureCamp } from './campFileTestSupport.js'

afterAll(() => cleanupTemplatedDbs())

let dir, db
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'shoresh-campfile-io-'))
  setUserDataDirGetter(() => dir)
  db = openTemplatedDb().db
})
afterEach(() => {
  resetForTests()
  db.close()
  fs.rmSync(dir, { recursive: true, force: true })
})

describe('saveCampFileToDisk size caps', () => {
  it('refuses an export over the same caps Open enforces, and writes nothing', async () => {
    const camp = makeFreshCamp(db, { name: 'Big' })
    buildFixtureCamp(db, camp)
    const target = path.join(dir, 'big.shoresh-camp')
    const result = await saveCampFileToDisk({ db, camp: { id: camp.campId, name: 'Big' }, showSaveDialog: async () => ({ canceled: false, filePath: target }), caps: { MAX_ROWS_PER_ENTITY: 1 } })
    expect(result).toMatchObject({ ok: false, reason: 'too_large' })
    expect(fs.readdirSync(dir).filter((n) => n.includes('shoresh-camp'))).toEqual([])
  })
})
