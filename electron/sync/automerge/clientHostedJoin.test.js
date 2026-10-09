// @vitest-environment node
//
// T351 STOP-rule evidence: a CLIENT-mode device (no host_signing_key row) can take a first-join
// pairing request while its Add-a-device window is open and deliver it to the UI, but the joiner's
// login is answered with a 'local' token (issueTokenForThisDevice falls back to it with no Host
// key), which evaluateAuthenticate refuses for the network. So getJoinCode/setJoinWindow stay
// setup-device-only. This test PINS that limit: when a client device can issue a 'camp' token,
// it fails, and those two gates can then be lifted.
import { describe, it, expect, afterEach } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { randomBytes, randomUUID, scryptSync } from 'node:crypto'
import * as A from '@automerge/automerge'
import { openLocalDb } from '../../db/localDb.js'
import { createEmptyDoc } from '../../automerge/campDocument.js'
import { startSyncNode } from './syncNode.js'
import { startJoinSession } from './joinSession.js'
import { mintJoinSecret } from '../joinCode.js'

const CAMP_ID = 'camp-client-hosts'
const CODE = mintJoinSecret()
let files = []
let nodes = []
let sessions = []
function freshDb(tag) {
  const f = path.join(os.tmpdir(), `shoresh-t351-${tag}-${Date.now()}-${Math.random()}.sqlite`)
  files.push(f)
  return openLocalDb(f)
}
afterEach(async () => {
  await Promise.all(sessions.map((s) => s.stop().catch(() => {})))
  await Promise.all(nodes.map((n) => n.stop().catch(() => {})))
  sessions = []; nodes = []
  for (const f of files) if (fs.existsSync(f)) fs.unlinkSync(f)
  files = []
})

describe('a client-mode device (no host_signing_key) hosting a first join', () => {
  it('delivers the request to the UI, but the joiner is handed a local token the network refuses', async () => {
    const clientDb = freshDb('clienthost')
    const joinerDb = freshDb('joiner')
    clientDb.prepare('INSERT INTO camps (id, name, signing_public_key) VALUES (?, ?, ?)').run(CAMP_ID, 'Camp', 'a'.repeat(64))
    expect(clientDb.prepare('SELECT 1 FROM host_signing_key').get()).toBeUndefined()
    const salt = randomBytes(16).toString('hex')
    clientDb.prepare(
      'INSERT INTO users (id, camp_id, name, pin_hash, pin_salt, role, auth_sig, cred_version) VALUES (?, ?, ?, ?, ?, ?, ?, 1)'
    ).run(randomUUID(), CAMP_ID, 'Director', scryptSync('1234', salt, 64).toString('hex'), salt, 'admin', '')

    let prompted = null
    const host = await startSyncNode({
      deviceId: 'client-host-device',
      db: clientDb,
      doc: A.clone(createEmptyDoc()),
      onPairingRequest: (_id, name) => { prompted = name },
      isJoinWindowOpen: () => true,
      getJoinSecret: () => CODE,
    })
    nodes.push(host)

    const { session } = await startJoinSession({
      db: joinerDb, deviceId: 'joiner-device', deviceName: 'New iPad', code: CODE,
      knownHost: host.getMultiaddrs()[0],
    })
    sessions.push(session)
    await session.findHost()
    expect((await session.requestPairing()).status).toBe('pending')
    expect(prompted).toBe('New iPad')

    const secret = randomBytes(32).toString('hex')
    clientDb.prepare(
      "UPDATE devices SET authorized_at = ?, pairing_status = 'authorized', device_secret_identifier = ? WHERE id = ?"
    ).run(new Date().toISOString(), secret, 'joiner-device')
    expect(await host.sendPairingApproved('joiner-device', secret)).toBe(true)

    const login = await session.login({ name: 'Director', pin: '1234', deviceSecretIdentifier: secret })
    expect(login.status).toBe('ok')
    const payload = JSON.parse(Buffer.from(login.token.split('.')[0], 'base64url').toString('utf8'))
    expect(payload.type).toBe('local')
  }, 30000)
})
