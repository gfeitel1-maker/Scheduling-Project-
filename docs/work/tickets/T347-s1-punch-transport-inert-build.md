---
ticket: T347
document_type: ticket
title: S1 — punch transport (node-datachannel as a libp2p transport), inert build behind SHORESH_PUNCH_ENABLED
status: open
created: 2026-10-08
archive_when: "electron/sync/automerge/punchTransport.js exists as a libp2p transport over a node-datachannel data channel with Noise, authGate/T331 mutualAuth, isPeerRevoked and Automerge sync proven unchanged over it; native misuse is proven unable to abort the process; syncStarter.js wires it only when SHORESH_PUNCH_ENABLED is the literal string 'true' and the native module loads; the build is green with node-datachannel present and punch.signoff null"
task_class: security-auth
parent: ""
governing_docs: [docs/adr/2026-10-08-relayless-cross-network-reconnect.md, docs/governance/standards/TESTING_STANDARD.md, SECURITY.md]
related_prs: []
related_tickets: []
---

# T347 — S1: punch transport, inert build

## Context

First slice of the relay-less cross-network reconnect
(`docs/adr/2026-10-08-relayless-cross-network-reconnect.md`, "Mechanism decision", "Integration
ruling", "Hazards"). The ICE data channel is a libp2p transport, not a side channel, so admission is
not re-implemented. Nothing activates in this slice.

## What S1 builds

- `node-datachannel@0.33.4` (exact). The darwin-x64 prebuilt loads under Node.
- `electron/sync/automerge/punchTransport.js` — a libp2p transport factory injected into
  `startTransport` as `punchTransportFactory`, exactly like `relayTransportFactory`
  (`transport.js` never imports it). The opened data channel is a `MultiaddrConnection` handed to
  libp2p's upgrader. Signaling is an injected `{ sendSignal, onSignal }`; no real channel exists yet.
  Options: stable DTLS cert (`certificatePemFile`/`keyPemFile`), fixed `ice.iceUfrag`/`icePwd`,
  pinned `portRange`, `disableAutoNegotiation` (always on), explicit `role`, STUN servers only
  (`turn:` is rejected at configuration time, relay candidates are rejected on receipt).
- Native safety: every input is validated before any node-datachannel call; a per-session phase
  machine makes out-of-order native calls unreachable; every teardown calls `pc.close()` and, once
  nothing is live, the module `cleanup()`; `main.js` `will-quit` calls `syncStarter.shutdownPunch()`.
- Gate: `syncStarter.js` wires the factory only when `process.env.SHORESH_PUNCH_ENABLED === 'true'`,
  `node-datachannel` actually loads (`punchEnablement.js`), and a signaling channel was injected.
- Registry: `transportCapabilities.js` gains a `punch` row (`packages: ['node-datachannel']`,
  `signoff: null`, `inertPresence: true`). `punchPresenceWithoutSignoff.guard.test.js` is what makes
  the presence tolerable: sole importer, strict single gate, sole namers of the package, exact pin.

## Findings the build depends on (probed on 0.33.4, darwin-x64)

- `pc.close()` alone does not let the process exit; the process hangs until `cleanup()`-class
  teardown runs. (The quit test shows `close()` on every pc plus waiting for `closed` was sufficient
  on this platform; `cleanup()` is still run because the ADR requires it and other platforms are
  unproven.)
- `cleanup()` in the same tick as `close()` segfaults (exit 139). Teardown therefore waits for each
  pc's `closed` state, hops one `setImmediate`, then calls `cleanup()`. `cleanup()` runs only when the
  last transport stops.
- `setLocalDescription('offer')` with no data channel aborts the process (SIGABRT); a test control
  proves the harness sees this.
- Same-host ICE works over the LAN host candidate, so S1's loopback tests need no STUN.

## Follow-ups (not built)

- utilityProcess isolation of node-datachannel (crash containment) — decide with Security/Red Hat.
- Real signaling (rung 2 camp-peer, rung 3 Worker), per-peer signaling keyed by peer, address book
  integration, rung-1 no-re-signal reuse of cert/ufrag/port.
- S5: T327 capability signoff; MUST-VERIFY from the ADR — cross-NAT/symmetric NAT, IPv6, ASAR
  packaging (`asarUnpack` of the `.node`), non-darwin-x64 prebuilts under the Electron ABI.
- The `will-quit` handler in `main.js` is `async` and Electron does not await it; the punch shutdown
  is started before the awaited node stop so its synchronous part closes every pc immediately.
- The egress text scan cannot see STUN contact made inside the native library; the capability row's
  signoff is the control.

## Known limits carried to later slices (round 2 review; not fixed in S1)

- Quit under real Electron is unproven: `will-quit` is async and Electron does not await it, so
  `cleanup()` may not run on a packaged quit. Needs a packaged-quit test before S5.
- `validateSdp` is regex-deep (no `m=` count, `a=setup`, fingerprint algorithm/format checks); a
  malformed-but-passing SDP reaches `setRemoteDescription`. Schedule a child-process SDP-mutation fuzz
  and the utilityProcess isolation before S5 enables the transport.
- Candidates: any host/srflx/prflx UDP address is accepted (loopback, link-local, private), and the
  32-candidate pre-answer queue drops the overflow. Real signaling MUST be authenticated before this
  module consumes candidates.
- `acceptAnswer` sets `phase = 'established'` before the native `setRemoteDescription`; a throw there
  leaves a half-state until the connect timeout and the answer cannot be retried.
- `listen('/ip4/0.0.0.0/udp/0')` is advertised verbatim by `getAddrs`; it is not dialable. S2 must
  resolve the bound port.
- Capability check = native module loads AND a signaling channel was injected; it does not consult
  `punch.signoff` (the registry is build-time only). Confirm with Security. Nothing injects signaling
  yet, so the wired branch is covered only by the inertness tests.
- `createPunchSessionForTest` and the `ndc` option are test seams on the production module.
- Status stays `open` until the Governor-run full `npm run verify` is green on a quiet machine (the
  earlier run was INCONCLUSIVE: `transportConnectionDos.test.js` timed out at load 19.56).

Fixed in round 2: listener cap now counts only pending (pre-open) inbound sessions; an offer whose sid
is already in `sessions` is dropped; the guard proves the import sits inside the gate block and that
`inertPresence` is declared on exactly the `punch` row.

## Evidence: guard non-vacuity (planted defects, captured red, restored)

Round-3 fix pass. Each defect was planted in the real file, the guard run, then the file restored.

1. Hoist the import: `await import('./punchTransport.js')` added above the gate in
   `electron/sync/automerge/syncStarter.js`.
```
 × the punchTransport.js import in syncStarter.js sits inside the punchRuntimeEligible gate block
AssertionError: expected false to be true // Object.is equality
 Tests  1 failed | 11 passed (12)
```
2. `inertPresence: true` added to a second registry row (`websockets`) in `transportCapabilities.js`.
```
 × inertPresence is declared on exactly the punch row (no other row may loosen the package scan)
AssertionError: expected [ 'punch', 'websockets' ] to deeply equal [ 'punch' ]
 Tests  1 failed | 11 passed (12)
```

## Round-3 changes

- `will-quit` now vetoes the first event, awaits teardown (bounded 5s), then `app.quit()`
  (`electron/willQuit.js`, tested in `electron/willQuit.test.js`). The "quit under real Electron is
  unproven" limit above is closed in unit scope; a packaged-quit run is still owed before S5.
- `syncStarter.js` no longer calls `punchNativeLoadable()` unless the flag is exactly `'true'` and
  signaling is injected (`punchProbeShortCircuit.test.js`; red-first: the flag-off case failed with
  "expected vi.fn() to not be called at all, but actually been called 1 times").
- `punchTransport.native.test.js`: the 775ms figure was the observed elapsed time, not a bound; the
  bound at HEAD was 15000ms and is load-sensitive, so it is now 45000ms (assertion kept).

## Remaining

- Governor-run full `npm run verify` and review loop (Security, Red Hat) on the transport.
