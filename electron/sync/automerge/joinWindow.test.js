// @vitest-environment node
//
// The director's Add-a-device window (docs/adr/2026-09-08-libp2p-join-flow.md
// §2). This is a CONSENT boundary, not the security boundary — the join-code
// proof is what separates a real joining device from a peer that mirrored the
// public mDNS tag. What this gate is for is narrower and worth testing on its
// own: a Host that nobody is standing at must not put pairing prompts on a
// director's screen.
import { describe, it, expect, afterEach, beforeEach } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import * as A from '@automerge/automerge'
import { openLocalDb } from '../../db/localDb.js'
import { createEmptyDoc } from '../../automerge/campDocument.js'
import { seedAllFromSqlite } from '../../automerge/seed.js'
import { ensureHostSigningKey } from '../../auth/localAuth.js'
import { startSyncNode } from './syncNode.js'
import { startJoinSession } from './joinSession.js'
import { joinCode } from '../joinCode.js'

const CAMP_ID = 'camp-window-test'
const CODE = joinCode(CAMP_ID)

let files = []
function freshDb(tag) {
  const f = path.join(os.tmpdir(), `shoresh-window-${tag}-${Date.now()}-${Math.random()}.sqlite`)
  files.push(f)
  return openLocalDb(f)
}

let hostDb, joinerDb, nodes, sessions
beforeEach(() => {
  hostDb = freshDb('host')
  joinerDb = freshDb('joiner')
  hostDb.prepare('INSERT INTO camps (id, name) VALUES (?, ?)').run(CAMP_ID, 'Camp Window')
  ensureHostSigningKey(hostDb)
  nodes = []
  sessions = []
  clock = 1_000_000
})
afterEach(async () => {
  await Promise.all(sessions.map((s) => s.stop().catch(() => {})))
  await Promise.all(nodes.map((n) => n.stop().catch(() => {})))
  for (const db of [hostDb, joinerDb]) {
    try { db.close() } catch { /* already closed */ }
  }
  for (const f of files) if (fs.existsSync(f)) fs.unlinkSync(f)
  files = []
})

// `now` is injectable so a test can step past authGate's PAIRING_RATE_MS
// throttle deterministically, exactly as authGate.test.js does — a retry after
// the director opens the window is a real, expected second request, and it
// must not be confused with the flood the throttle exists to stop.
let clock = 1_000_000
async function hostWithWindow(open, onPairingRequest) {
  const host = await startSyncNode({
    deviceId: 'host-device',
    db: hostDb,
    doc: seedAllFromSqlite(hostDb, A.clone(createEmptyDoc())),
    onPairingRequest,
    isJoinWindowOpen: () => open(),
    now: () => clock,
  })
  nodes.push(host)
  return host
}

async function joinerFor(host, { code = CODE } = {}) {
  const { session } = await startJoinSession({
    db: joinerDb, deviceId: 'joiner-device', deviceName: 'New iPad', code,
    knownHost: host.getMultiaddrs()[0],
  })
  sessions.push(session)
  await session.findHost()
  return session
}

describe('the Add-a-device window', () => {
  it('turns a first-join request away while it is closed, without troubling the director', async () => {
    let prompted = false
    const host = await hostWithWindow(() => false, () => { prompted = true })
    const session = await joinerFor(host)
    expect((await session.requestPairing()).status).toBe('denied')
    expect(prompted).toBe(false)
  })

  it('lets the same request through once the director opens it', async () => {
    let open = false
    let prompted = null
    const host = await hostWithWindow(() => open, (_id, name) => { prompted = name })
    const session = await joinerFor(host)
    expect((await session.requestPairing()).status).toBe('denied')

    open = true
    clock += 10_000 // past PAIRING_RATE_MS; this is a retry, not a flood
    expect((await session.requestPairing()).status).toBe('pending')
    expect(prompted).toBe('New iPad')
  })

  // The gate must not touch the path every already-paired device uses on every
  // launch — those requests carry no join nonce and never had a code.
  it('does not apply to an already-paired device reconnecting', async () => {
    let prompted = false
    const host = await hostWithWindow(() => false, () => { prompted = true })
    const joiner = await startSyncNode({
      deviceId: 'returning-device',
      db: joinerDb,
      doc: A.clone(createEmptyDoc()),
    })
    nodes.push(joiner)
    await joiner.dial(host.getMultiaddrs()[0])

    const reply = await joiner.authenticateWith(host.peerId, {
      type: 'pairing_request',
      device_id: 'returning-device',
      device_name: 'Returning',
    })
    expect(reply.type).toBe('pairing_pending')
    expect(prompted).toBe(true)
  })

  // Fail-open at the module level is deliberate: a caller with no such window
  // (every other test, and the WS-era embedding) must get today's behavior.
  it('is absent by default rather than closed by default', async () => {
    const host = await startSyncNode({
      deviceId: 'host-device',
      db: hostDb,
      doc: seedAllFromSqlite(hostDb, A.clone(createEmptyDoc())),
      onPairingRequest: () => {},
    })
    nodes.push(host)
    const session = await joinerFor(host)
    expect((await session.requestPairing()).status).toBe('pending')
  })
})
