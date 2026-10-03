import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { openLocalDb } from '../db/localDb.js'
import { ensureHostSigningKey } from '../auth/localAuth.js'
import { ensureDeviceIdentity } from '../auth/deviceIdentity.js'
import { setUserDataDirGetter, resetForTests, getCurrentDoc } from '../sync/automerge/liveDoc.js'
import { readRecord, listRecordIds } from './campDocument.js'
import { verifyAuthorityEntry } from './authorityLogSignature.js'
import { mintGenesisEntry, mintGrantEntry, mintRevokeEntry } from './authorityLog.js'

let db
let userDataDir
const files = []

beforeEach(() => {
  userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'shoresh-authoritylog-'))
  setUserDataDirGetter(() => userDataDir)
  const file = path.join(os.tmpdir(), `shoresh-authoritylog-db-${Date.now()}-${Math.random()}.sqlite`)
  files.push(file)
  db = openLocalDb(file)
  db.prepare('INSERT INTO camps (id, name) VALUES (?, ?)').run('camp-1', 'Camp One')
  const hostKey = ensureHostSigningKey(db)
  db.prepare('UPDATE camps SET signing_public_key = ? WHERE id = ?').run(hostKey.public_key, 'camp-1')
  for (const id of ['founder-1', 'signer-1', 'device-2']) {
    db.prepare("INSERT INTO devices (id, name, pairing_status) VALUES (?, ?, 'authorized')").run(id, id)
  }
})

afterEach(() => {
  resetForTests()
  fs.rmSync(userDataDir, { recursive: true, force: true })
  for (const f of files.splice(0)) {
    for (const suffix of ['', '-wal', '-shm']) {
      if (fs.existsSync(f + suffix)) fs.unlinkSync(f + suffix)
    }
  }
})

describe('mintGenesisEntry', () => {
  it('writes an unsigned genesis entry naming the founder device and peer id', () => {
    const entryId = mintGenesisEntry(db, { founderDeviceId: 'founder-1', founderPeerId: 'peer-founder' })
    const doc = getCurrentDoc(db)
    const row = readRecord(doc, 'camp_authority_log', entryId)
    expect(row.kind).toBe('genesis')
    expect(row.target_device_id).toBe('founder-1')
    expect(row.target_peer_id).toBe('peer-founder')
    expect(row.signature).toBeUndefined()
  })
})

describe('mintGrantEntry / mintRevokeEntry', () => {
  it('writes a grant entry whose signature verifies against the signer\'s real peer id', async () => {
    const { peerId: signerPeerId } = await ensureDeviceIdentity(db)
    const entryId = mintGrantEntry(db, { targetDeviceId: 'device-2', targetPeerId: 'peer-2', signerDeviceId: 'signer-1' })
    const doc = getCurrentDoc(db)
    const row = readRecord(doc, 'camp_authority_log', entryId)
    expect(row.kind).toBe('grant')
    expect(row.target_device_id).toBe('device-2')
    expect(row.target_peer_id).toBe('peer-2')
    expect(row.signer_device_id).toBe('signer-1')
    expect(
      verifyAuthorityEntry(signerPeerId, { id: entryId, kind: row.kind, target_device_id: row.target_device_id, signer_device_id: row.signer_device_id }, row.signature)
    ).toBe(true)
  })

  it('writes a revoke entry, distinct id from the grant, both present in the collection', async () => {
    await ensureDeviceIdentity(db)
    const grantId = mintGrantEntry(db, { targetDeviceId: 'device-2', targetPeerId: 'peer-2', signerDeviceId: 'signer-1' })
    const revokeId = mintRevokeEntry(db, { targetDeviceId: 'device-2', signerDeviceId: 'signer-1' })
    expect(revokeId).not.toBe(grantId)
    const doc = getCurrentDoc(db)
    const ids = listRecordIds(doc, 'camp_authority_log')
    expect(ids.sort()).toEqual([grantId, revokeId].sort())
    const row = readRecord(doc, 'camp_authority_log', revokeId)
    expect(row.kind).toBe('revoke')
    expect(row.target_peer_id).toBeUndefined() // revoke never carries a target_peer_id
  })
})
