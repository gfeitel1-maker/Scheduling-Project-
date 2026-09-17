---
task: fix: give a failed camp bootstrap a retry affordance (closes T201)
document_type: run
date: 2026-09-17
round: 1
status: pass
task_class: ui-ux-design
governing_docs: [docs/governance/constitution/CONSTITUTION.md, docs/governance/standards/WORK_RECORD_STANDARD.md]
related_tickets: [docs/work/tickets/T201-transient-bootstrap-failure-is-never-retried.md, docs/work/tickets/T200-two-bootstrap-failures-show-one-notice.md]
related_specs: []
related_adrs: []
selected_agents: [maker]
omitted_agents:
  - agent: governor
    reason: not-applicable
    note: Maker was dispatched directly by the owner with a pre-written brief; no Governor loop ran for this session.
  - agent: architect
    reason: not-applicable
    note: The owner's brief fixed the architecture (separate in-flight ref, ref-indirected retry callback, retry button); no open design question required Architect.
  - agent: designer
    reason: not-applicable
    note: One quiet text-weight button added to the existing S.errorBanner notice, styled per the brief's explicit direction; no new visual surface.
  - agent: code-reviewer
    reason: not-applicable
    note: Not dispatched this session; the owner receives this report directly and will route review themselves.
  - agent: verifier
    reason: not-applicable
    note: Not dispatched this session; Maker ran the scoped gates itself per the brief's explicit instruction not to run the full npm run verify.
  - agent: tester
    reason: not-applicable
    note: No new screen; covered by the App.test.jsx suite, including the StrictMode double-invoke and double-click-retry non-goals the ticket specifically named.
  - agent: security
    reason: not-applicable
    note: No auth, IPC, secrets, or transport-boundary surface touched — pure renderer-side state and a ref-serialized retry.
  - agent: red-hat
    reason: not-applicable
    note: Not dispatched this session; T201 already names its own trap (the StrictMode double-seed hole) and this fix is pinned by a test proving that trap is not reopened.
  - agent: grader
    reason: not-applicable
    note: Not dispatched this session.
deterministic_checks: [npx vitest run src/App.test.jsx src/App.landing.test.jsx --no-file-parallelism, npx eslint src/App.jsx src/App.test.jsx, node scripts/check-governance.js]
human_gates: []
verdict: pass
completion_evidence:
  - commit e126ebd
  - commit a55eefe
  - commit d201d01
  - commit 98dfe05
  - gate: vitest — Test Files 2 passed (2), Tests 18 passed (18)
  - gate: eslint src/App.jsx src/App.test.jsx — 0 errors, 1 pre-existing warning (line 222, unrelated weekId dep), exit 0
archive_when: "A director who sees a bootstrap-failure notice has a way to recover within the session that matches what the copy tells them to do, StrictMode double-invocation still cannot double-seed days_of_operation, both are covered by tests proven to fail without the fix, and npm run verify is green — met by this commit's tests (Try again re-runs and clears the notice; StrictMode double-invoke still calls seedDays exactly once, proven passes-either-way against the pre-existing seededForCamp guard; rapid double-click on Try again does not run concurrent bootstraps, proven RED against the pre-fix code); the owner still owes a full npm run verify run per the brief's own scoping (Maker ran focused gates only, as instructed)."
---

# fix: give a failed camp bootstrap a retry affordance (closes T201)

## What shipped

- fix: give a failed camp bootstrap a retry affordance (closes T201)
- docs: run record + status flip for T200 (closes T200)
- fix: surface both bootstrap failures in one notice (closes T200)
- docs: file T200 and T201 (bootstrap notice collapse + no retry)

## Evidence

- commit e126ebd
- commit a55eefe
- commit d201d01
- commit 98dfe05
- gate: `npx vitest run src/App.test.jsx src/App.landing.test.jsx --no-file-parallelism` — 18/18 passed
- gate: `npx eslint src/App.jsx src/App.test.jsx` — 0 errors, exit 0
- gate: `node scripts/check-governance.js` — clean after this record

## Agents

Maker only. This was a direct owner-to-Maker dispatch (brief already
specified the architecture) with no Governor loop invoked this session.
Every other agent role is omitted as not-applicable for the reasons listed
above; none were run and none are claimed to have run. The owner is
expected to route independent review (Code Reviewer, Verifier's full-suite
gate, Red Hat) themselves, since the brief explicitly scoped Maker to the
focused test files rather than the full `npm run verify`.
