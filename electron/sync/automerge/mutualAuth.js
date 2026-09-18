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
// T208 (docs/work/tickets/T208-discovery-seam-has-no-local-trust-filter.md).
// `isPeerTrusted(peerId) -> boolean` is REQUIRED, and its absence throws here
// rather than defaulting to anything. Before T208 this function sent
// { type:'authenticate', token, device_id } to ANY peer surfaced by
// onPeerDiscovery, with no check that the peer was a device this camp knows.
// On the LAN that is bounded by mDNS link-local multicast, which is why it
// survived review; the moment a second discovery mechanism exists that anyone
// on the internet can write into (the rendezvous program,
// docs/work/specs/2026-09-17-rendezvous-wan-connectivity.md), the bound is
// gone and this node hands a bearer credential to whoever published a record.
//
// It is required rather than defaulted because the two possible defaults are
// both wrong: defaulting to permit silently reopens the hole for any caller
// that forgets, and defaulting to deny turns a wiring mistake into total
// silent sync failure — the failure shape this module's header calls the worst
// one. Throwing makes a missing decision loud, immediate, and impossible to
// ship.
//
// LIMIT, stated because the guarantee is otherwise easy to over-read: what
// this closes is "we send our token to a stranger". It does NOT make the token
// unusable if it reaches one — that is token-to-peer binding, T162.
export function wireMutualAuth(syncNodeHandle, { deviceId, getToken, isPeerTrusted, onRejected, attemptTimeoutMs = 30_000 } = {}) {
  if (typeof isPeerTrusted !== 'function') {
    throw new TypeError(
      'wireMutualAuth requires an isPeerTrusted(peerId) predicate: this seam decides who receives ' +
      'this device\'s session token, and every discovery mechanism feeds it. See ' +
      'docs/work/tickets/T208-discovery-seam-has-no-local-trust-filter.md.'
    )
  }
  // Tracks peer ids already dialed so a peer that keeps re-announcing over
  // mDNS (the normal, periodic behavior) doesn't get re-dialed every time.
  // Cleared for a given peer on failure, so a transient dial/auth failure
  // gets a fresh attempt on the next discovery event rather than being
  // stuck forever.
  const attempted = new Set()

  async function tryAuthenticate(peerId) {
    if (attempted.has(peerId)) return

    // Checked on EVERY discovery, never cached: local trust is a live,
    // eventually-consistent value (a device can be revoked between two mDNS
    // announces), so a cached verdict would keep a revoked peer admitted at
    // this seam until restart. A predicate that throws is treated as "not
    // trusted" — a db fault is not permission, and failing open here would
    // reintroduce the exact defect the predicate exists to close.
    let trusted = false
    try {
      trusted = isPeerTrusted(peerId) === true
    } catch (err) {
      console.error(`mutualAuth: trust check for ${peerId} failed, treating as untrusted: ${err?.message ?? err}`)
      trusted = false
    }
    if (!trusted) return

    attempted.add(peerId)

    // A peer that accepts the connection and then never replies would otherwise
    // hold this dedupe slot forever: `attempted` is cleared on dial failure and
    // on an explicit rejection, but a hang is neither, so the real peer's later
    // legitimate announce is dropped by the `attempted.has` guard above. That is
    // a reconnection DoS requiring no forged signature. Bound it.
    const stall = setTimeout(() => {
      if (attempted.delete(peerId)) {
        console.error(`mutualAuth: attempt against ${peerId} stalled past ${attemptTimeoutMs}ms; releasing it so a later discovery can retry`)
      }
    }, attemptTimeoutMs)
    stall.unref?.()
    const release = () => clearTimeout(stall)

    const token = typeof getToken === 'function' ? getToken() : null
    if (!token) {
      // Not logged in / no self-issued token yet — nothing to prove
      // ourselves with. Not a failure: allow a future discovery event (or
      // an explicit re-run once a token exists) to retry.
      release()
      attempted.delete(peerId)
      return
    }

    // A libp2p connection is BIDIRECTIONAL: once either side has dialed, both ends can open streams
    // on it. So if this peer is already connected — because IT dialed US — we must not try to dial
    // back, and a failure to dial back must not stop us authenticating.
    //
    // Found on a real Mac<->Windows run (Stage 5f): the Windows machine's Wi-Fi was classified as a
    // Public network, so its firewall dropped all unsolicited inbound traffic — it could dial out
    // but never accept. It dialed the Mac fine; the Mac's dial back timed out; and because this
    // function returned early on that failure, the Mac never authenticated over the perfectly good
    // connection Windows had already opened. Result: nothing synced, in either direction, across a
    // working link. Exactly one reachable direction is sufficient and must be enough — that is also
    // what makes this robust on the guest/hotel networks a camp actually runs on.
    const alreadyConnected = () =>
      (syncNodeHandle.getPeers?.() ?? []).some((p) => String(p) === String(peerId))

    // Did we reuse a connection getPeers() claimed to have? If that claim turns
    // out to be stale, the authenticate below fails and we redial once — see the
    // catch block. Tracked here because only this branch knows we skipped a dial.
    let reusedExistingConnection = alreadyConnected()

    if (!reusedExistingConnection) {
      try {
        await syncNodeHandle.dial(peerId)
      } catch (err) {
        if (!alreadyConnected()) {
          release()
          attempted.delete(peerId)
          console.error(`mutualAuth: dial to ${peerId} failed and no existing connection to reuse (will retry on next discovery): ${err?.message ?? err}`)
          return
        }
        console.warn(`mutualAuth: dial to ${peerId} failed, but an inbound connection exists — authenticating over that instead: ${err?.message ?? err}`)
      }
    }

    try {
      let reply
      try {
        reply = await syncNodeHandle.authenticateWith(peerId, { type: 'authenticate', token, device_id: deviceId })
      } catch (err) {
        // T162 made a device's PeerId STABLE across restarts. That closed a real
        // hole, and opened this one: when a Host restarts, it comes back under
        // the SAME PeerId, so a peer that still lists the now-dead connection
        // reuses it and authenticates into a closed stream. Before T162 a
        // restart always produced a fresh PeerId, so getPeers() could not name
        // a dead connection and this path did not exist.
        //
        // The failure is recoverable either way — the catch below clears
        // `attempted` and the next discovery retries — but that costs a whole
        // announce interval on every Host restart, which is the common case
        // (someone closed the laptop). Redial once instead, and only when we
        // actually skipped the dial: if we already dialled, a failure here is a
        // real one and must not be retried into.
        if (!reusedExistingConnection) throw err
        reusedExistingConnection = false
        console.warn(`mutualAuth: authenticate to ${peerId} failed over a connection getPeers() still listed; redialling once: ${err?.message ?? err}`)
        await syncNodeHandle.dial(peerId)
        reply = await syncNodeHandle.authenticateWith(peerId, { type: 'authenticate', token, device_id: deviceId })
      }
      release()
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
      release()
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
