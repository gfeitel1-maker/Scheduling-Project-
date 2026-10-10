// @vitest-environment node
// Startup hang, 2026-10-10: on an import-sized camp, the rotation check run by
// syncStarter.prepareDocForSync replayed the whole history change by change, several times over,
// so the packaged app never reached "sync node started". The budget here counts applyChanges
// calls, never wall clock: a rotation check must not replay the history at all.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const calls = vi.hoisted(() => ({ applyChanges: 0 }))
vi.mock('@automerge/automerge', async (importOriginal) => {
  const real = await importOriginal()
  return { ...real, applyChanges: (...a) => { calls.applyChanges++; return real.applyChanges(...a) } }
})

const { openLocalDb } = await import('../../db/localDb.js')
const { createEmptyDoc, applyWrites, applyWrite } = await import('../../automerge/campDocument.js')
const { signAuthorityEntry } = await import('../../automerge/authorityLogSignature.js')
const { ensureDeviceIdentity } = await import('../../auth/deviceIdentity.js')
const { mintRendezvousNamespace } = await import('./rendezvousNamespace.js')
const { mintRendezvousAddressKey } = await import('./rendezvousAddressKey.js')
const { checkRendezvousRotation } = await import('./rendezvousRotation.js')

const CAMP = 'camp-1'
let db, file, peerId

beforeEach(async () => {
  file = path.join(os.tmpdir(), `rzv-cost-${Date.now()}-${Math.random()}.sqlite`)
  db = openLocalDb(file)
  db.prepare('INSERT INTO camps (id, name) VALUES (?, ?)').run(CAMP, 'Camp')
  ;({ peerId } = await ensureDeviceIdentity(db))
})
afterEach(() => {
  db.close()
  for (const s of ['', '-wal', '-shm']) if (fs.existsSync(file + s)) fs.unlinkSync(file + s)
})

function entry(doc, fields, signed = true) {
  const id = `entry-${Math.random()}`
  for (const [field, value] of Object.entries(fields)) doc = applyWrite(doc, { entity: 'camp_authority_log', entity_id: id, field, value })
  if (signed) {
    const signature = signAuthorityEntry(db, { id, kind: fields.kind, target_device_id: fields.target_device_id, signer_device_id: fields.signer_device_id })
    doc = applyWrite(doc, { entity: 'camp_authority_log', entity_id: id, field: 'signature', value: signature })
  }
  return doc
}

describe('rotation check cost on an import-sized camp', () => {
  it('applies only authority changes, however long the rest of the history is', () => {
    let doc = createEmptyDoc()
    doc = entry(doc, { kind: 'genesis', target_device_id: 'dev-f', target_peer_id: peerId.toString() }, false)
    for (let i = 0; i < 3000; i++) {
      doc = applyWrites(doc, [{ entity: 'activities', entity_id: `act-${i % 300}`, field: 'name', value: `n${i}` }])
      if (i === 1000) doc = entry(doc, { kind: 'grant', target_device_id: 'dev-a', target_peer_id: peerId.toString(), signer_device_id: 'dev-f' })
      if (i === 2000) doc = entry(doc, { kind: 'revoke', target_device_id: 'dev-a', signer_device_id: 'dev-f' })
    }
    doc = mintRendezvousNamespace(doc, CAMP).doc
    doc = mintRendezvousAddressKey(doc, CAMP).doc

    calls.applyChanges = 0
    const result = checkRendezvousRotation(doc, { campId: CAMP, deviceId: 'dev-f' })
    expect(result.reason).toBe('rotated')
    // The history is read through views at prefix heads, never replayed into a scratch document.
    expect(calls.applyChanges).toBe(0)
  }, 120_000) // building the 3000-change fixture is slow on a loaded runner; the assertion is a call count
})
