// Stage 5d-2b (docs/adr/2026-09-06-libp2p-membership-mapping.md §3):
// production wiring — the piece that was entirely missing before this
// slice. Nothing called `authenticateWith` outside tests, so turning the
// automerge/libp2p flag on yielded total silent sync failure.
//
// The mutual-authentication constraint is load-bearing (5d-1's outbound
// broadcast filter, transport.js's `broadcastDoc`, only sends to a peer that
// has proven membership TO THIS NODE). A node that authenticates outward to
// a peer and stops there sends fine and silently receives nothing — the
// worst failure shape, because nothing on the sending side looks broken.
// `wireMutualAuth` closes this by having EVERY node run the identical
// dial-and-authenticate step against every peer it discovers; two nodes each
// running this against the other is what makes authentication symmetric —
// there is no separate "respond to being authenticated at" step to wire,
// because authGate.js's inbound handler already does that unconditionally.
//
// `syncNodeHandle` is whatever startSyncNode (./syncNode.js) returns — this
// module only touches its public surface (dial/authenticateWith/
// onPeerDiscovery), so it is unit-testable against a small fake handle
// without a real libp2p node or SQLite (see mutualAuth.test.js).
//
// `getToken()` returns this device's own current, valid session token (a
// Host self-issues one; a Client uses whatever it was last handed by a
// successful login/pairing) or null/undefined if none is available yet — in
// which case this device has nothing to authenticate itself WITH and the
// discovered peer is left un-dialed until a later discovery event (mDNS
// re-announces periodically) or an explicit retry.
export function wireMutualAuth(syncNodeHandle, { deviceId, getToken, onRejected } = {}) {
  // Tracks peer ids already dialed so a peer that keeps re-announcing over
  // mDNS (the normal, periodic behavior) doesn't get re-dialed every time.
  // Cleared for a given peer on failure, so a transient dial/auth failure
  // gets a fresh attempt on the next discovery event rather than being
  // stuck forever.
  const attempted = new Set()

  async function tryAuthenticate(peerId) {
    if (attempted.has(peerId)) return
    attempted.add(peerId)

    const token = typeof getToken === 'function' ? getToken() : null
    if (!token) {
      // Not logged in / no self-issued token yet — nothing to prove
      // ourselves with. Not a failure: allow a future discovery event (or
      // an explicit re-run once a token exists) to retry.
      attempted.delete(peerId)
      return
    }

    try {
      await syncNodeHandle.dial(peerId)
    } catch (err) {
      attempted.delete(peerId)
      console.error(`mutualAuth: dial to ${peerId} failed (will retry on next discovery): ${err?.message ?? err}`)
      return
    }

    try {
      const reply = await syncNodeHandle.authenticateWith(peerId, { type: 'authenticate', token, device_id: deviceId })
      if (!reply || reply.type !== 'auth_ok') {
        // Red Hat finding on 5d-1: a legitimately-paired device rejected by
        // the gate must not vanish with only a console.error and nothing
        // else. This IS still a console.error (no structured push-event
        // home exists for a libp2p-layer rejection today — inventing one
        // would be new chrome outside this slice's scope), but it is
        // routed through the injected `onRejected` hook so a caller that
        // DOES have a place to put it (e.g. main.js forwarding onto the
        // same audit log used by evaluateAuthenticate's own deny path) can
        // wire one in without this module needing to know what that home is.
        console.error(`mutualAuth: peer ${peerId} rejected our authenticate: ${JSON.stringify(reply)}`)
        onRejected?.(peerId, reply)
        attempted.delete(peerId)
      }
    } catch (err) {
      attempted.delete(peerId)
      console.error(`mutualAuth: authenticateWith ${peerId} failed (will retry on next discovery): ${err?.message ?? err}`)
    }
  }

  syncNodeHandle.onPeerDiscovery(({ id }) => {
    tryAuthenticate(id).catch((err) => {
      console.error(`mutualAuth: unexpected error authenticating with discovered peer: ${err?.message ?? err}`)
    })
  })

  return { tryAuthenticate }
}
