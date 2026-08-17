// @vitest-environment node
//
// T87 (docs/adr/2026-08-16-client-reauth-on-restart.md): the load-bearing
// regression test for the ADR's Test strategy item 1.
//
// Exercises the REAL electron/main.js `makeHandlers`/`chooseMode` path
// against a REAL syncServer + syncClient over a real WebSocket connection —
// NOT the integration harness's `Client` class, whose `reconnect()`
// (test/integration/harness.js) already passes `token: this.token ||
// undefined` and therefore already does the correct thing the production
// `chooseMode` omitted. That gap is exactly why T85's own suite never caught
// this defect (see the ADR's Context, "Why the integration suite didn't
// catch it").
//
// Only the `electron` module itself is mocked here (main.js imports
// app/BrowserWindow/ipcMain/contextBridge at module scope, none of which
// exist outside a real Electron process) — syncServer.js and syncClient.js
// are the REAL implementations, unlike electron/main.test.js which mocks
// both. This file uses the integration harness's `Host` class (real
// syncServer + real SQLite) for Host-side setup only.

import { describe, it, expect, vi } from 'vitest'
import { randomUUID } from 'node:crypto'
import os from 'node:os'

vi.mock('electron', () => ({
  app: {
    getPath: vi.fn(() => os.tmpdir()),
    whenReady: vi.fn(() => Promise.resolve()),
    on: vi.fn(),
  },
  BrowserWindow: vi.fn(),
  ipcMain: { handle: vi.fn() },
  contextBridge: { exposeInMainWorld: vi.fn() },
  ipcRenderer: { invoke: vi.fn(), on: vi.fn() },
}))

const { makeHandlers } = await import('./main.js')
const { createSyncClient } = await import('./sync/syncClient.js')
const { openLocalDb, getOrCreateDeviceId } = await import('./db/localDb.js')
const { Host, getFreePort, makeTmpDir, cleanupDirs, waitFor } = await import('../test/integration/harness.js')

describe('T87: a returning Client re-authenticates after a simulated process restart', () => {
  it('reaches an authenticated, live-broadcast-receiving connection through the real chooseMode/verifySession path', async () => {
    const dirs = []
    let host, clientDb1, clientDb2
    try {
      const tmpDir = makeTmpDir(); dirs.push(tmpDir)
      const port = await getFreePort()

      host = new Host(`${tmpDir}/host.db`)
      await host.start(port)
      await host.bootstrap()

      const clientDbPath = `${tmpDir}/client.db`

      // --- Phase 1: first-ever app start on this device, through the real
      // electron/main.js chooseMode/login/loginRemote flow. -----------------
      clientDb1 = openLocalDb(clientDbPath)
      const clientDeviceId = getOrCreateDeviceId(clientDb1)
      const handlers1 = makeHandlers(clientDb1, clientDeviceId, {})

      const pairingRequestPromise = host.waitForPairingRequest()
      await handlers1.chooseMode({ mode: 'client', host: '127.0.0.1', port })
      const { deviceId: pairedDeviceId } = await pairingRequestPromise
      expect(pairedDeviceId).toBe(clientDeviceId)

      const approvedPromise = new Promise((resolve) => {
        handlers1.getSyncClient().onPairingApproved(resolve)
      })
      host.approveDevice(clientDeviceId)
      await approvedPromise

      // handleAuthenticate fires the first-pairing full_sync fire-and-forget
      // (syncServer.js) — camps.signing_public_key and the users row this
      // device needs for its OWN local verifySession check to work land via
      // that snapshot, not the login response itself. Register the listener
      // before login() sends `authenticate`, so it cannot be missed.
      const fullSyncAppliedPromise = new Promise((resolve) => {
        handlers1.getSyncClient().onFullSyncApplied(resolve)
      })

      const loginResult = await handlers1.login({ name: 'admin', pin: '1234' })
      expect(loginResult?.token).toBeTruthy()
      // The renderer's localStorage('shoresh-token') equivalent.
      const storedToken = loginResult.token

      await fullSyncAppliedPromise

      // Simulate the Electron process exiting: close this "process"'s
      // syncClient (its WS connection) and its db handle.
      handlers1.getSyncClient().close()
      clientDb1.close()
      await new Promise((r) => setTimeout(r, 150))

      // --- Phase 2: simulated Electron process restart against the SAME
      // on-disk Client db, driven through the corrected startup sequence a
      // fixed useDeviceMode.js uses (Parts 1/2 of the ADR): verifySession
      // first, then chooseMode with the verified token. --------------------
      clientDb2 = openLocalDb(clientDbPath)
      const clientDeviceId2 = getOrCreateDeviceId(clientDb2)
      expect(clientDeviceId2).toBe(clientDeviceId)
      const handlers2 = makeHandlers(clientDb2, clientDeviceId2, {})

      const verifyResult = handlers2.verifySession({ token: storedToken })
      expect(verifyResult.valid).toBe(true)

      await handlers2.chooseMode({ mode: 'client', host: '127.0.0.1', port, token: storedToken })

      function findAuthenticatedWs() {
        for (const ws of host.server.wss.clients) {
          if (ws.deviceId === clientDeviceId && ws.readyState === ws.OPEN) return ws
        }
        return null
      }

      await waitFor(() => handlers2.getSyncClient().isConnected(), 6000, 40)
      // Give the Host's event loop a moment to process the `authenticate`
      // frame (or absence of one) before asserting ws.deviceId — mirrors
      // pairAndLogin's own settle wait in harness.js.
      await new Promise((r) => setTimeout(r, 300))

      // THE FAIL-FIRST ASSERTION: pre-fix, chooseMode has no `token`
      // parameter, so this connection never sends `authenticate` and
      // ws.deviceId is never set on the Host side — exactly the ticket's
      // traced defect. Post-fix, it is set.
      const authenticatedWs = findAuthenticatedWs()
      expect(authenticatedWs).not.toBeNull()
      expect(handlers2.getSyncClient().isAuthenticated()).toBe(true)

      // Prove it is not merely a flag: a live Host-authored op (the exact
      // mechanism T85's fix depends on — see this ADR's "Why this matters
      // for T85") actually reaches this restarted, now-authenticated
      // connection.
      const localWriter = createSyncClient(host.db, {
        device_id: host.deviceId, author_user_id: host.adminUserId, wss: host.server.wss,
      })
      const opEntityId = randomUUID()
      const writeResult = await localWriter.write({ entity: 'activities', entity_id: opEntityId, field: 'name', value: 'PostRestartLive' })
      expect(writeResult.status).toBe('applied')

      await waitFor(
        () => clientDb2.prepare('SELECT 1 FROM operations WHERE entity_id = ?').get(opEntityId),
        8000, 40
      )
      expect(clientDb2.prepare('SELECT 1 FROM operations WHERE entity_id = ?').get(opEntityId)).toBeTruthy()
    } finally {
      try { host?.close() } catch { /* ignore */ }
      try { clientDb1?.close() } catch { /* ignore */ }
      try { clientDb2?.close() } catch { /* ignore */ }
      cleanupDirs(dirs)
    }
  }, 20000)
})
