/**
 * Scenario 7: Mid-pairing reconnect loop.
 *
 * Covers the case where a Client sends pairing_request, the Host WS server
 * restarts (or the connection drops) before approval arrives, and the Client
 * re-sends pairing_request on reconnect.  The Host's idempotent pairing path
 * handles the re-send and the Client ultimately gets pairing_approved.
 *
 * Sub-cases:
 *   7a – normal approval after reconnect
 *   7b – denial after reconnect (pairing_denied handler reached)
 *   7c – already-paired device reconnects and authenticates (not re-paired)
 */

import { Host, Client, getFreePort, makeTmpDir, cleanupDirs, pairAndLogin } from '../harness.js'
import { openLocalDb } from '../../../electron/db/localDb.js'
import { startSyncServer } from '../../../electron/sync/syncServer.js'

// Helper: restart a killed Host on the same port, re-wiring the pairing callbacks.
async function restartHost(host, port) {
  host.db = openLocalDb(host.dbPath)
  host.server = startSyncServer(host.db, {
    port,
    onPairingRequest: (dId, dName) => {
      const waiter = host._pairingWaiters.shift()
      if (waiter) waiter({ deviceId: dId, deviceName: dName })
      else host._pairingQueue.push({ deviceId: dId, deviceName: dName })
    },
  })
}

// ---------------------------------------------------------------------------
// 7a: Client reconnects mid-pairing, Host approves, Client logs in
// ---------------------------------------------------------------------------
async function scenario7a(tmpDir) {
  const port = await getFreePort()
  const host = new Host(`${tmpDir}/7a-host.db`)
  await host.start(port)
  await host.bootstrap()

  const client = new Client(`${tmpDir}/7a-client.db`)
  client.open()

  // Step 1: connect — sends pairing_request; Host receives it (pending state).
  const connectPromise = client.connect(host.serverUrl)
  const { deviceId } = await host.waitForPairingRequest()
  await connectPromise

  const rowBefore = host.db.prepare('SELECT pairing_status FROM devices WHERE id = ?').get(deviceId)
  if (!rowBefore || rowBefore.pairing_status !== 'pending') {
    throw new Error(`Expected pending device row, got: ${JSON.stringify(rowBefore)}`)
  }

  // Step 2: Host WS server is killed (simulates process restart).
  host.kill()
  await new Promise(r => setTimeout(r, 100))

  // Step 3: Host restarts on the same port.
  await restartHost(host, port)

  // Step 4: Client reconnects and re-sends pairing_request.
  // reconnect() creates a new syncClient with no token → open handler sends
  // pairing_request (same device_id) exactly as on the initial connect.
  const reconnectPromise = client.reconnect()
  const { deviceId: deviceId2 } = await host.waitForPairingRequest()
  await reconnectPromise

  if (deviceId2 !== deviceId) {
    throw new Error(`Expected same device_id ${deviceId} on reconnect, got ${deviceId2}`)
  }

  // Step 5: Host approves — sends pairing_approved.
  const approvedPromise = client.waitForPairingApproved()
  const secret = host.approveDevice(deviceId)
  await approvedPromise

  // Step 6: Client logs in.
  const loginResult = await client.loginRemote('admin', '1234')
  if (loginResult.status !== 'ok') {
    throw new Error(`Expected login ok, got ${JSON.stringify(loginResult)}`)
  }

  // Verify device_secret_identifier was stored on the client.
  const clientRow = client.db.prepare('SELECT device_secret_identifier FROM devices WHERE id = ?').get(deviceId)
  if (!clientRow || clientRow.device_secret_identifier !== secret) {
    throw new Error('Client did not store device_secret_identifier correctly')
  }

  client.close()
  host.close()
}

// ---------------------------------------------------------------------------
// 7b: Device denied while Host was down — pairing_denied arrives on reconnect
// ---------------------------------------------------------------------------
async function scenario7b(tmpDir) {
  const port = await getFreePort()
  const host = new Host(`${tmpDir}/7b-host.db`)
  await host.start(port)
  await host.bootstrap()

  const client = new Client(`${tmpDir}/7b-client.db`)
  client.open()

  // Step 1: connect — sends pairing_request.
  const connectPromise = client.connect(host.serverUrl)
  const { deviceId } = await host.waitForPairingRequest()
  await connectPromise

  // Step 2: Host is killed while the request is still pending.
  host.kill()
  await new Promise(r => setTimeout(r, 100))

  // Step 3: Host restarts.
  await restartHost(host, port)

  // Step 4: Client reconnects and re-sends pairing_request.
  const reconnectPromise = client.reconnect()
  await host.waitForPairingRequest()  // consume the re-queued request
  await reconnectPromise

  // Step 5: Admin denies — pairing_denied reaches the client's existing handler.
  const deniedPromise = new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('timeout waiting for pairing_denied')), 6000)
    client.syncClient.onPairingDenied(() => { clearTimeout(timer); resolve() })
  })
  host.server.sendPairingDenied(deviceId)
  await deniedPromise

  client.close()
  host.close()
}

// ---------------------------------------------------------------------------
// 7c: Already-paired device disconnects and reconnects — sends authenticate,
//     NOT pairing_request (regression guard on the normal reconnect path).
// ---------------------------------------------------------------------------
async function scenario7c(tmpDir) {
  const port = await getFreePort()
  const host = new Host(`${tmpDir}/7c-host.db`)
  await host.start(port)
  await host.bootstrap()

  const client = new Client(`${tmpDir}/7c-client.db`)
  client.open()
  await pairAndLogin(host, client)

  // Clear any already-queued pairing state so the assertion below is clean.
  host._pairingQueue = []
  host._pairingWaiters = []

  // Disconnect and reconnect.  Because client.token is set, the open handler
  // sends authenticate — not pairing_request.
  client.disconnect()
  await new Promise(r => setTimeout(r, 150))
  await client.reconnect()
  await new Promise(r => setTimeout(r, 200))

  // No pairing_request should have arrived at the host.
  if (host._pairingQueue.length > 0) {
    throw new Error(
      'Already-paired device triggered a pairing_request on reconnect — regression detected'
    )
  }

  // Confirm the client is still functional after reconnect.
  const writeResult = await client.write({
    entity: 'camps',
    entity_id: host.campId,
    field: 'name',
    value: 'Reconnected',
  })
  if (writeResult.status !== 'applied') {
    throw new Error(`Expected applied write after reconnect, got ${JSON.stringify(writeResult)}`)
  }

  client.close()
  host.close()
}

// ---------------------------------------------------------------------------
// Main export
// ---------------------------------------------------------------------------
export async function run() {
  const dirs = []
  const tmpDir = makeTmpDir(); dirs.push(tmpDir)

  try {
    await scenario7a(tmpDir)
    await scenario7b(tmpDir)
    await scenario7c(tmpDir)
    return 'PASS'
  } finally {
    cleanupDirs(dirs)
  }
}
