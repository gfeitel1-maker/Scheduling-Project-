// @vitest-environment node
// docs/adr/2026-10-12-shared-signed-device-roster.md section 1: upsertDeviceRosterEntity builds a MONOTONIC,
// device-local roster_cache from host-signed document entries. Real signatures, real projection.
import Database from 'better-sqlite3'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { initSchema } from '../db/localDb.js'
import { ensureHostSigningKey } from '../auth/localAuth.js'
import { createEmptyDoc, applyWrite, listRecordIds } from './campDocument.js'
import { DELETE_FIELD } from '../ops/operations.js'
import { projectAll, MODELED_ORDER, upsertDeviceRosterEntity } from './projector.js'
import { buildRosterWrites } from './deviceRoster.js'
import { signRosterEntry } from './deviceRosterSignature.js'
import { signGenesisEntry } from './genesisSignature.js'

const files = []
afterEach(() => {
  for (const f of files.splice(0)) for (const s of ['', '-wal', '-shm']) if (fs.existsSync(f + s)) fs.unlinkSync(f + s)
})
function newDb(tag) {
  const file = path.join(os.tmpdir(), `shoresh-roster-proj-${tag}-${Date.now()}-${Math.random()}.sqlite`)
  files.push(file)
  const db = new Database(file)
  initSchema(db)
  return db
}

// host: signs. peer: a device that only verifies (holds the camp row with the host's public key).
function setup() {
  const host = newDb('host')
  const key = ensureHostSigningKey(host)
  host.prepare('INSERT INTO camps (id, name, signing_public_key) VALUES (?, ?, ?)').run('camp-1', 'Camp', key.public_key)
  const peer = newDb('peer')
  peer.prepare('INSERT INTO camps (id, name, signing_public_key) VALUES (?, ?, ?)').run('camp-1', 'Camp', key.public_key)
  return { host, peer, key }
}
function write(doc, writes) {
  let d = doc
  for (const w of writes) d = applyWrite(d, w)
  return d
}
const cache = (db) => db.prepare('SELECT device_id, peer_id FROM roster_cache ORDER BY device_id').all()

describe('upsertDeviceRosterEntity', () => {
  it('admits a host-signed entry', () => {
    const { host, peer } = setup()
    const doc = write(createEmptyDoc(), buildRosterWrites(host, { deviceId: 'dev-a', peerId: 'peerA' }))
    upsertDeviceRosterEntity(peer, doc)
    expect(cache(peer)).toEqual([{ device_id: 'dev-a', peer_id: 'peerA' }])
  })

  it('buildRosterWrites is idempotent for a device already cached with that peer id, and null on a non-host', () => {
    const { host, peer } = setup()
    const doc = write(createEmptyDoc(), buildRosterWrites(host, { deviceId: 'dev-a', peerId: 'peerA' }))
    upsertDeviceRosterEntity(host, doc)
    expect(buildRosterWrites(host, { deviceId: 'dev-a', peerId: 'peerA' })).toBeNull()
    expect(buildRosterWrites(peer, { deviceId: 'dev-b', peerId: 'peerB' })).toBeNull()
  })

  const forgeries = {
    'unsigned entry': (host, w) => w.filter((x) => x.field !== 'sig'),
    'peer id edited after signing': (host, w) => w.map((x) => (x.field === 'device_peer_id' ? { ...x, value: 'peerEvil' } : x)),
    'signed by a different key': () => {
      const other = newDb('other')
      ensureHostSigningKey(other)
      other.prepare('INSERT INTO camps (id, name) VALUES (?, ?)').run('camp-1', 'Camp')
      return buildRosterWrites(other, { deviceId: 'dev-a', peerId: 'peerA' })
    },
    'copied under another record id': (host, w) => w.map((x) => ({ ...x, entity_id: 'dev-other' })),
    'signed for another camp': (host) => {
      host.prepare('UPDATE camps SET id = ?').run('camp-2')
      const w = buildRosterWrites(host, { deviceId: 'dev-a', peerId: 'peerA' })
      host.prepare('UPDATE camps SET id = ?').run('camp-1')
      return w
    },
  }
  it.each(Object.keys(forgeries))('skips a forged entry: %s', (name) => {
    const { host, peer } = setup()
    const good = buildRosterWrites(host, { deviceId: 'dev-a', peerId: 'peerA' })
    const doc = write(createEmptyDoc(), forgeries[name](host, good))
    upsertDeviceRosterEntity(peer, doc)
    expect(cache(peer)).toEqual([])
  })

  it('adds nothing when the camp row has no signing_public_key', () => {
    const { host, peer } = setup()
    peer.prepare('UPDATE camps SET signing_public_key = NULL').run()
    const doc = write(createEmptyDoc(), buildRosterWrites(host, { deviceId: 'dev-a', peerId: 'peerA' }))
    upsertDeviceRosterEntity(peer, doc)
    expect(cache(peer)).toEqual([])
  })

  it('K1: two valid entries sharing a peer id never throw and pick the same winner in either write order', () => {
    const { host, peer } = setup()
    const wa = buildRosterWrites(host, { deviceId: 'dev-a', peerId: 'shared' })
    const wb = buildRosterWrites(host, { deviceId: 'dev-b', peerId: 'shared' })
    const peer2 = newDb('peer2')
    peer2.prepare('INSERT INTO camps (id, name, signing_public_key) VALUES (?, ?, ?)').run('camp-1', 'Camp', peer.prepare('SELECT signing_public_key k FROM camps').get().k)
    expect(() => upsertDeviceRosterEntity(peer, write(createEmptyDoc(), [...wa, ...wb]))).not.toThrow()
    expect(() => upsertDeviceRosterEntity(peer2, write(createEmptyDoc(), [...wb, ...wa]))).not.toThrow()
    expect(cache(peer)).toEqual([{ device_id: 'dev-a', peer_id: 'shared' }])
    expect(cache(peer2)).toEqual(cache(peer))
  })

  it('F2/F3: the cache is monotonic. A document writer overwriting or deleting a verified entry removes nothing', () => {
    const { host, peer } = setup()
    let doc = write(createEmptyDoc(), [
      ...buildRosterWrites(host, { deviceId: 'dev-a', peerId: 'peerA' }),
      ...buildRosterWrites(host, { deviceId: 'dev-b', peerId: 'peerB' }),
    ])
    upsertDeviceRosterEntity(peer, doc)
    expect(cache(peer)).toHaveLength(2)
    doc = applyWrite(doc, { entity: 'device_roster', entity_id: 'dev-a', field: 'device_peer_id', value: 'peerEvil' })
    doc = applyWrite(doc, { entity: 'device_roster', entity_id: 'dev-b', field: DELETE_FIELD, value: null })
    expect(listRecordIds(doc, 'device_roster')).toEqual(['dev-a'])
    upsertDeviceRosterEntity(peer, doc)
    expect(cache(peer)).toEqual([{ device_id: 'dev-a', peer_id: 'peerA' }, { device_id: 'dev-b', peer_id: 'peerB' }])
  })

  it('G2: a device whose peer id belongs to a revoked device is dropped even when the revoked entry exists only in the document', () => {
    const { host, peer } = setup()
    const doc = write(createEmptyDoc(), [
      ...buildRosterWrites(host, { deviceId: 'dev-old', peerId: 'peerOld' }),
      ...buildRosterWrites(host, { deviceId: 'dev-new', peerId: 'peerOld' }),
      ...buildRosterWrites(host, { deviceId: 'dev-ok', peerId: 'peerOk' }),
    ])
    peer.prepare("INSERT INTO authority_cache (device_id, status, updated_at) VALUES ('dev-old', 'revoked', 'x')").run()
    expect(cache(peer)).toEqual([])
    upsertDeviceRosterEntity(peer, doc)
    expect(cache(peer).map((r) => r.device_id)).toEqual(['dev-ok'])
    expect(peer.prepare('SELECT 1 FROM roster_cache WHERE peer_id = ?').get('peerOld')).toBeUndefined()
  })

  it('K2: roster projection runs after authority-log projection, and a revoke is honoured whichever order the writes were made', () => {
    expect(MODELED_ORDER.indexOf('device_roster')).toBeGreaterThan(MODELED_ORDER.indexOf('camp_authority_log'))
    const { host } = setup()
    const writes = buildRosterWrites(host, { deviceId: 'dev-a', peerId: 'peerA' })
    const hostKey = host.prepare('SELECT public_key FROM host_signing_key').get().public_key
    const mk = (tag) => {
      const db = newDb(tag)
      db.prepare('INSERT INTO camps (id, name, signing_public_key) VALUES (?, ?, ?)').run('camp-1', 'Camp', hostKey)
      return db
    }
    const p1 = mk('p1')
    const p2 = mk('p2')
    const revokeFirst = write(write(createEmptyDoc(), Object.entries({ kind: 'genesis', target_device_id: 'dev-a', target_peer_id: 'peerA', signature: signGenesisEntry(host, { id: 'e1', camp_id: 'camp-1', target_device_id: 'dev-a', target_peer_id: 'peerA' }) }).map(([field, value]) => ({ entity: 'camp_authority_log', entity_id: 'e1', field, value }))), writes)
    projectAll(p1, revokeFirst)
    projectAll(p2, write(createEmptyDoc(), writes))
    expect(cache(p1)).toEqual(cache(p2))
  })

  it('a stolen signature cannot be replayed to register a different peer id', () => {
    const { host, peer } = setup()
    const sig = signRosterEntry(host, { id: 'dev-a', camp_id: 'camp-1', device_id: 'dev-a', device_peer_id: 'peerA', added_at: 't' })
    const doc = write(createEmptyDoc(), [
      { entity: 'device_roster', entity_id: 'dev-a', field: 'device_id', value: 'dev-a' },
      { entity: 'device_roster', entity_id: 'dev-a', field: 'device_peer_id', value: 'peerThief' },
      { entity: 'device_roster', entity_id: 'dev-a', field: 'added_at', value: 't' },
      { entity: 'device_roster', entity_id: 'dev-a', field: 'sig', value: sig },
    ])
    upsertDeviceRosterEntity(peer, doc)
    expect(cache(peer)).toEqual([])
  })
})
