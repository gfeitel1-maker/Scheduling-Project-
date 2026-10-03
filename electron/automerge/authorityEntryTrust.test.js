// T335 gate finding (Security/Red Hat HIGH, round 2) — the production discovery wiring was
// computing the rotating tag with NO signature gate at all (rotatingServiceTag had no opts
// param, so currentRevokedDeviceIds fell through to its always-true default), reintroducing the
// T329-F1 forgery class: an attacker-controlled synced peer could inject an unsigned kind:'revoke'
// entry and move the discovery tag network-wide. The fix factors projector.js's REAL
// isEntryTrusted (peer-id resolution + verifyAuthorityEntry) out into this shared, exported
// `createVerifiedEntryTrust`, so both projector.js and the discovery path use the IDENTICAL
// verification — one definition of "trusted", not two that can drift.
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { openLocalDb } from '../db/localDb.js'
import { ensureHostSigningKey } from '../auth/localAuth.js'
import { ensureDeviceIdentity } from '../auth/deviceIdentity.js'
import { setUserDataDirGetter, resetForTests, getCurrentDoc } from '../sync/automerge/liveDoc.js'
import { mintGenesisEntry, mintGrantEntry, mintRevokeEntry } from './authorityLog.js'
import { applyWrite } from './campDocument.js'
import { createVerifiedEntryTrust, currentRevokedDeviceIds } from './authorityReplay.js'

let db
let userDataDir
const files = []

beforeEach(() => {
  userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'shoresh-authoritytrust-'))
  setUserDataDirGetter(() => userDataDir)
  const file = path.join(os.tmpdir(), `shoresh-authoritytrust-db-${Date.now()}-${Math.random()}.sqlite`)
  files.push(file)
  db = openLocalDb(file)
  db.prepare('INSERT INTO camps (id, name) VALUES (?, ?)').run('camp-1', 'Camp One')
  const hostKey = ensureHostSigningKey(db)
  db.prepare('UPDATE camps SET signing_public_key = ? WHERE id = ?').run(hostKey.public_key, 'camp-1')
  for (const id of ['founder-1', 'signer-1', 'attacker-1']) {
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

describe('createVerifiedEntryTrust', () => {
  it('trusts a genuinely signed grant entry', async () => {
    const Automerge = await import('@automerge/automerge')
    const { peerId: founderPeerId } = await ensureDeviceIdentity(db)
    mintGenesisEntry(db, { founderDeviceId: 'founder-1', founderPeerId })
    mintGrantEntry(db, { targetDeviceId: 'signer-1', targetPeerId: 'peer-signer-1', signerDeviceId: 'founder-1' })
    const doc = getCurrentDoc(db)
    const isEntryTrusted = createVerifiedEntryTrust(Automerge, doc)
    const revoked = currentRevokedDeviceIds(Automerge, doc, { founderDeviceId: 'founder-1', isEntryTrusted })
    expect(revoked).toEqual([]) // signer-1 is a trusted, currently-granted admin — not revoked
  })

  it('rejects a bare, unsigned revoke entry written directly against the document (the forgery this ticket closes)', async () => {
    const Automerge = await import('@automerge/automerge')
    await ensureDeviceIdentity(db)
    const founderPeerId = 'founder-peer-1'
    mintGenesisEntry(db, { founderDeviceId: 'founder-1', founderPeerId })
    let doc = getCurrentDoc(db)
    // An attacker-controlled synced peer injects a bare, unsigned revoke entry directly into the
    // document fields (bypassing authorityLog.js's signing path entirely) — exactly what a
    // malicious remote merge could deliver.
    doc = applyWrite(doc, { entity: 'camp_authority_log', entity_id: 'forged-1', field: 'kind', value: 'revoke' })
    doc = applyWrite(doc, { entity: 'camp_authority_log', entity_id: 'forged-1', field: 'target_device_id', value: 'founder-1' })
    doc = applyWrite(doc, { entity: 'camp_authority_log', entity_id: 'forged-1', field: 'signer_device_id', value: 'founder-1' })
    const isEntryTrusted = createVerifiedEntryTrust(Automerge, doc)
    const forgedEntry = { id: 'forged-1', kind: 'revoke', target_device_id: 'founder-1', signer_device_id: 'founder-1' }
    expect(isEntryTrusted(forgedEntry)).toBe(false)
  })

  it('the shared helper, threaded into currentRevokedDeviceIds, rejects the same forged revoke that projector.js already rejects', async () => {
    const Automerge = await import('@automerge/automerge')
    const { peerId: founderPeerId } = await ensureDeviceIdentity(db)
    mintGenesisEntry(db, { founderDeviceId: 'founder-1', founderPeerId })
    let doc = getCurrentDoc(db)
    doc = applyWrite(doc, { entity: 'camp_authority_log', entity_id: 'forged-2', field: 'kind', value: 'revoke' })
    doc = applyWrite(doc, { entity: 'camp_authority_log', entity_id: 'forged-2', field: 'target_device_id', value: 'founder-1' })
    doc = applyWrite(doc, { entity: 'camp_authority_log', entity_id: 'forged-2', field: 'signer_device_id', value: 'founder-1' })
    const isEntryTrusted = createVerifiedEntryTrust(Automerge, doc)
    const revoked = currentRevokedDeviceIds(Automerge, doc, { founderDeviceId: 'founder-1', isEntryTrusted })
    expect(revoked).toEqual([]) // the forged revoke never counted
  })

  it('a genuinely signed revoke (via mintRevokeEntry) DOES move currentRevokedDeviceIds through the shared helper', async () => {
    const Automerge = await import('@automerge/automerge')
    const { peerId: founderPeerId } = await ensureDeviceIdentity(db)
    mintGenesisEntry(db, { founderDeviceId: 'founder-1', founderPeerId })
    mintGrantEntry(db, { targetDeviceId: 'signer-1', targetPeerId: 'peer-signer-1', signerDeviceId: 'founder-1' })
    mintRevokeEntry(db, { targetDeviceId: 'signer-1', signerDeviceId: 'founder-1' })
    const doc = getCurrentDoc(db)
    const isEntryTrusted = createVerifiedEntryTrust(Automerge, doc)
    const revoked = currentRevokedDeviceIds(Automerge, doc, { founderDeviceId: 'founder-1', isEntryTrusted })
    expect(revoked).toEqual(['signer-1'])
  })
})
