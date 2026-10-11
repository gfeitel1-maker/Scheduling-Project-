// @vitest-environment node
//
// T373. Every sync message rides its own short-lived stream (transport.js sendSyncMessage). libp2p allows
// 32 inbound streams per protocol per connection by default, and a stream only stops counting once BOTH
// halves are closed. The sender closes its half; if the receiving handler never closes its own, each
// message leaks a slot, and after ~32 messages on one connection every further one is reset
// (TooManyInboundProtocolStreamsError) while the sender's sync state has already advanced past it, so the
// data is never re-offered. Found as: a host that received a joined device's commit never relayed it.
import { describe, it, expect, afterEach } from 'vitest'
import { startTransport } from './transport.js'

const cleanups = []
afterEach(async () => { await Promise.all(cleanups.splice(0).map((c) => c().catch(() => {}))) })

const alwaysAdmit = () => ({ ok: true })
const auth = { type: 'authenticate', token: 't', device_id: 'x' }

describe('T373 sync streams are released after delivery', () => {
  it('delivers far more than 32 sync messages over one connection', async () => {
    const received = []
    const receiver = await startTransport({
      deviceId: 'receiver', onAuthenticate: alwaysAdmit, inboundConnectionThreshold: 1000,
      onSyncMessageReceived: (bytes) => { received.push(bytes.length) },
    })
    const sender = await startTransport({ deviceId: 'sender', onAuthenticate: alwaysAdmit, inboundConnectionThreshold: 1000 })
    cleanups.push(() => receiver.stop(), () => sender.stop())
    await sender.dial(receiver.getMultiaddrs()[0])
    await sender.authenticateWith(receiver.peerId, auth)
    await receiver.authenticateWith(sender.peerId, auth)

    const N = 80
    const failures = []
    for (let i = 0; i < N; i++) {
      await sender.sendSyncMessage(receiver.peerId, new Uint8Array([i % 256, 1, 2, 3])).catch((e) => failures.push(e.message))
    }
    const deadline = Date.now() + 5000
    while (received.length < N && Date.now() < deadline) await new Promise((r) => setTimeout(r, 25))
    expect({ failures: failures.length, delivered: received.length }).toEqual({ failures: 0, delivered: N })
  })
  it('delivers far more than 32 whole-document sends over one connection', async () => {
    const received = []
    const receiver = await startTransport({
      deviceId: 'receiver', onAuthenticate: alwaysAdmit, inboundConnectionThreshold: 1000,
      onDocReceived: (bytes) => { received.push(bytes.length) },
    })
    const sender = await startTransport({ deviceId: 'sender', onAuthenticate: alwaysAdmit, inboundConnectionThreshold: 1000 })
    cleanups.push(() => receiver.stop(), () => sender.stop())
    await sender.dial(receiver.getMultiaddrs()[0])
    await sender.authenticateWith(receiver.peerId, auth)
    await receiver.authenticateWith(sender.peerId, auth)

    const N = 80
    const failures = []
    for (let i = 0; i < N; i++) {
      await sender.sendDocTo(receiver.peerId, new Uint8Array([i % 256, 1, 2, 3])).catch((e) => failures.push(e.message))
    }
    const deadline = Date.now() + 5000
    while (received.length < N && Date.now() < deadline) await new Promise((r) => setTimeout(r, 25))
    expect({ failures: failures.length, delivered: received.length }).toEqual({ failures: 0, delivered: N })
  })
})
