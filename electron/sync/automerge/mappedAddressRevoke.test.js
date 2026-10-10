// @vitest-environment node
//
// T359 slice 3: revoking a peer needs no change to this device's own router mapping (it serves every
// other peer and is admitted only by Noise, authGate and isPeerRevoked), but the revoked peer's remembered
// router-mapped address must go, so rung 1 can never dial it again.
import Database from 'better-sqlite3'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { initSchema } from '../../db/localDb.js'
import { forgetPeerAddress, loadMappedPeerAddress, rememberMappedPeerAddress } from './peerAddressBook.js'

const files = []
afterEach(() => { for (const f of files.splice(0)) for (const s of ['', '-wal', '-shm']) if (fs.existsSync(f + s)) fs.unlinkSync(f + s) })

it('a revoked peer\'s remembered mapped address is removed with the rest of its addresses', () => {
  const file = path.join(os.tmpdir(), `shoresh-mapped-revoke-${Date.now()}-${Math.random()}.sqlite`)
  files.push(file)
  const db = new Database(file)
  initSchema(db)
  const addr = '/ip4/93.184.216.34/tcp/50123/p2p/peer-1'
  expect(rememberMappedPeerAddress(db, 'peer-1', addr)).toBe(true)
  expect(loadMappedPeerAddress(db, 'peer-1', { isPeerTrusted: () => true })).toBe(addr)
  forgetPeerAddress(db, 'peer-1')
  expect(loadMappedPeerAddress(db, 'peer-1', { isPeerTrusted: () => true })).toBe(null)
  db.close()
})
