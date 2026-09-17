---
task: fix: surface ensureCohort write failures on both sides (closes T190)
document_type: run
date: 2026-09-17
round: 1
status: pass
task_class: ui-ux-design
governing_docs: [docs/governance/constitution/CONSTITUTION.md, docs/governance/standards/WORK_RECORD_STANDARD.md]
related_tickets: [docs/work/tickets/T190-ensurecohort-write-failures-are-invisible.md]
related_specs: []
related_adrs: []
selected_agents: [governor, code-reviewer, red-hat, verifier]
omitted_agents:
  - agent: architect
    reason: not-applicable
    note: No contract, schema or stored-data-shape change. The fix adds a result check inside an existing renderer-side write loop and a .catch on an existing caller; the shape it adopts is already settled by five sibling sites.
  - agent: designer
    reason: not-applicable
    note: No new visual surface. The ticket's non-goals explicitly forbid a new error-surface component; the rejection reuses the opRejectedNotice surface AppShell already mounts.
  - agent: maker
    reason: not-applicable
    note: Implemented directly by the orchestrator. The change is ~20 lines across two source files mirroring a commit from the same day (62f6f93); a separate Maker dispatch would have added a hop without adding judgement.
  - agent: tester
    reason: no-predicate
    note: The observable behaviour is a notice that only appears when a bootstrap write is refused — a state that cannot be produced by driving the dev mock through the UI. It is covered deterministically at the App level instead (src/App.test.jsx).
  - agent: security
    reason: not-applicable
    note: No auth, PIN, secret, IPC surface, transport or packaging change. The diff neither widens nor narrows what the renderer may ask the main process to do.
  - agent: grader
    reason: not-applicable
    note: Single round, no score-vs-gate tension to adjudicate: Verifier returned PASS on every scoped gate with independently re-run mutation evidence, and both reviewers returned no finding above LOW/MEDIUM-out-of-scope.
deterministic_checks: [npm run lint, node scripts/check-governance.js, npx vitest run src/utils/ensureCohort.test.js src/utils/ensureCohort.race.test.js src/App.test.jsx src/utils/seedDays.test.js, npm run build]
human_gates: []
verdict: pass
completion_evidence:
  - "the single commit on branch claude/t190-ensurecohort-write-failures (see the PR); a SHA is deliberately not pinned here, since amending the commit that carries this record would invalidate it"
  - "gate: lint 0 errors (26 pre-existing warnings) · check:governance no findings · vitest 32/32 passed across the 4 named files · npm run build succeeded. Full suite delegated to CI, which is the gate of record for merging per #462 (78a3586)."
archive_when: T190 is closed and the ensureCohort write-result check plus its App.jsx .catch have survived one release without being reverted or reshaped.
---

# fix: surface ensureCohort write failures on both sides (closes T190)

## What shipped

- `src/utils/ensureCohort.js` — the per-field write loop now checks each
  `localClient.write` result for `status` `applied`/`queued` and throws
  `write failed for field "<field>"` otherwise. It was the last per-field loop in
  the codebase discarding the result. The pre-existing `try/catch` did not cover
  this: that catch swallows a `UNIQUE(camp_id, name)` collision from the
  concurrent-mount race and only ever sees **thrown** errors, while a refused
  write **resolves** with `{ status: 'rejected' }`.
- `src/App.jsx` — `ensureCohort(campId)` was a floating promise, so even a
  correct throw landed nowhere (it also swallowed the pre-existing camp-mismatch
  throw). It now routes through `describeWriteFailure` into the `opRejectedNotice`
  surface already mounted, alongside the sibling `seedDays` catch.
- `src/utils/ensureCohort.race.test.js` — the write mock returned `appendOp`'s bare
  op row rather than `localClient.write`'s real `{ status, op }` contract
  (`electron/sync/localWriteClient.js:131`). With the new check, that unfaithful
  mock failed writes that had actually succeeded. Corrected, and the reason recorded
  in the test.

The wording of the throw is load-bearing, not cosmetic: the throw is raised
*inside* the try whose catch swallows `/UNIQUE/i`. A message matching that regex
would have let the race catch eat the very failure this ticket exists to surface.
A test pins that interaction specifically, not just the mechanical throw.

## Evidence

- The single commit on branch `claude/t190-ensurecohort-write-failures` — the one that carries this record.
- Scoped gates, all green: `npm run lint` (0 errors), `node scripts/check-governance.js`
  (no findings), `npx vitest run src/utils/ensureCohort.test.js
  src/utils/ensureCohort.race.test.js src/App.test.jsx src/utils/seedDays.test.js`
  (32/32), `npm run build`. The full suite runs in CI, the gate of record per #462.
- **Non-vacuity, independently re-run by Verifier rather than taken from the commit
  message** — each mutation applied, the scoped file re-run, then the file restored:
  - removing the status check → 3 red in `ensureCohort.test.js`
  - changing the thrown message to match `/UNIQUE/i` → the same 3 red (the
    designed-for mistake is caught, not merely the absence of a check)
  - removing the `.catch` in `App.jsx` → 1 red in `App.test.jsx`
  - reverting the race-test mock to the bare op row → both race tests red
  - the `queued`-is-success test passes with and without the fix. It pins the
    offline path; it is **not** evidence of coverage, and is recorded as such.

## Agents

Ran: governor (this record), code-reviewer, red-hat, verifier. Omission reasons
are in the frontmatter above, each against the actual predicate rather than a
convenience.

Red Hat confirmed the two attacks that mattered and found neither defect: a
cohort write cannot produce a structured `unique_field` rejection (`cohorts` is
not in `UNIQUE_FIELD_ENTITIES`), so the only `/UNIQUE/i`-matching error on this
path is the genuine thrown constraint violation the catch is for; and
`applied`/`queued` covers every status the live write path returns (`queued` is
tolerated dead code from the retired offline-queue design, kept for symmetry with
the sibling loops).

It raised two findings this ticket deliberately does not address, both pre-existing
and both out of the ticket's stated non-goals: `seedDays` and `ensureCohort` write
into the same single `opRejectedNotice` slot, so two simultaneous real failures show
only one notice; and `seededForCamp` is set before either call settles, so a
transient bootstrap failure is not retried for that camp in the session. Reported
to the owner rather than folded in.
