/**
 * Scenario 7 (libp2p): pairing survives a connection that drops mid-flight.
 *
 * The original's three sub-cases carry over intact, because they are about the
 * PAIRING protocol rather than about WebSockets:
 *
 *   7a — the director approves after the connection dropped and came back
 *   7b — the director denies, and the device is told
 *   7c — an already-paired device reconnects and authenticates rather than
 *        re-pairing from scratch
 *
 * This is a realistic failure, not a contrived one: approval is a human walking
 * to another computer, and a laptop lid closes or a Wi-Fi hop happens in that
 * window all the time. The pairing exchange is deliberately built to survive it
 * — the Host answers `pairing_pending` immediately and closes the stream rather
 * than holding one open for an arbitrarily long human decision, then dials back
 * on a NEW stream when the decision lands.
 */
import { AmHost, AmClient, makeTmpDir, cleanupDirs, waitFor } from '../harnessAutomerge.js'
import { startJoinSession } from '../../../electron/sync/automerge/joinSession.js'
import { joinCode } from '../../../electron/sync/joinCode.js'

export async function run() {
  const dirs = []
  let host, a, b, c

  try {
    const tmpDir = makeTmpDir(); dirs.push(tmpDir)

    host = new AmHost(`${tmpDir}/host.db`)
    await host.start()
    await host.bootstrap()

    // --- 7a: approval arrives after the request's connection is long gone ---
    a = new AmClient(`${tmpDir}/a.db`)
    a.open()
    await a.join(host)
    if (!a.token) throw new Error('7a: a device that paired across a reconnect has no session')
    // The join itself exercises the dial-back: requestPairing gets
    // `pairing_pending` on one stream and the approval arrives later on
    // another. If that were not so, join() would have hung.

    // --- 7b: a denial reaches the device ---
    b = new AmClient(`${tmpDir}/b.db`)
    b.open()
    const denied = await startJoinSession({
      db: b.db,
      deviceId: b.deviceId,
      deviceName: 'Denied Laptop',
      code: joinCode(host.campId),
      knownHost: host.node.getMultiaddrs()[0],
    })
    if (denied.status !== 'started') throw new Error('7b: join refused before it began')
    await denied.session.findHost()
    await denied.session.requestPairing()
    const decision = denied.session.waitForPairingDecision()
    await host.node.sendPairingDenied(b.deviceId)
    const settled = await decision
    if (settled.status !== 'denied') {
      throw new Error(`7b: a denied device was not told; got ${settled.status}`)
    }
    if (b.db.prepare('SELECT id FROM camps LIMIT 1').get()) {
      throw new Error('7b: a denied device ended up with a camp')
    }
    await denied.session.stop()

    // --- 7c: an already-paired device reconnects without re-pairing ---
    c = a
    const before = host.db.prepare('SELECT pairing_status FROM devices WHERE id = ?').get(c.deviceId)
    await c.reconnect(host)
    const after = host.db.prepare('SELECT pairing_status FROM devices WHERE id = ?').get(c.deviceId)
    if (after.pairing_status !== before.pairing_status || after.pairing_status !== 'authorized') {
      throw new Error('7c: reconnecting changed an already-paired device\'s status')
    }

    // And it is syncing again, which is the point of reconnecting at all.
    await host.write({ entity: 'activities', entity_id: 'after-reconnect', field: 'name', value: 'Swim' })
    await waitFor(() => !!c.domainRow('activities', 'after-reconnect'), 8000)
      .catch(() => { throw new Error('7c: a reconnected device is not receiving writes') })

    return 'PASS'
  } finally {
    await host?.close()
    await a?.close()
    await b?.close()
    cleanupDirs(dirs)
  }
}
