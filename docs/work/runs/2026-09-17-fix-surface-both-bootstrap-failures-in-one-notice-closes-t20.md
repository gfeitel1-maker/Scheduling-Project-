---
task: fix: surface both bootstrap failures in one notice (closes T200)
document_type: run
date: 2026-09-17
round: 1
status: pass
task_class: ui-ux-design
governing_docs: [docs/governance/constitution/CONSTITUTION.md, docs/governance/standards/WORK_RECORD_STANDARD.md]
related_tickets: [docs/work/tickets/T200-two-bootstrap-failures-show-one-notice.md, docs/work/tickets/T201-transient-bootstrap-failure-is-never-retried.md]
related_specs: []
related_adrs: []
selected_agents: [maker]
omitted_agents:
  - agent: governor
    reason: not-applicable
    note: Maker was dispatched directly by the owner with a pre-written brief (architecture already decided); no Governor loop ran for this session.
  - agent: architect
    reason: not-applicable
    note: The owner's brief fixed the architecture (Promise.allSettled composition, single notice scalar); no open design question required Architect.
  - agent: designer
    reason: not-applicable
    note: No new visual surface — reuses the existing S.errorBanner notice and dismiss-button pattern verbatim; only copy and control logic changed.
  - agent: code-reviewer
    reason: not-applicable
    note: Not dispatched this session; the owner receives this report directly and will route review themselves.
  - agent: verifier
    reason: not-applicable
    note: Not dispatched this session; Maker ran the scoped gates itself per the brief's explicit instruction not to run the full npm run verify.
  - agent: tester
    reason: not-applicable
    note: No new screen or user-facing flow beyond the existing notice banner; covered by the App.test.jsx suite instead.
  - agent: security
    reason: not-applicable
    note: No auth, IPC, secrets, or transport-boundary surface touched — pure renderer-side state composition.
  - agent: red-hat
    reason: not-applicable
    note: Not dispatched this session; the ticket itself (T200) already names the open design question (offline-queue path) and this record answers it inline.
  - agent: grader
    reason: not-applicable
    note: Not dispatched this session.
deterministic_checks: [npx vitest run src/App.test.jsx src/App.landing.test.jsx --no-file-parallelism, npx eslint src/App.jsx src/App.test.jsx, node scripts/check-governance.js]
human_gates: []
verdict: pass
completion_evidence:
  - commit d201d01
  - commit 98dfe05
  - gate: vitest — Test Files 2 passed (2), Tests 18 passed (18)
  - gate: eslint src/App.jsx src/App.test.jsx — 0 errors, 1 pre-existing warning (line 222, unrelated weekId dep), exit 0
archive_when: "A camp bootstrap in which both seedDays and ensureCohort fail on the same tick produces one notice naming BOTH failures, covered by a test proven to fail without the fix, and npm run verify is green — met by this commit's test T200 (verified RED against the pre-fix App.jsx, then GREEN); the owner still owes a full npm run verify run per the brief's own scoping (Maker ran focused gates only, as instructed)."
---

# fix: surface both bootstrap failures in one notice (closes T200)

## What shipped

- fix: surface both bootstrap failures in one notice (closes T200)
- docs: file T200 and T201 (bootstrap notice collapse + no retry)

## Evidence

- commit d201d01
- commit 98dfe05
- gate: `npx vitest run src/App.test.jsx src/App.landing.test.jsx --no-file-parallelism` — 18/18 passed
- gate: `npx eslint src/App.jsx src/App.test.jsx` — 0 errors, exit 0
- gate: `node scripts/check-governance.js` — clean after this record

## Agents

Maker only. This was a direct owner-to-Maker dispatch (brief already specified
the architecture — Promise.allSettled composition, single notice scalar, no
queue) with no Governor loop invoked this session. Every other agent role is
omitted as not-applicable for the reasons listed above; none were run and none
are claimed to have run. The owner is expected to route independent review
(Code Reviewer, Verifier's full-suite gate, Red Hat) themselves, since the
brief explicitly scoped Maker to the focused test files rather than the
full `npm run verify`.
