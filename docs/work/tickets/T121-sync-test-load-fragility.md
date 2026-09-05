---
title: "Sync/WS tests fail under concurrent load, making a red gate uninformative"
document_type: ticket
status: open
created: 2026-09-05
task_class: test-infrastructure
archive_when: "a full `npm run verify` passes reliably while another test suite runs concurrently, and no WS/mDNS scenario has flaked for a sustained period"
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
