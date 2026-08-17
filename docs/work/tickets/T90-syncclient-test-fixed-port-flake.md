---
title: T90-syncclient-test-fixed-port-flake
document_type: ticket
status: open
created: 2026-08-17
governing_docs: [docs/governance/constitution/CONSTITUTION.md, docs/governance/GOVERNANCE_INDEX.md]
related_tickets: [docs/work/tickets/T87-returning-client-never-reauthenticates-after-restart.md]
related_adrs: [docs/adr/2026-08-16-client-reauth-on-restart.md]
related_specs: []
related_runs: []
archive_when: "electron/sync/syncClient.test.js allocates its listen ports dynamically (via the harness getFreePort() already used by electron/main.reauth.test.js) instead of the hardcoded PORT = 8237 / FLUSH_PORT / REMOTE_LOGIN_PORT constants, such that running the full suite concurrently with other test processes on the same host no longer produces a wrong-close-code or EADDRINUSE flake. Proven by the T87 close-code describe block passing reliably under concurrent load, and merged."
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

Migrate `syncClient.test.js`'s fixed `PORT` / `FLUSH_PORT` / `REMOTE_LOGIN_PORT` constants to
dynamically-allocated free ports using the harness's existing `getFreePort()` helper (see its correct use
in `electron/main.reauth.test.js`). No product-code change; test-only.

## Gates

Test-only change touching the LAN sync test harness → Verifier (run the file under concurrent load a few
times to confirm the flake is gone). No Security/Red Hat gate required for a test-port refactor, but a
quick Red Hat sanity check that no assertion coverage is lost is cheap insurance.
