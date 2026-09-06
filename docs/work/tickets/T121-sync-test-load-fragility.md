---
title: "Sync/WS tests fail under concurrent load, making a red gate uninformative"
document_type: ticket
status: in-progress
created: 2026-09-05
task_class: test-infrastructure
archive_when: "a full `npm run verify` passes reliably while another test suite runs concurrently, and no WS/mDNS scenario has flaked for a sustained period"
governing_docs: [docs/governance/standards/ARCHITECTURE_STANDARD.md]
---

# T121 — Sync/WS tests fail under concurrent load

## Symptom

Whenever the machine is busy, `npm run verify` reds in `electron/sync/*` — a **different test each
run**, always a ~20s timeout, `ECONNREFUSED`, or `EADDRINUSE`, **never an assertion failure**.
Observed 2026-09-05 in three distinct places:

- `electron/sync/syncClient.test.js` (several different tests across runs)
- `electron/sync/syncServer.test.js` (several different tests across runs)
- `test/integration/` scenario 14, "corrupt payload rejected transactionally"

Each passes in isolation. On 2026-09-05 the same suite went from 3–7 failures under load to
**4659/4659, 317/317 files, zero WS failures** once the machine was quiet — same code, same tests.

## Why it matters more than a normal flake

**A red gate currently carries almost no information.** Over one session, four separate agents each
hit a red, and each spent significant time proving it was not their code — one misattributed it to
port contention, one to a "concurrent foreign process" that was actually the coordinator's own job,
one nearly to a 500ms debounce timer in unrelated production code. The folklore fix ("it's port
contention, re-run it") is *wrong* and sends people looking in the wrong place. The gate is only
worth running if a red means something.

## What is actually going on (evidence, not theory)

- Ports are **not** exhausted: `netstat -an | grep -c TIME_WAIT` returned 2, against an ephemeral
  range of 49152-65535. The port-contention story is folklore.
- `ps aux` %CPU is a **lifetime average** on macOS and will mislead you — sample a PID directly
  before blaming a daemon.
- The real variable is machine load, and the reason these tests specifically are sensitive is that
  they use **real network machinery**: `electron/sync/discovery.js` uses `bonjour-service` (mDNS),
  and the suites open real WebSocket servers/clients on ephemeral ports. Under load, handshakes and
  mDNS advertisement/discovery miss the 20s vitest timeout.
- Load on a developer machine running several Claude Code sessions, each able to run a ~4,600-test
  suite, routinely reaches 20-80. This is normal usage, not abuse, so "just keep the machine quiet"
  is not an acceptable long-term answer.

## Directions worth considering (not yet decided)

- Fake or inject the clock/timeouts for WS handshakes so the assertions do not race wall-clock.
- Stub mDNS in unit tests; keep real discovery only in the integration scenario that is actually
  about discovery.
- Give the WS suites a longer, explicit timeout rather than the global 20s, so a slow machine
  degrades into slowness rather than failure.
- Serialize just `electron/sync/**` within the run rather than the whole suite.
- Make the runner retry a WS scenario once and report it as flaky-but-passed, so a genuine
  assertion failure is visibly different from a timing failure.

## Done when

A full `npm run verify` passes reliably while another test suite is running concurrently, and a red
in `electron/sync/*` can be trusted to mean a real defect.

## Root cause, fully diagnosed (2026-09-05, follow-up session)

Not "the machine is slow" in the sense of needing a bigger timeout. A clean `main` fails
`electron/sync/syncServer.test.js` **by itself** at load ~5.25. The chain:

1. `getFreePort()` (`test/integration/harness.js`) binds port 0, reads the assigned port, **closes
   the server**, and returns the number — a classic check-then-bind race.
2. The caller then binds that same number separately (`startSyncServer(db, { port: PORT })`).
3. If anything takes the port in the gap, `EADDRINUSE`.
4. `startSyncServer`'s `wss.on('error', () => {})` **silently swallowed** bind failures (defensible
   in production — a port collision must not crash the app — but fatal for diagnosability in tests).
5. The server never listens; every test in the file then waits the full 20s `testTimeout` for a
   connection that can never happen. A loud, instantly-diagnosable bind failure was being converted
   into a silent timeout that looked exactly like "slowness," which is why four separate agents
   misattributed it across one session (see "Why it matters" above).

## Fix implemented

**1. Closed the race.** `startSyncServer` (`electron/sync/syncServer.js`) now returns a `ready`
promise alongside the existing `{ wss, close, sendPairingApproved, sendPairingDenied }` object. It
resolves with the actually-bound port (`wss.address().port`, correct even when `port: 0` was
requested) once the `listening` event fires, or rejects with the bind error. The promise is
pre-`.catch()`'d internally so a caller that never awaits it (the production default in
`electron/main.js`, unchanged) produces no unhandled-rejection noise. The synchronous return shape
and the `port`/`onPairingRequest`/`now` options are unchanged — **no signature break for
`electron/main.js`**, which still passes an explicit port and ignores `ready`.

Every direct caller that used to do `PORT = await getFreePort(); server = startSyncServer(db, {
port: PORT })` (`electron/sync/syncServer.test.js`, `syncClient.test.js`, `bulkReplace.sync.test.js`,
`provenance.s2a.test.js`, `scheduleE2E.sync.test.js`, `restore.sync.test.js` — first server per file
only) now does `server = startSyncServer(db, { port: 0 }); PORT = await server.ready`. A handful of
`syncClient.test.js` cases construct the client with a port **before** any server exists (to test
offline queuing) — those still need a pre-known, reserved number and correctly keep `getFreePort()`.

`test/integration/harness.js`'s `Host.start(port = 0)` now defaults to port 0 and always awaits
`server.ready` to learn the real port, so a bind failure throws inside the scenario's own try/catch
instead of the app silently believing a dead server is up. All 23 integration scenarios that only
ever started a Host once now call `host.start()` with no argument, closing their `getFreePort()` race
for free. Two scenarios (`07-pairing-reconnect.js`, `13-host-crash-mid-sync.js`) genuinely restart a
Host on the *same* address without reconnecting via a fresh `serverUrl`, so they still legitimately
need `getFreePort()` to pin the number up front — `getFreePort()` was **not** deleted, per the
brief's own carve-out, and its docstring now says why it still exists and steers new code to
`Host.start()` instead.

**2. Made a bind failure loud in tests, kept the production swallow.** `startSyncServer`'s
`wss.on('error', ...)` still swallows (unchanged prod behavior — a port collision cannot crash the
app), but now also rejects `ready`. Test setup that awaits `ready` therefore throws immediately with
the real error (e.g. `EADDRINUSE: address already in use :::PORT`) instead of timing out. This was
directly observed working: scenario 02 hit a real `EADDRINUSE` from the harness's own reserved-port
race and failed **instantly with the exact error**, not after 20s.

**Signature call:** kept `startSyncServer` itself fully backward compatible (added `ready` to the
returned object only). `Host.start` gained a default parameter (`port = 0` instead of required
`port`) — every existing call site that passes an explicit port keeps working unchanged.
`electron/main.js` was not touched.

## Verification (measured, 2026-09-05)

Machine had no other vitest/verify process running during these runs (`ps aux` checked before each
batch).

- `electron/sync/syncServer.test.js` alone: **5/5 runs, 68/68 tests passing each run** (26-36s each).
- `electron/sync/syncClient.test.js` alone: **5/5 runs, 73/73 tests passing each run** (45-56s each).
- Both together in one vitest invocation: **141/141 passing**.
- `bulkReplace.sync.test.js`, `provenance.s2a.test.js`, `scheduleE2E.sync.test.js`,
  `restore.sync.test.js`, `main.test.js` together: **183/183 passing**.
- `npm run test:integration` (all 27 scenarios): **5/5 consecutive full runs, 27/27 scenarios passing
  each run** (previously reproduced a genuine `EADDRINUSE` in scenario 02 on the *old* code path
  during this same investigation, confirming the race was real, not hypothetical).

This is a big improvement, not a proof the class is eliminated: the runs above were not deliberately
raced against a second concurrent ~4,600-test suite (the condition in "Done when" and
`archive_when`), and two scenarios plus a handful of `syncClient.test.js` cases still carry the
original `getFreePort()`-then-bind gap by necessity (restart-on-same-port, and offline-queue tests
that need a port number before any server exists). Status is left `in-progress` rather than
`completed`/`closed`: the archive condition asks for a sustained flake-free period under genuine
concurrent load, which this session did not run long enough to establish.

## Integration harness's unhandled `'error'`

Addressed as part of the same fix, not left separate: `Host.start()` now `await`s `server.ready`, so
a bind failure that previously would have let a scenario continue silently against a dead server (or
surface asynchronously as an unhandled `'error'` event well after the scenario's try/catch had
already returned) now throws synchronously inside `Host.start()`, caught by the scenario's own
try/catch, and reported as a normal `FAIL` line by `test/integration/run.js`'s per-scenario loop —
exactly as observed for scenario 02's `EADDRINUSE` above. No separate unhandled-rejection handling
was needed in `run.js` itself.
