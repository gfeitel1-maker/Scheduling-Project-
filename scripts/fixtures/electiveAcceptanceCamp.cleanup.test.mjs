// The T251 walk that found the app.setName stub gap also left a corrupted dev
// db behind: electiveAcceptanceCamp.mjs's loadHandlersFactory() ran INSIDE the
// try block, after the camp row was already written, so the failure there left
// a freshly-created db file holding a half-built camp — worse than the
// pre-existing "already holds N camp(s)" guard, because a retry silently sees
// a REAL camp row and refuses to proceed without --force, hiding that the
// camp is incomplete.
//
// deleteHalfBuiltDb is the cleanup this script now runs on any failure after
// the camp row is written: delete the db file (and WAL/SHM sidecars) ONLY when
// this run created it fresh. A failure against a db the caller already owned
// is not this script's file to delete.
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { deleteHalfBuiltDb } from './electiveAcceptanceCamp.mjs'

let dir
let dbPath

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'shoresh-cleanup-test-'))
  dbPath = path.join(dir, 'shoresh.sqlite')
})

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true })
})

function writeDbAndSidecars() {
  fs.writeFileSync(dbPath, 'fake db bytes')
  fs.writeFileSync(`${dbPath}-wal`, 'fake wal bytes')
  fs.writeFileSync(`${dbPath}-shm`, 'fake shm bytes')
}

describe('deleteHalfBuiltDb', () => {
  it('deletes the db file and its WAL/SHM sidecars when this run created it and the camp row was written', () => {
    writeDbAndSidecars()

    deleteHalfBuiltDb(dbPath, { dbAlreadyExisted: false, campRowWritten: true })

    expect(fs.existsSync(dbPath)).toBe(false)
    expect(fs.existsSync(`${dbPath}-wal`)).toBe(false)
    expect(fs.existsSync(`${dbPath}-shm`)).toBe(false)
  })

  it('leaves the db alone when the file already existed before this run', () => {
    writeDbAndSidecars()

    deleteHalfBuiltDb(dbPath, { dbAlreadyExisted: true, campRowWritten: true })

    expect(fs.existsSync(dbPath)).toBe(true)
  })

  it('leaves the db alone when the camp row was never written', () => {
    writeDbAndSidecars()

    deleteHalfBuiltDb(dbPath, { dbAlreadyExisted: false, campRowWritten: false })

    expect(fs.existsSync(dbPath)).toBe(true)
  })
})
