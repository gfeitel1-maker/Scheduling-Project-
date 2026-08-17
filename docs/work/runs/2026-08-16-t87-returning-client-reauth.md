---
task: T87-returning-client-never-reauthenticates-after-restart
document_type: run
date: 2026-08-16
round: 2
status: pass
task_class: security-auth
governing_docs: [SECURITY.md, docs/governance/standards/ARCHITECTURE_STANDARD.md, docs/adr/2026-07-24-centralized-authorization-layer.md, docs/adr/2026-07-25-device-trust-revocation.md, docs/adr/2026-07-25-append-only-audit-event-log.md]
related_tickets: [docs/work/tickets/T87-returning-client-never-reauthenticates-after-restart.md, docs/work/tickets/T85-devices-table-never-synced-cross-device-op-drop.md]
related_specs: []
related_adrs: [docs/adr/2026-08-16-client-reauth-on-restart.md, docs/adr/2026-08-16-device-fk-seeding-and-delivery-watermark.md, docs/adr/2026-07-25-device-trust-revocation.md]
selected_agents: [governor, architect, maker, code-reviewer, verifier, tester, red-hat, security, grader]
omitted_agents:
  - agent: designer
    reason: not-applicable
    note: one new sidebar copy string reusing an existing dispatch/label pattern (sidebarState.js's SYNC_STATUS_COPY) — not a new screen, layout, or interaction; no design-significant surface.
deterministic_checks: [test, lint, build, integration]
human_gates:
  - "Product decision: silent auto-reauth (Option A, recommended) vs. explicit re-login (Option B) — Article IV product-judgement gate, owner decides before Maker starts."
  - "ADR acceptance: docs/adr/2026-08-16-client-reauth-on-restart.md is PROPOSED, not accepted — Article IV 'architecture change without an accepted ADR' gate."
  - "Security/auth task class: this changes behavior around SECURITY.md's documented 'Offline local tokens cannot be remotely invalidated' tradeoff (a revoked device now surfaces the rejection as a forced logout on the next restart/reconnect, instead of silently sitting disconnected until the 24h token ceiling) — Security must confirm this is a strengthening, not a weakening, and update SECURITY.md's wording accordingly per the security-auth row's 'any change to an accepted tradeoff' gate."
verdict: PASS
completion_evidence:
  - "Grader round 2: PASS, overall 4.5, lowest dimension 4, verifier_pass true, decision_eligibility PASS_ELIGIBLE — docs/work/runs/gate-reports/T87-r2.json"
  - "Deterministic gates on the rebased base (branch HEAD 998922d atop main f9879c4): unit suite 3054 passed / 1 skipped (198 files), exit 0; lint 0 errors; check:governance no findings; integration 25/25."
  - "Real-path regression: electron/main.reauth.test.js drives makeHandlers → chooseMode → verifySession across a simulated Electron restart and proves a live Host op reaches the re-authenticated Client (ws.deviceId set) with no PIN re-entry."
  - "Panel: Security 5/5, Code Reviewer Ready, Red Hat Resilience 4/5, Tester UX/Visual — no blocking findings. Two MEDIUMs (Tester revoked-device-context, Red Hat RISK 2 substance) addressed by the login-context fix round; residual RISK 2 optimistic-auth window and RISK 4 test-port flake disclosed (ADR post-implementation note; follow-up T90)."
archive_when: "A Client device that was previously paired and holds a still-valid session token, after a full Electron process restart (app relaunch / tablet reboot / crash-recover), reliably reaches an AUTHENTICATED WebSocket state with the Host (ws.deviceId set, receiving live broadcastOps and sendMissedOps catch-up) WITHOUT the user being forced to re-enter their PIN — OR, if forcing re-login is the chosen product behavior, the UI honestly reflects the not-yet-authenticated state instead of showing a stale 'session' phase. Proven by a test exercising the real electron/main.js chooseMode client path (not the harness Client), and merged with owner sign-off."
---

# Run: T87 — returning Client never re-authenticates after restart

> Written **before dispatch** per `WORK_RECORD_STANDARD.md` §5.1, and updated as agents return.
> A run abandoned halfway still leaves this file, which is the case where it is worth most.

## Brief

**Product outcome:** A camp director's tablet or laptop, after being restarted mid-camp-day (app
relaunch, device reboot, crash-recover) — a routine event on camp hardware, not an edge case — keeps
receiving live schedule/roster updates from the Host without the director noticing anything happened,
as long as their last login is still within its 24h window. If the owner instead wants an explicit PIN
re-entry on every restart, the app must say so honestly (a real Login screen) rather than showing a
normal-looking app that is silently not talking to the Host.

**Success predicate:** Ticket's own `archive_when` (frontmatter, above) — a real test exercising
`electron/main.js`'s actual `chooseMode` client path (not the integration harness's `Client` class, which
already does the correct thing and therefore cannot reproduce this defect) proves a returning, valid-token
Client reaches `ws.deviceId`-set / authenticated state, or the UI is provably honest about not having
reached it.

**What does not count as done:** A fix that only works in the test harness (`Client.reconnect()`'s
existing `token: this.token || undefined` already "works" — that was never the gap). A fix that makes the
common case silent-succeed but leaves a revoked-device rejection silently retrying a dead token forever
(a different-shaped silent failure, identified during design — see the ADR's Divergent exploration). A
status badge that exists but that no code path actually updates on the specific transition this ticket is
about.

## Architect design (this document)

Premise **CONFIRMED** end-to-end from source (not merely re-asserted from the ticket) — full five-step
call-chain trace, plus the harness-gap explanation, is in
`docs/adr/2026-08-16-client-reauth-on-restart.md`'s Context section. Design, divergent-ideation record,
and the ADR itself are in that same file (status: proposed). Summary for this run record:

- **Recommended fix (Option A, pending owner sign-off):** reorder `useDeviceMode.js`'s startup effect so
  `verifySession` runs before `chooseMode`, and thread the locally-verified token into `chooseMode`'s
  client-branch call, which forwards it into `createSyncClient`'s already-existing (already correct, never
  fed) `token` parameter. Zero new WS protocol messages.
- **Required regardless of Option A/B:** close a reconnect-loop-with-a-dead-token gap found during
  divergent ideation (two independent frames converged on it) — on a Host-issued 4401–4404 rejection,
  clear the client's cached token and stop silently re-attempting `authenticate` with it, falling back to
  the existing idempotent `pairing_request` path, and force the UI back to an honest `'login'` phase.
- **Status signal:** extend the already-fully-wired T27 `getSyncStatus`/`onSyncStatusChanged` pipeline
  with one new boolean (`authenticated`) and one new sidebar state (`'client-connecting'`), reusing
  `sidebarState.js`'s existing `SYNC_STATUS_COPY` dispatch pattern verbatim.

## Task class and what it pulls in

`security-auth` — per `GOVERNANCE_INDEX.md` §3–8 this governs:

| | |
|---|---|
| Standards | `SECURITY.md` · `ARCHITECTURE_STANDARD.md` · ADRs `2026-07-24-centralized-authorization-layer`, `2026-07-25-device-trust-revocation`, `2026-07-25-append-only-audit-event-log` |
| Mandatory gates | test · lint · build · **integration (mandatory)** |
| Human gate | **any change to an accepted tradeoff** (see `human_gates` above — the offline-token-revocation-latency tradeoff) |

This task also spans `database-sync`/`concurrency` (LAN reconnect + WS protocol reachability). Per
`WORK_RECORD_STANDARD.md`, a task spanning two classes takes the **stricter** gate list from both —
`database-sync`'s own human gate ("ADR + migration/rollback plan") is satisfied by this same ADR (Migration
section: no schema change, additive-only IPC/status fields). `concurrency`'s human gate ("any change to
write-ordering or op-log replay semantics") does not independently apply — this design touches connection
state and the close handler, not op-log write-ordering or replay, and the ADR's Security section verifies
no interaction with T85's `isReauthenticate` guard changes.

## Agents

| Agent | Selected | Why / why not |
|---|---|---|
| Governor | yes | routing; is currently asking the owner the Option A/B product question in parallel with this design |
| Architect | yes | this document — verified the premise, designed the fix, wrote the ADR |
| Designer | no | not-applicable — one reused-pattern copy string, no new screen/layout/interaction (see `omitted_agents`) |
| Maker | yes | implements once the owner picks Option A or B and the ADR is accepted |
| Code Reviewer | yes | maintainability + plan-alignment on Maker's diff |
| Verifier | yes | always — the only deterministic evidence source; integration suite is mandatory for this task class |
| Tester | yes | director's-eye check that a real restart-and-reconnect (or a real forced-relogin, if Option B) reads correctly in the running app, not just in a unit test |
| Security | yes | mandatory for security-auth task class; must specifically verify the SECURITY.md tradeoff-language update and the "no new PIN/lockout bypass" claim in the ADR |
| Red Hat | yes | mandatory per the ticket's own "Gates" section for sync/reconnect semantics; should specifically re-attack the close-code-clearing logic (Part 3) and the multi-tab/multi-process non-goal the attacker `adhd` frame flagged |
| Grader | yes | consolidates the above into a single pass/fail read |

Every one of the ten appears here.

## Gates

| Gate | Result | Evidence |
|---|---|---|
| ADR written | done | `docs/adr/2026-08-16-client-reauth-on-restart.md`, status `accepted` (+ post-implementation review note) |
| Owner product decision (Option A vs B) | done | Option A (silent auto-reauth) chosen by owner |
| ADR acceptance | done | accepted |
| Maker implementation | done | Parts 1–4 + review-driven fix round (login-context reason, shared `clearSessionState`) |
| test / lint / build / integration | pass | unit 3054 pass / 1 skip (198 files) exit 0 · lint 0 errors · integration 25/25 · governance clean |
| Security review | pass | 5/5 — Host auth logic byte-identical; only locally-verified token to transport; token never logged; `SECURITY.md` tradeoff wording updated |
| Red Hat review | pass | Resilience 4/5 — no blocking; RISK 2 (optimistic-auth window) disclosed, RISK 4 (test-port flake) → T90 |
| Code Reviewer | pass | Ready — faithful, plan-aligned; run-doc + stale-comment items closed |
| Tester | pass | Visual 5/5; UX MEDIUM (revoked device → login with no context) closed by the fix round |

## Verifier verdict

VERIFIED — all deterministic gates green on the rebased base (branch HEAD `998922d` atop main `f9879c4`):
unit suite 3054 passed / 1 skipped, exit 0; lint 0 errors; `check:governance` no findings; integration
25/25. The load-bearing evidence is `electron/main.reauth.test.js`, which exercises the real
`electron/main.js` `chooseMode`/`verifySession` path (not the integration harness) across a simulated
Electron restart and proves a live Host op reaches the re-authenticated Client.

## Grader score

**PASS — overall 4.5** (lowest dimension 4; both thresholds met: ≥4.0 overall, no dim <3, verifier not
FAIL). Per-dimension: Security 5, Code Reviewer 5, Red Hat/Resilience 4, Tester/UX 4. Consolidated via the
GateReport reducer — `docs/work/runs/gate-reports/T87-r2.json` (`decision_eligibility: PASS_ELIGIBLE`, no
blocking findings). All four `archive_when` conditions confirmed met.

## Findings carried forward

- Deferred, not folded into this ticket's scope (see ADR Non-goals): a positive `authenticate_ok` server
  ack for the pre-existing "Host silently hangs mid-authenticate" gap; Host-side authentication-attempt
  observability/metrics; a generic bounded-retry cap on all reconnect attempts; multi-tab/multi-process
  session accounting (flagged for Security's judgment, not confirmed reachable); local audit-trail logging
  of transport-status transitions.
- `SECURITY.md`'s "Offline local tokens cannot be remotely invalidated" section will need a wording update
  once this ships — the 24h ceiling is unchanged, but a revoked device now discovers and surfaces that fact
  on its next restart/reconnect attempt instead of only at token expiry. Flagged for Security to word
  precisely, not pre-empted here.

## Decision

**Shipped (Option A, silent auto-reauth).** Owner chose Option A; the ADR was accepted; Maker implemented
Parts 1–4, the panel ran, and a review-driven fix round closed both MEDIUM findings (a revoked/rejected
device now returns to login with a plain-language reason rather than a silent bounce; the two token-cleanup
paths were unified into `clearSessionState`). Grader PASS 4.5, all `archive_when` conditions met. Landed on
`main` via the branch rebased onto `f9879c4`. Deferred, ticketed follow-up: **T90** (migrate
`syncClient.test.js` off its fixed port to eliminate the pre-existing concurrent-load flake).
