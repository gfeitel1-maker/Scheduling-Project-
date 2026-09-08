/**
 * Scenario 5 (libp2p): a revoked device is refused, and stays refused.
 *
 * The WS original asserted a specific close code (4404) on the socket. That
 * assertion was about the TRANSPORT's way of saying no. Under libp2p there is
 * no socket to close and no code to read, so the property is asserted where it
 * actually lives: **admission**. A revoked device may not be admitted to
 * exchange documents, and — the part that matters for a camp — a device that
 * was already syncing must stop being admitted the moment it is revoked,
 * because `evaluateAuthenticate` re-reads `devices` on every attempt rather
 * than trusting a decision it made earlier.
 *
 * Retiring the close-code assertion is a deliberate substitution, not a
 * loosening: 4404 is still produced by `evaluateAuthenticate` and still
 * asserted by its own unit tests; what cannot be carried across is the socket
 * that used to carry it.
 */
import { AmHost, AmClient, makeTmpDir, cleanupDirs } from '../harnessAutomerge.js'

export async function run() {
  const dirs = []
  let host, client

  try {
    const tmpDir = makeTmpDir(); dirs.push(tmpDir)

    host = new AmHost(`${tmpDir}/host.db`)
    await host.start()
    await host.bootstrap()

    client = new AmClient(`${tmpDir}/client.db`)
    client.open()
    await client.join(host)

    if (!host.admits(client.node.peerId)) {
      throw new Error('a freshly joined device should be admitted')
    }

    // The director revokes it.
    host.revokeDevice(client.deviceId)

    // How a refusal LOOKS on libp2p, and why the assertion is shaped this way:
    // authGate aborts the stream on a failed decision, so the caller sees a
    // rejected promise ("stream reset") rather than a polite reply. Both a
    // throw and a non-ok reply are the same answer — refused — so accept
    // either and assert on the outcome instead of the mechanism.
    const attempt = async (frame) => {
      try {
        return await client.node.authenticateWith(host.node.peerId, frame)
      } catch {
        return { type: 'refused' }
      }
    }

    // A revoked device presenting its still-valid token must be refused. The
    // token has not expired and is cryptographically fine — revocation is a
    // separate, freshly-read fact, which is the whole point of re-checking.
    const reply = await attempt({
      type: 'authenticate', token: client.token, device_id: client.deviceId,
    })
    if (reply?.type === 'auth_ok') {
      throw new Error('a revoked device was admitted with its old token')
    }

    // And it cannot get back in by pairing afresh either — revocation is not
    // something a device can clear for itself.
    const pairing = await attempt({
      type: 'pairing_request', device_id: client.deviceId, device_name: 'Revoked Device',
    })
    if (pairing?.type === 'pairing_approved') {
      throw new Error('a revoked device re-paired itself without the director')
    }

    // The property a camp actually depends on: it is no longer admitted, so no
    // document can reach it.
    if (host.admits(client.node.peerId)) {
      throw new Error('a revoked device is still admitted to exchange documents')
    }

    return 'PASS'
  } finally {
    await host?.close()
    await client?.close()
    cleanupDirs(dirs)
  }
}
