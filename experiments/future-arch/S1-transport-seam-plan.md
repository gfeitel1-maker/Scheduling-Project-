# S1 — Transport seam: migration plan

**Goal:** route all sync messages through one small `Transport` interface, so the sync
logic stops depending on the WebSocket object directly. Behavior-preserving; each slice
independently testable and reversible. Per the accepted ADR
`docs/adr/2026-08-17-shared-project-multi-transport-sync.md`.

## Done — slice 1 (this branch)
- `electron/sync/transport/transport.js` — the contract (5 members: `id`, `start`, `stop`,
  `send`, `onMessage`, `onStatus`) + `assertIsTransport`.
- `electron/sync/transport/inMemoryTransport.js` — reference loopback implementation with
  store-and-forward (models offline→reconnect).
- `electron/sync/transport/transport.contract.test.js` — the behavioural spec every
  transport must pass. **10/10 green.** Lint clean.
- **Nothing in the running app imports these yet** — the live sync path is untouched.

## Why this seam shape
The earlier code audit found the split cleanly: the **operation algebra** (`electron/ops/*`)
is already transport-neutral, but the **delivery protocol** — message framing, delivery
acks/watermarks, reconnect, resolver correlation — is welded to the `ws` object (handlers
take `(db, wss, ws, msg)`; ack resolvers are stashed on the ws object). The seam abstracts
only the **message channel**. Acks/watermarks stay ABOVE it (they are sync-protocol logic,
and — per the ADR's field test — must never trust a transport's own delivery claim anyway).

## Done — slice 2 (this branch, verified 2026-08-17)
- `electron/sync/transport/webSocketClientTransport.js` — implements the contract by wrapping
  `ws`. **Reconnect lives inside the transport** (injectable timer, no bare sleep); acks/
  watermarks confirmed to stay above the seam; framing reproduces syncClient's existing guard.
  Documented deviation: a live socket has no store-and-forward, so `send()` while disconnected
  rejects (doesn't queue).
- `electron/sync/transport/webSocketClientTransport.contract.test.js` — same battery against a
  real `ws` server on an ephemeral port. **12/12.** Combined transport suite **22/22**, lint 0,
  app files (`syncClient`/`syncServer`/`main`) untouched — independently re-verified by main loop.
- Design note: `experiments/future-arch/S1.2-websocket-adapter-design.md`.
- **Carry-forward risks (from the Architect):**
  1. `noBareSleeps.test.js` scans `electron/sync/*.test.js` **non-recursively** — it does NOT
     cover `electron/sync/transport/*.test.js`. Small follow-up: extend the guard's scope.
  2. S1.3's server-side `meta.peerId` shape is inferred, not verified against syncServer's
     per-connection bookkeeping — re-check before building.
  3. No test yet exercises the transport's own reconnect-under-drop — add during S1.4.

## Done — slice 3 (this branch, verified 2026-08-17)
- `electron/sync/transport/webSocketServerListener.js` — a **listener** (not itself a Transport)
  handing out one per-peer Transport per client via `onConnection(peerChannel, peerId)` /
  `onDisconnection(peerId)`. Model A keeps the single-peer contract invariant (existing three
  transports + tests untouched). `peerId` = opaque listener counter, NOT `deviceId` (learned late).
- Bug caught test-first: Node `server.close()` leaves open sockets, so `stop()` hung — fixed by
  tracking + closing live sockets first.
- `webSocketServerListener.contract.test.js` — 9 tests incl. multi-peer (broadcast reaches both,
  targeted reaches one). **Combined suite 69/69, lint 0, app files untouched** (re-verified).
- Design note: `experiments/future-arch/S1.3-server-transport-design.md`.
- **Carry-forward for S1.5:** broadcast today filters `wss.clients` by `client.deviceId` truthy +
  `readyState === OPEN`; the listener has no "authenticated" concept, so the syncServer rewire must
  keep that filtering at the caller level.

## Next slices — the live-path rewires (each its OWN full review loop: Architect→Maker→Verifier→Red Hat/Security/Code Reviewer)
- **S1.4 — Migrate syncClient onto the injected transport.** Replace direct `ws.send`/
  `ws.on('message')` with `transport.send`/`transport.onMessage`; keep the ack/resolver
  layer, but key it on message content (op id) instead of stashing on the ws object — a
  latent improvement this seam enables (see T85 notes). Characterization tests first.
- **S1.5 — Migrate syncServer onto the injected transport.** Same treatment for the Host.

## Guardrails (from repo memory)
- ESM + vitest `// @vitest-environment node`; run focused files with
  `npx vitest run <file> --no-file-parallelism` (full suite is ~11 min and flakes without it).
- No `setTimeout`/bare sleeps in `electron/sync/**` (noBareSleeps guard) — use `queueMicrotask`.
- After touching `electron/db/**` rebuild better-sqlite3; the transport code touches no db, so N/A here.
- The deep migration (S1.4/S1.5 rewire the ~2,700 lines of syncClient/syncServer) is
  architecturally significant and safety-critical — it should go through the
  Architect → Maker → Verifier → review loop, not a cowboy edit. Slice 1 was the safe,
  additive foundation; the rewire is where the discipline matters most.

## Status
S1 slice 1 complete and green on `claude/shoresh-future-architecture-364e03`. Not merged to
`main`. The seam is ready for the WebSocket adapter (S1.2) whenever the owner greenlights
continuing.
