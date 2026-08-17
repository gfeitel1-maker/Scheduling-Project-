---
title: T90-syncclient-test-fixed-port-flake
document_type: ticket
status: completed
created: 2026-08-17
governing_docs: [docs/governance/constitution/CONSTITUTION.md, docs/governance/GOVERNANCE_INDEX.md]
related_tickets: [docs/work/tickets/T87-returning-client-never-reauthenticates-after-restart.md]
related_adrs: [docs/adr/2026-08-16-client-reauth-on-restart.md]
related_specs: []
related_runs: []
archive_when: "Every electron/sync/*.test.js file (syncClient, syncServer, bulkReplace.sync, restore.sync, provenance.s2a, scheduleE2E.sync) allocates its listen ports dynamically via the harness getFreePort() instead of a hardcoded module-scope PORT constant, such that running the full suite concurrently with other test processes on the same host no longer produces a wrong-close-code or EADDRINUSE flake. Proven by each migrated file passing several consecutive runs and the electron/sync/*.test.js set passing under concurrent load, with no assertion coverage lost, and merged."
---

# T90 — syncClient.test.js fixed ports cause a cross-process test flake

**Severity: LOW (test-infrastructure fragility, not a product-code defect).** Pre-existing; predates T87.
Surfaced by Red Hat (RISK 4) and independently by Code Reviewer during the T87 review panel, 2026-08-17.
Filed as a follow-up so T87 could land; deliberately NOT folded into T87 (out of scope, and the fragility
is file-wide, not introduced by T87).

## The defect

`electron/sync/syncClient.test.js` hardcodes fixed listen ports for the whole file
(`const PORT = 8237`, plus `FLUSH_PORT` / `REMOTE_LOGIN_PORT`). `syncServer.js`'s `wss.on('error', () => {})`
deliberately swallows bind failures. When several agent/CI test processes run on the same host at once
(routine in this repo's concurrent-worktree workflow), two processes can bind — or attempt to bind — the
same literal port. Two observed failure shapes:

- **EADDRINUSE** on port 8237 under multi-file load (the shape previously noted in the T85/T87 run notes).
- **Wrong close code** (Red Hat, newly reproduced): a client from one process's test reaches an *unrelated*
  server instance from a different process whose `camps.signing_public_key` does not match the token's
  signer, so a correctly-revoked-device token is rejected with `4401 invalid_token` instead of the expected
  `4404 device_revoked`. Reproduced once in ~7 runs; passed 3/3 on immediate isolated rerun.

Both are environment-dependent, self-resolve on isolated reruns, and are orthogonal to any product logic.
The load-bearing T87 regression test (`electron/main.reauth.test.js`) is NOT affected — it already
allocates its port dynamically via the harness `getFreePort()`.

## Fix

**Scope broadened at pickup (2026-08-17):** the survey found the fixed-port pattern is not confined to
`syncClient.test.js` — it is file-wide across `electron/sync/*.test.js`, every one of which collides the
same way when two processes run the same file concurrently. Fixing only `syncClient.test.js` would leave
the rest flaky, so this ticket migrates the whole cluster:

- `syncClient.test.js` — `PORT` 8237, `FLUSH_PORT` 8238, `FLUSH_PORT_TIMEOUT` 8239, `REMOTE_LOGIN_PORT` 8240 (+ local `restartPort`/`idemPort`)
- `syncServer.test.js` — `PORT` 8137 (the one that flaked during the C3/sync-auth-deepening panels)
- `bulkReplace.sync.test.js` — `PORT` 8337
- `restore.sync.test.js` — `PORT` 8341
- `provenance.s2a.test.js` — `PORT` 8231
- `scheduleE2E.sync.test.js` — `PORT` 8338

Migrate each fixed listen port to a dynamically-allocated free port via the harness's existing
`getFreePort()` (`test/integration/harness.js`; see correct use in `electron/main.reauth.test.js`).
`getFreePort()` is async, so the module-scope `const PORT = …` becomes a `let port` assigned inside the
async `beforeEach`/`beforeAll` (or per-test where a test spins up its own server). No product-code change;
test-only. Assertions and test behavior unchanged — only the port source.

## Gates

Test-only change touching the LAN sync test harness → Verifier (run each migrated file several times in a
row AND the whole `electron/sync/*.test.js` set concurrently to confirm the EADDRINUSE / wrong-close-code
flake is gone). No Security gate required for a test-port refactor, but a quick Red Hat sanity check that
no assertion coverage was lost in the migration is cheap insurance.
