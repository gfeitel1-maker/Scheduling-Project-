// T335 gate finding (Security/Red Hat HIGH, round 2) — red-before-green at the WIRED layer, not
// just the pure functions. Before the fix, syncStarter.js called
// `rotatingServiceTag(Automerge, doc, campId)` with no opts, so the production mDNS tag was
// computed over UNVERIFIED revoke entries (currentRevokedDeviceIds's always-true default) — an
// attacker-controlled synced peer could inject a bare, unsigned `kind: 'revoke'` entry and move
// the live discovery tag network-wide, reopening the T329-F1 forgery class. `computeRotatingServiceTag`
// is the exact function syncStarter.js's start() now calls to build the mDNS peerDiscovery
// serviceTag; this test exercises IT directly, with real signed/unsigned document entries, rather
// than the pure digest functions in isolation (those already have their own coverage).
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { openLocalDb } from '../../db/localDb.js'
import { ensureHostSigningKey } from '../../auth/localAuth.js'
import { ensureDeviceIdentity } from '../../auth/deviceIdentity.js'
import { setUserDataDirGetter, resetForTests, getCurrentDoc, setCurrentDoc } from './liveDoc.js'
import { mintGenesisEntry, mintGrantEntry, mintRevokeEntry } from '../../automerge/authorityLog.js'
import { applyWrite } from '../../automerge/campDocument.js'
import { mintRendezvousNamespace, readRendezvousNamespace } from './rendezvousNamespace.js'
import { computeRotatingServiceTag, prepareDocForSync } from './syncStarter.js'

const CAMP_ID = 'camp-1'

let db
let userDataDir
const files = []

beforeEach(() => {
  userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'shoresh-syncstarter-tag-'))
  setUserDataDirGetter(() => userDataDir)
  const file = path.join(os.tmpdir(), `shoresh-syncstarter-tag-db-${Date.now()}-${Math.random()}.sqlite`)
  files.push(file)
  db = openLocalDb(file)
  db.prepare('INSERT INTO camps (id, name) VALUES (?, ?)').run(CAMP_ID, 'Camp One')
  const hostKey = ensureHostSigningKey(db)
  db.prepare('UPDATE camps SET signing_public_key = ? WHERE id = ?').run(hostKey.public_key, CAMP_ID)
  for (const id of ['founder-1', 'signer-1']) {
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

// Persists the mint back into db's liveDoc registry (not just a local variable) so a later
// db-driven write (mintGrantEntry/mintRevokeEntry, which operate through appendOp against db's OWN
// tracked doc) advances the SAME document the dhtSecret was minted into, rather than silently
// diverging from it.
function mintDhtSecret(db) {
  const { doc: minted } = mintRendezvousNamespace(getCurrentDoc(db), CAMP_ID)
  setCurrentDoc(db, minted)
  return minted
}

describe('computeRotatingServiceTag — the production wiring, with the real verified-entry gate', () => {
  it('a bare, unsigned revoke entry injected directly into the document does NOT move the production tag', async () => {
    const { peerId: founderPeerId } = await ensureDeviceIdentity(db)
    mintGenesisEntry(db, { founderDeviceId: 'founder-1', founderPeerId })
    let doc = mintDhtSecret(db)
    const before = computeRotatingServiceTag(doc, CAMP_ID)

    // Attacker-controlled synced peer injects a bare, unsigned revoke directly into the document
    // fields — never through authorityLog.js's signing path. This is exactly what a malicious
    // remote merge could deliver. Target is a device DISTINCT from the signer (never itself
    // granted admin) — authorityReplay.js's stateAt always ignores a self-targeted entry
    // (signer === target), so the target must differ for this to actually exercise the trust
    // gate rather than being filtered out for an unrelated reason.
    doc = applyWrite(doc, { entity: 'camp_authority_log', entity_id: 'forged-1', field: 'kind', value: 'revoke' })
    doc = applyWrite(doc, { entity: 'camp_authority_log', entity_id: 'forged-1', field: 'target_device_id', value: 'signer-1' })
    doc = applyWrite(doc, { entity: 'camp_authority_log', entity_id: 'forged-1', field: 'signer_device_id', value: 'founder-1' })
    const after = computeRotatingServiceTag(doc, CAMP_ID)

    expect(after).toBe(before) // the forged, unsigned revoke never moved the production tag
  })

  it('a genuinely signed revoke (quorum-reaching) DOES move the production tag', async () => {
    const { peerId: founderPeerId } = await ensureDeviceIdentity(db)
    mintGenesisEntry(db, { founderDeviceId: 'founder-1', founderPeerId })
    mintGrantEntry(db, { targetDeviceId: 'signer-1', targetPeerId: 'peer-signer-1', signerDeviceId: 'founder-1' })
    let doc = mintDhtSecret(db)
    const before = computeRotatingServiceTag(doc, CAMP_ID)

    // N=2 (founder-1, signer-1): quorumThreshold(2) = 1, so the founder's lone signed revoke
    // completes the removal.
    mintRevokeEntry(db, { targetDeviceId: 'signer-1', signerDeviceId: 'founder-1' })
    doc = getCurrentDoc(db)
    const after = computeRotatingServiceTag(doc, CAMP_ID)

    expect(after).not.toBe(before)
  })
})

describe('prepareDocForSync — WAN-ladder F1 round 2: a revoke the device missed is rotated on doc load', () => {
  it('a revoke already in the persisted doc, never rotated for, is rotated when the elected device loads it', async () => {
    const { peerId: founderPeerId } = await ensureDeviceIdentity(db)
    mintGenesisEntry(db, { founderDeviceId: 'founder-1', founderPeerId })
    mintGrantEntry(db, { targetDeviceId: 'signer-1', targetPeerId: 'peer-signer-1', signerDeviceId: 'founder-1' })
    mintDhtSecret(db)
    mintRevokeEntry(db, { targetDeviceId: 'signer-1', signerDeviceId: 'founder-1' })
    const loaded = getCurrentDoc(db)
    expect(readRendezvousNamespace(loaded, CAMP_ID).epoch).toBe(1)

    const prepared = prepareDocForSync(db, loaded, { campId: CAMP_ID, deviceId: 'founder-1' })

    expect(readRendezvousNamespace(prepared, CAMP_ID).epoch).toBe(2)
    expect(readRendezvousNamespace(getCurrentDoc(db), CAMP_ID).epoch).toBe(2)
  })
})
