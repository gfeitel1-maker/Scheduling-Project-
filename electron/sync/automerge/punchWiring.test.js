// @vitest-environment node
//
// T348 Rung 1 wiring: the production path (syncStarter -> punchTransport -> syncNode admission)
// persists the punch identity and the remembered session. Nothing is stored at Noise-upgrade time;
// a remembered session is committed only when authGate admits the peer.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { createAutomergeSyncStarter } from './syncStarter.js'
import { setUserDataDirGetter, setDocCipher, resetForTests } from './liveDoc.js'
import { openTemplatedDb, cleanupTemplatedDbs } from '../../db/testDbTemplate.js'
import { getOrCreateDeviceId } from '../../db/localDb.js'
import { makeSignalingPair } from './punchTestSupport.js'

let db, dbFile, deviceId, userDataPath, originalFlag

beforeEach(() => {
  const templated = openTemplatedDb()
  db = templated.db
  dbFile = templated.file
  deviceId = getOrCreateDeviceId(db)
  userDataPath = fs.mkdtempSync(path.join(os.tmpdir(), 'shoresh-punch-wiring-'))
  resetForTests()
  setUserDataDirGetter(() => userDataPath)
  setDocCipher(null)
  originalFlag = process.env.SHORESH_PUNCH_ENABLED
  process.env.SHORESH_PUNCH_ENABLED = 'true'
  db.prepare('INSERT INTO camps (id, name, signing_secret) VALUES (?, ?, ?)').run(randomUUID(), 'Camp Test', 'a'.repeat(64))
})
afterEach(() => {
  if (originalFlag === undefined) delete process.env.SHORESH_PUNCH_ENABLED
  else process.env.SHORESH_PUNCH_ENABLED = originalFlag
  vi.useRealTimers()
  resetForTests()
  db.close()
  if (fs.existsSync(dbFile)) fs.unlinkSync(dbFile)
  fs.rmSync(userDataPath, { recursive: true, force: true })
  cleanupTemplatedDbs()
})

const noop = Object.assign(() => {}, { error() {}, trace() {}, newScope: () => noop })
const SDP = 'v=0\r\ns=-\r\nt=0 0\r\na=ice-ufrag:abcd\r\na=ice-pwd:' + 'x'.repeat(24) + '\r\na=fingerprint:sha-256 AA:BB:CC\r\nm=application 9 UDP/DTLS/SCTP webrtc-datachannel\r\n'
const snapshot = (peerId = 'peer-1') => ({
  peerId,
  role: 'offerer',
  remoteSdpType: 'answer',
  remoteSdp: SDP,
  candidates: [{ candidate: 'candidate:1 1 UDP 1686052607 203.0.113.9 50001 typ srflx', mid: '0' }],
  localCandidates: ['candidate:2 1 UDP 1686052607 198.51.100.7 40000 typ srflx'],
})

async function start() {
  const startSyncNode = vi.fn(async () => ({ broadcastLocalDoc() {}, onPeersChanged() {}, setAuthToken() {}, stop: async () => {} }))
  const [signaling] = makeSignalingPair()
  const starter = createAutomergeSyncStarter({
    deviceId, db, userDataPath, docCipher: null,
    getMainWindow: () => null, getLiveHandlers: () => null,
    startSyncNodeImpl: async () => startSyncNode,
    punchSignaling: signaling,
  })
  await starter.start()
  const args = startSyncNode.mock.calls[0][0]
  const transport = args.punchTransportFactory({ logger: { forComponent: () => noop } })
  return { args, starter, opts: transport.opts }
}

const memoryRows = () => db.prepare('SELECT * FROM peer_punch_memory').all()

describe('punch persistence wiring', () => {
  it('materializes the stored identity at transport start: cert/key files, pinned ICE and port', async () => {
    const { opts, starter } = await start()
    const id = db.prepare('SELECT * FROM punch_identity WHERE id = 1').get()
    expect(fs.readFileSync(opts.certificatePemFile, 'utf8')).toBe(id.cert_pem)
    expect(opts.ice).toEqual({ iceUfrag: id.ice_ufrag, icePwd: id.ice_pwd })
    expect(opts.portRange).toEqual({ begin: id.local_port, end: id.local_port })
    await starter.shutdownPunch()
    expect(fs.existsSync(opts.certificatePemFile)).toBe(false)
  })

  it('nothing is remembered at upgrade time - only once authGate admits the peer', async () => {
    const { opts, args, starter } = await start()
    opts.onEstablished(snapshot())
    expect(memoryRows()).toHaveLength(0)
    args.onPunchPeerAdmitted('peer-1')
    const rows = memoryRows()
    expect(rows).toHaveLength(1)
    expect(rows[0].peer_id).toBe('peer-1')
    expect(JSON.parse(rows[0].candidates)).toHaveLength(1)
    expect(JSON.parse(db.prepare('SELECT reflexive_candidates c FROM punch_identity').get().c)).toEqual(snapshot().localCandidates)
    await starter.shutdownPunch()
  })

  it('a peer admitted over some other transport (no pending punch session) stores nothing', async () => {
    const { args, starter } = await start()
    args.onPunchPeerAdmitted('peer-1')
    expect(memoryRows()).toHaveLength(0)
    await starter.shutdownPunch()
  })

  it('a punch session that was never admitted cannot be committed later by an unrelated admission', async () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    const { opts, args, starter } = await start()
    opts.onEstablished(snapshot())
    vi.setSystemTime(Date.now() + 10 * 60 * 1000)
    args.onPunchPeerAdmitted('peer-1')
    expect(memoryRows()).toHaveLength(0)
    await starter.shutdownPunch()
  })
})
