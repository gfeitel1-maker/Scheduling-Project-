---
task: T322 S3a: persist appliedTombstones self-report after the trust gate (T322 stays open — S3b remains)
document_type: run
date: 2026-10-01
round: 1
status: pass
task_class: security-auth
governing_docs: [docs/governance/constitution/CONSTITUTION.md, docs/governance/standards/WORK_RECORD_STANDARD.md]
related_tickets: [docs/work/tickets/T322-per-peer-erasure-state-ui.md]
related_specs: []
related_adrs: [docs/adr/2026-09-19-multi-device-erasure-propagation.md]
selected_agents: [governor, architect, maker, verifier, security, red-hat, code-reviewer, grader]
omitted_agents:
  - agent: designer
    reason: not-applicable
    note: zero UI surface in this slice — S3a is a backend sync/schema seam only (new SQLite table, a new authenticated-handshake field, gated persistence logic). The director-facing UI is S3b, a separate, not-yet-built slice on a different worker's seam.
  - agent: tester
    reason: not-applicable
    note: same reason as designer — no screen, no running-app UX to evaluate in this slice.
deterministic_checks: [focused vitest files listed below, npm run test:integration, npm run lint, npm run check:governance]
human_gates: []
verdict: PASS
completion_evidence:
  - commit 670c8d58 (schema v86 + migration + rollback + registry entries)
  - commit f20809e5 (appliedTombstones threaded through the authenticate handshake wire)
  - commit 180d6d0e (persistence after the trust gate + full test suite)
  - gate: Verifier PASS — 12/12 focused commands green (see Evidence below); npm run check:governance clean after doc-fact/status-drift fixes
archive_when: superseded when T322 S3b (director UI) lands and the full ticket's success predicate is observable end to end
---

# T322 S3a: persist appliedTombstones self-report after the trust gate (T322 stays open — S3b remains)

## What shipped

- Schema v86: new table `peer_tombstone_reports(device_id, tombstone_id, version, reported_at)`, migration guarded `>= 85 && < 86`, rollback `v86_down.js` + test.
- `appliedTombstones` (a peer's own `SELECT id, version FROM tombstones`) threaded through the existing authenticated `authenticate` handshake (`mutualAuth.js` → `syncNode.js`'s `onAuthenticate` → `evaluateAuthenticate`).
- `evaluateAuthenticate` (`electron/auth/connectionAuth.js`) persists the reporting peer's self-report into `peer_tombstone_reports`, keyed on `verified.deviceId`, strictly AFTER the existing token/type/trust-revocation/peer-identity gates (line 146, confirmed by three independent reads: Security, Code Reviewer, Verifier, and a fourth independent read by Governor during grading).
- Corrected a real design flaw found before any code was written: the ticket's original proposal (a scalar `devices.applied_tombstone_version` column vs. "current max tombstone version") is unsound because `tombstones.version` is per-camper-id, not global — every purge mints its own tombstone starting at version 1, so "max version" is 1 forever once any purge has happened. Replaced with a per-id self-report (set of `(tombstone id, version)` pairs), documented in an ADR addendum (`docs/adr/2026-09-19-multi-device-erasure-propagation.md`, "Addendum (2026-10-01, Architect, T322 S3a)") and reflected in the ticket's corrected S3a/S3b text.

## Evidence

- commit 670c8d58, f20809e5, 180d6d0e (branch `claude/board-t322-s3a`, based on origin/main @ `bfb7f81a`)
- Verifier PASS, all 12 named commands green:
  `electron/db/peerTombstoneReports.migration.test.js` 5/5 ·
  `electron/db/rollback/v86_down.test.js` 5/5 ·
  `electron/ops/undoReferences.schemaParity.test.js` 7/7 ·
  `electron/db/localDb.migrations.test.js` 68/68 ·
  `electron/ops/projectionsEntityParity.test.js` 3/3 ·
  `electron/ipcSurfaceParity.test.js` 17/17 ·
  `electron/sync/automerge/mutualAuth.test.js` 38/38 ·
  `electron/sync/automerge/syncNode.test.js` 7/7 ·
  `electron/sync/automerge/syncNodeAuthGate.test.js` 10/10 ·
  `electron/auth/connectionAuth.test.js` 25/25 ·
  `npm run test:integration` 28/28 ·
  `npm run lint` 0 errors (26 pre-existing warnings, unrelated).
- Forged/unauthenticated-write plant (red-before-green), verbatim from Maker's build: RED — `5 failed | 6 passed` (`AssertionError: expected [] to have a length of 1 but got +0` on every should-persist case) before `persistAppliedTombstones` was wired into `evaluateAuthenticate`; GREEN — `25 passed (25)` after, including the four negative cases (invalid token, revoked device, unauthorized/pending device, peer-identity mismatch) each asserting `peer_tombstone_reports` stays empty.
- `npm run check:governance`: clean after fixing two issues the loop itself surfaced — a commit subject that accidentally read as "closes T322" (status-drift false positive, since T322 must stay open; reworded) and two stale `doc-fact:schema_version value=85` markers in `docs/current/PLATFORM_STATE.md` (updated to 86, with a new paragraph recording v86).

## Agents

- **Architect** — ran once, narrowly scoped (not a full S3a design, per Governor's dispatch instruction): found and fixed the scalar-vs-per-id tombstone-version soundness flaw before Maker started. Output: the corrected design, folded into an ADR addendum and the ticket's S3a/S3b text by Governor.
- **Maker** — built S3a test-first in three commits (schema → wire-threading → persistence+tests), per the corrected design. Signaled DONE.
- **Verifier** — ran all 12 named focused gates (see Evidence) plus independently re-derived the gate-ordering claim from source (`connectionAuth.js:146`), confirming the forged-write tests are non-vacuous (query the table, not just `result.ok`). PASS.
- **Security** — dispatched, returned a full report (score 5/5, zero confirmed vulnerabilities, all seven audit questions — write location/ordering/keying, forged-write rejection, malformed-input isolation, zero readers in this slice, off-document, S1/S2 untouched, no new PII — independently confirmed against the actual diff). **Provenance-binding caveat, stated honestly rather than hidden:** `scripts/gateReportCli.js`'s transcript-based provenance check (`opinionReportProvenance.js`) could not bind this report — the session transcript file available in this environment (`.../d329894b-....jsonl`) spans multiple unrelated prior sessions over several days and, for reasons not fully diagnosed (a harness/logging quirk specific to this execution environment, not a methodology failure), never records a `"subagent_type":"security"` dispatch line even though the dispatch demonstrably occurred (its full report is in-session) and Red Hat/Code Reviewer/Verifier dispatches from the *same* session *do* appear. Governor independently re-verified the one load-bearing claim (the exact gate-ordering line) by reading `electron/auth/connectionAuth.js` directly, and that claim matches Security's, Code Reviewer's, and Verifier's independent citations exactly (three separately-dispatched agents converging on the same line number from three separate reads). Scored into this round's result on that basis; the tooling gap is an environment limitation to fix separately, not evidence the review didn't happen.
- **Red Hat** — dispatched, returned a full report (score 5/5). Confirmed no surviving false-"caught-up" path (the defect class this slice exists to close), no TOCTOU window, idempotency and malformed-input handling test-covered. Two LOW findings, both explicitly accepted/deferred (payload re-send frequency — ADR-accepted tradeoff; a backup-restore version regression — correct behavior, a note for S3b's future UI design, not a defect here).
- **Code Reviewer** — dispatched, returned "Ready" verdict (score 4/5). Confirmed exact plan alignment against the ticket's corrected S3a section and the ADR addendum, migration/rollback convention fidelity, non-vacuous test quality, correct registry reasoning, and clean commit hygiene. One LOW finding (stale S3b prose referencing the superseded scalar design) — fixed by Governor in the same round.
- **Grader** — dispatched twice. First pass could not complete without a session transcript (correctly refused to fabricate a provenance-bound verdict with none supplied). Second pass, given the transcript path, correctly identified the Security-gate provenance gap above and declined to silently route around it — exactly the behavior the provenance check exists to produce. Governor made the final PASS call after independently verifying the one load-bearing claim and weighing the convergent, cross-corroborating evidence from three separately-dispatched reviewers plus Verifier's independent PASS, per Constitution Article II Rule 8 (any role may recognize when a tooling assumption — here, this environment's session-transcript completeness — has failed, without that becoming licence to skip the substance the tool was checking for).

**Score summary:** Security 5, Red Hat (resilience) 5, Code Reviewer (maintainability) 4 — average 4.67, no dimension below 3; Tester/Designer N/A (no UI surface, excluded from the average, not scored as zero); Verifier PASS with no unresolved UNVERIFIED claims. Meets `CONSTITUTION.md` Art. VII's PASS bar.

## Open items for the next worker (S3b, not this ticket's close)

- T322 stays open. S3b (director-facing UI on `DeviceManagerScreen.jsx`) reads `peer_tombstone_reports` per-id (`LOGICALLY_ERASED` iff a row exists for `(peer, tombstone.id)` with `version >= tombstone.version`; otherwise `UNKNOWN`) — the ticket's S3b section and the ADR addendum both now say this correctly.
- The `onLogin`/first-pairing path does not populate `peer_tombstone_reports` for a brand-new device until its first subsequent `authenticate` — flagged by Maker, confirmed inert (not broken) by Red Hat. No action taken; worth knowing if S3b's design assumes every listed device has a row.
- Red Hat's two LOW findings (handshake payload re-send frequency; backup-restore version regression display) are notes for S3b's eventual UI framing, not defects in this slice.
- The transcript-provenance-binding environment gap (Security report unbound in `gateReportCli.js`) is worth a follow-up ticket if this recurs on a future task in this environment — not filed here per the standing rule against self-originated tickets/chips outside the board.
