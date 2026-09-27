/**
 * One device's half of the cross-version replication check
 * (crossVersionReplication.manual.mjs). Runs as its own OS process, inside
 * its own checkout's node_modules — that is the whole point: two different
 * installed libp2p majors cannot both be `require`d into one process, so
 * this file is copied (not imported) into each checkout and driven with
 * `node`, once per side. See crossVersionReplication.manual.mjs's header for
 * why this exists and what it is trying to prove.
 *
 * This file must only use APIs present in BOTH the current tree and the
 * pinned old tree's harnessAutomerge.js: AmHost, makeTmpDir, cleanupDirs,
 * waitFor, configureDualWrite. The Client side is NOT built on AmClient,
 * because AmClient.join() calls `host.approveDevice()` directly on the Host's
 * in-process JS object (fine for a same-process scenario; impossible across
 * two OS processes) — this reimplements the same sequence
 * (findHost -> requestPairing -> waitForPairingDecision -> login ->
 * waitForCamp) against a Host that approves autonomously on its own side.
 *
 * Usage: node crossVersionRunner.js <host|client> <handoffPath> <resultPath>
 */
import { randomUUID } from 'node:crypto'
import fs from 'node:fs'
import { multiaddr } from '@multiformats/multiaddr'

import { openLocalDb, getOrCreateDeviceId } from '../../electron/db/localDb.js'
import { startJoinSession } from '../../electron/sync/automerge/joinSession.js'
import { applyWrite } from '../../electron/automerge/campDocument.js'
import { AmHost, makeTmpDir, cleanupDirs, waitFor, configureDualWrite } from './harnessAutomerge.js'

const [, , role, handoffPath, resultPath] = process.argv

const SMALL_VALUE = 'ping'
// js-libp2p's Yamux defaults to a 256 KiB initial window
// (@chainsafe/libp2p-yamux's DEFAULT_INITIAL_WINDOW_SIZE), negotiated IN-BAND
// after protocol selection — the whole reason a connect-only test cannot see
// this class of defect (see this test's header). 2 MiB forces at least one
// window-update round trip well past any plausible default.
const LARGE_VALUE = 'x'.repeat(2 * 1024 * 1024)

function waitForFileText(path, timeoutMs = 30000) {
  const deadline = Date.now() + timeoutMs
  return new Promise((resolve, reject) => {
    function tick() {
      if (fs.existsSync(path)) { resolve(fs.readFileSync(path, 'utf8')); return }
      if (Date.now() > deadline) { reject(new Error(`timeout waiting for ${path}`)); return }
      setTimeout(tick, 100)
    }
    tick()
  })
}

async function runHost() {
  const tmpDir = makeTmpDir()
  configureDualWrite(tmpDir)
  const host = new AmHost(`${tmpDir}/host.db`)
  await host.start()
  const { campId, joinCode } = await host.bootstrap({ campName: 'XVer', adminName: 'admin', adminPin: '1234' })

  const addr = host.node.getMultiaddrs()[0].toString()
  // T286 — the join code is a random Host-minted secret, not derivable from
  // campId (see electron/sync/joinCode.js), so it must be handed across the
  // handoff file exactly like addr/campId rather than recomputed client-side.
  fs.writeFileSync(handoffPath, JSON.stringify({ addr, campId, joinCode }))

  // A real director clicks approve; this automates that click, since the
  // point of this test is the transport underneath, not the UI.
  console.error('[host] awaiting pairing request...')
  const { deviceId } = await host.waitForPairingRequest(30000)
  // The onPairingRequest notification callback fires DURING authGate's
  // handling of the request — before it has finished sending the
  // pairing_pending reply and recording this device's peerId in
  // pendingPairingPeers (see authGate.js). A real director reads a name off
  // a screen and clicks approve, which takes far longer than that; a fully
  // automated approval with zero delay can race ahead of it, which is a
  // property of automating away the human, not of the product. A short
  // pause here is standing in for that human, not working around a
  // real defect.
  await new Promise((r) => setTimeout(r, 200))
  console.error('[host] pairing request from', deviceId, '- approving...')
  await host.approveDevice(deviceId)
  console.error('[host] approved.')

  const smallId = randomUUID()
  await host.write({ entity: 'activities', entity_id: smallId, field: 'name', value: SMALL_VALUE })
  const largeId = randomUUID()
  await host.write({ entity: 'activities', entity_id: largeId, field: 'name', value: LARGE_VALUE })
  fs.writeFileSync(`${handoffPath}.hostIds`, JSON.stringify({ smallId, largeId }))

  const peerSmallId = (await waitForFileText(`${handoffPath}.peerSmallId`)).trim()
  const peerLargeId = (await waitForFileText(`${handoffPath}.peerLargeId`)).trim()
  await waitFor(() => !!host.domainRow('activities', peerSmallId), 30000)
  await waitFor(() => !!host.domainRow('activities', peerLargeId), 30000)
  const peerSmallRow = host.domainRow('activities', peerSmallId)
  const peerLargeRow = host.domainRow('activities', peerLargeId)

  fs.writeFileSync(resultPath, JSON.stringify({
    status: 'ok',
    receivedSmallOk: peerSmallRow?.name === SMALL_VALUE,
    receivedLargeOk: peerLargeRow?.name === LARGE_VALUE && peerLargeRow.name.length === LARGE_VALUE.length,
  }))

  await host.close()
  cleanupDirs([tmpDir])
}

async function runClient() {
  const handoff = JSON.parse(await waitForFileText(handoffPath))
  const tmpDir = makeTmpDir()
  configureDualWrite(tmpDir)

  const db = openLocalDb(`${tmpDir}/client.db`)
  const deviceId = getOrCreateDeviceId(db)
  db.prepare('INSERT OR IGNORE INTO devices (id, name) VALUES (?, ?)').run(deviceId, 'XVerClient')

  const code = handoff.joinCode
  const knownHost = multiaddr(handoff.addr)

  console.error('[client] starting join session, code=', code, 'knownHost=', handoff.addr)
  const started = await startJoinSession({ db, deviceId, deviceName: 'XVerClient', code, knownHost })
  console.error('[client] startJoinSession result:', started.status)
  if (started.status !== 'started') throw new Error(`join refused before it began: ${started.status}`)
  const session = started.session

  console.error('[client] awaiting findHost...')
  const found = await session.findHost()
  console.error('[client] findHost result:', found)
  if (!found) throw new Error('join: no host answered the code')

  console.error('[client] requesting pairing...')
  const pairing = await session.requestPairing()
  console.error('[client] pairing result:', JSON.stringify(pairing))
  let secret = pairing.deviceSecretIdentifier
  if (pairing.status === 'pending') {
    console.error('[client] awaiting pairing decision...')
    const decision = await session.waitForPairingDecision()
    console.error('[client] pairing decision:', JSON.stringify(decision))
    if (decision.status !== 'approved') throw new Error('join: the director denied this device')
    secret = decision.deviceSecretIdentifier
  } else if (pairing.status !== 'approved') {
    throw new Error(`join: pairing returned ${pairing.status}`)
  }

  console.error('[client] logging in...')
  const login = await session.login({ name: 'admin', pin: '1234', deviceSecretIdentifier: secret })
  console.error('[client] login result:', JSON.stringify(login))
  if (login.status !== 'ok') throw new Error(`join: login failed (${JSON.stringify(login)})`)

  console.error('[client] awaiting camp...')
  const camp = await session.waitForCamp()
  console.error('[client] camp:', JSON.stringify(camp))
  if (!camp) throw new Error('join: signed in, but the camp never arrived')

  const node = session.node
  function domainRow(table, id) {
    return db.prepare(`SELECT * FROM ${table} WHERE id = ?`).get(id)
  }
  async function write(args) {
    const newDoc = applyWrite(node.getDoc(), args)
    await node.applyLocal(newDoc)
  }

  const smallId = randomUUID()
  await write({ entity: 'activities', entity_id: smallId, field: 'name', value: SMALL_VALUE })
  const largeId = randomUUID()
  await write({ entity: 'activities', entity_id: largeId, field: 'name', value: LARGE_VALUE })
  fs.writeFileSync(`${handoffPath}.peerSmallId`, smallId)
  fs.writeFileSync(`${handoffPath}.peerLargeId`, largeId)

  const hostIds = JSON.parse(await waitForFileText(`${handoffPath}.hostIds`))
  await waitFor(() => !!domainRow('activities', hostIds.smallId), 30000)
  await waitFor(() => !!domainRow('activities', hostIds.largeId), 30000)
  const hostSmallRow = domainRow('activities', hostIds.smallId)
  const hostLargeRow = domainRow('activities', hostIds.largeId)

  fs.writeFileSync(resultPath, JSON.stringify({
    status: 'ok',
    receivedSmallOk: hostSmallRow?.name === SMALL_VALUE,
    receivedLargeOk: hostLargeRow?.name === LARGE_VALUE && hostLargeRow.name.length === LARGE_VALUE.length,
  }))

  try { await node.stop() } catch { /* ignore */ }
  db.close()
  cleanupDirs([tmpDir])
}

async function main() {
  if (role === 'host') await runHost()
  else if (role === 'client') await runClient()
  else throw new Error(`unknown role ${role}`)
}

main().catch((err) => {
  fs.writeFileSync(resultPath, JSON.stringify({ status: 'error', message: err.message, stack: err.stack }))
  console.error(err)
  process.exit(1)
})
