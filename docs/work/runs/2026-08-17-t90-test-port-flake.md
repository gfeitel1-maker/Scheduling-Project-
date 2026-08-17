---
task: T90-syncclient-test-fixed-port-flake
document_type: run
date: 2026-08-17
round: 1
status: pass
task_class: test-infrastructure
governing_docs: [docs/governance/constitution/CONSTITUTION.md, docs/governance/GOVERNANCE_INDEX.md]
related_tickets: [docs/work/tickets/T90-syncclient-test-fixed-port-flake.md]
related_specs: []
related_adrs: []
selected_agents: [governor, maker, verifier, red-hat]
omitted_agents:
  - agent: architect
    reason: not-applicable
    note: no architecture decision — a pre-scoped test-infrastructure refactor (fixed port literal → getFreePort()); no ADR, no module-boundary or protocol change.
  - agent: code-reviewer
    reason: not-applicable
    note: for a pure port-source substitution the maintainability/plan-alignment concern reduces to assertion-count parity and "no logic changed" — covered directly by Red Hat's line-by-line before/after diff (160/160 assertions identical) plus Maker's own diff discipline. No separate maintainability predicate remains for a LOW test-only change.
  - agent: security
    reason: not-applicable
    note: test-only port-source refactor — no product code, no auth/secret/protocol surface (per the ticket's Gates section, no Security gate required).
  - agent: designer
    reason: not-applicable
    note: no UI/UX surface.
  - agent: tester
    reason: not-applicable
    note: no director-facing behavior — the change is confined to test infrastructure.
  - agent: grader
    reason: not-applicable
    note: LOW-severity test-only change; consolidated at the main loop from Verifier's deterministic gates plus Red Hat's assertion-parity sanity (gate report T90-r1.json). Full Grader reserved for product-code slices.
deterministic_checks: [test, lint, integration]
human_gates: []
verdict: pass
completion_evidence:
  - "All six electron/sync/*.test.js files migrated from hardcoded module-scope listen ports to getFreePort()-allocated dynamic ports (commit 97e3bd4). Assertions/logic unchanged — 160/160 tests, all expect() counts identical before/after (Red Hat verified against git show 69206e4)."
  - "Deterministic same-file collision (the ticket's target) ELIMINATED: running the same file as two simultaneous processes — syncClient x3, syncServer x2 — all passed, where fixed ports collide deterministically."
  - "Verifier: solo full suite 3100 passed / 1 skipped exit 0; lint 0 errors; governance clean. (A first full-suite run flaked once on restore.sync.test.js — the residual noted below — which passes 14/14 x3 isolated and clean on re-run.)"
  - "Red Hat 5/5: assertion-count parity per file, offline/timeout tests confirmed still hitting their failure paths (no accidental live-server connection), intentional same-port collision test preserved, and a latent PAIR_PORT = PORT + 10 NaN bug caught and fixed."
archive_when: "see ticket — all six electron/sync/*.test.js allocate ports via getFreePort(); proven by consecutive + concurrent-load passes with no assertion coverage lost, and merged."
---

# Run: T90 — sync test fixed-port flake → getFreePort()

## Brief
Pre-existing test-infrastructure flake (surfaced during the T87 and sync/auth-deepening panels): every
`electron/sync/*.test.js` file hardcoded a module-scope listen port, so two processes running the same
file at once — routine in this repo's concurrent-worktree / multi-session workflow — collided
(EADDRINUSE, or a client reaching an unrelated server and getting the wrong close code). Not a product
defect; environment-dependent; self-resolved on isolated reruns.

**Success predicate:** each `electron/sync/*.test.js` allocates its listen ports dynamically via the
harness `getFreePort()` (the pattern already used by `electron/main.reauth.test.js`), the deterministic
same-file collision is gone (proven by concurrent same-file runs passing), and no assertion coverage is
lost. Test-only; no product-code change.

## What was done
Migrated all six files — `syncClient.test.js` (8237/8238/8239/8240 + local restart/idem/drop/d4/edit
ports + two inline unreachable literals), `syncServer.test.js` (8137 + THROTTLE_PORT + PAIR_PORT),
`bulkReplace.sync.test.js` (8337), `restore.sync.test.js` (8341), `provenance.s2a.test.js` (8231),
`scheduleE2E.sync.test.js` (8338). Each module-scope `const PORT = <literal>` became a `let` assigned via
`await getFreePort()` in the async `beforeEach`/setup before the server that consumes it; secondary and
per-test ports allocated at point of use. Scope was broadened at pickup from the ticket's original
`syncClient.test.js`-only wording to the whole cluster, because the flake is file-wide and a partial fix
would leave five files flaky.

## Gates
| Gate | Result | Evidence |
|---|---|---|
| Maker implementation | done | commit `97e3bd4` — 6 files, port-source only, latent `PAIR_PORT = PORT + 10` NaN fixed |
| test (solo full suite) | pass | 3100 passed / 1 skipped, exit 0 (clean re-run) |
| Concurrent same-file (flake repro) | pass | syncClient x3, syncServer x2 as simultaneous processes — all green |
| lint / governance | pass | 0 errors / no findings |
| Red Hat sanity | pass | Resilience 5/5 — 160/160 assertion parity; offline/timeout + collision tests intact |

## Verifier verdict
VERIFIED — full suite 3100 pass exit 0; lint 0; governance clean; the concurrent-same-file reproduction
(the exact collision the ticket targets) passes where fixed ports would fail.

## Grader score
Not run — LOW-severity test-only change. Self-consolidated at the main loop: Verifier PASS + Red Hat 5/5,
no blocking findings (gate report `T90-r1.json`).

## Findings carried forward
- **Residual (Red Hat, LOW — not a regression, documented so it is not chased as a new bug):** `getFreePort()`
  *reduces* but does not fully *eliminate* cross-process collision. It binds port 0, reads the assigned
  port, closes, and returns the number; a different process on the same host could grab that exact port in
  the window before the test re-binds it (some tests hold the number across several `await`s). This is the
  standard allocate-then-bind-later race, identical to the already-accepted `main.reauth.test.js` pattern,
  and orders of magnitude rarer than the deterministic fixed-8xxx collisions removed here. The one
  full-suite flake observed during this run (`restore.sync.test.js` "draining is idempotent", green on 3
  isolated reruns) is an instance of exactly this residual — a peer session was running sync tests
  concurrently. Chasing it to zero would require a different mechanism (e.g. bind-and-hold, or teaching
  `startSyncServer` to accept port 0 and report the bound port) — out of scope for this ticket.

## Decision
Shipped. All six `electron/sync/*.test.js` files migrated to `getFreePort()`; the deterministic same-file
port-collision flake is eliminated; assertion coverage preserved (Red Hat 5/5). The inherent TOCTOU
residual is documented above, not a blocker.
