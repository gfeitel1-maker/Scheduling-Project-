/**
 * Scenario 5: Device revoked while offline — Host closes socket with 4404.
 *
 * Sequence:
 *   1. Client pairs, logs in, writes a successful op (confirms full auth).
 *   2. Client disconnects (close WS).
 *   3. Host revokes the client's device (sets revoked_at).
 *   4. Client reconnects — sends authenticate with its stored token.
 *   5. Host detects revoked_at → closes socket with code 4404.
 *   6. Assert the client WS received close code 4404.
 */

import { Host, Client, getFreePort, makeTmpDir, cleanupDirs, pairAndLogin } from '../harness.js'

export async function run() {
  const dirs = []
  let host, client

  try {
    const tmpDir = makeTmpDir(); dirs.push(tmpDir)
    const port = await getFreePort()

    host = new Host(`${tmpDir}/host.db`)
    await host.start(port)
    await host.bootstrap()

    client = new Client(`${tmpDir}/client.db`)
    client.open()
    await pairAndLogin(host, client)

    // Step 2: disconnect.
    client.disconnect()
    // Give the WS close time to propagate before the next connect.
    await new Promise(r => setTimeout(r, 150))

    // Step 3: revoke the device on the host.
    host.revokeDevice(client.deviceId)

    // Step 4: reconnect — this will send authenticate with the still-valid
    // token.  The host will detect revoked_at and close with 4404.
    // We capture the close code from the raw WS before syncClient swallows it.
    const WS = (await import('ws')).default
    const closeCode = await new Promise((resolve) => {
      const ws = new WS(`ws://127.0.0.1:${host.port}`)
      ws.on('open', () => {
        ws.send(JSON.stringify({
          type: 'authenticate',
          token: client.token,
          device_id: client.deviceId,
        }))
      })
      ws.on('close', (code) => resolve(code))
      ws.on('error', () => resolve(null))
      // Timeout safety
      setTimeout(() => resolve(null), 5000)
    })

    if (closeCode !== 4404) {
      throw new Error(`Expected close code 4404 (device_revoked), got ${closeCode}`)
    }

    return 'PASS'
  } finally {
    host?.close()
    client?.close()
    cleanupDirs(dirs)
  }
}
