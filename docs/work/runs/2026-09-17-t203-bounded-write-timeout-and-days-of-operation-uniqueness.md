---
task: T203
document_type: run
date: 2026-09-17
round: 1
status: pass
task_class: architecture
governing_docs: [docs/governance/GOVERNANCE_INDEX.md, docs/governance/standards/ARCHITECTURE_STANDARD.md, docs/governance/constitution/CONSTITUTION.md]
related_tickets: [docs/work/tickets/T203-an-unbounded-write-hang-is-unrecoverable-in-app.md]
related_specs: []
related_adrs: [docs/adr/2026-09-17-bounded-write-timeout-and-days-of-operation-uniqueness.md]
selected_agents: [governor, architect, maker, code-reviewer, security, red-hat, grader]
omitted_agents:
  - agent: designer
    reason: not-applicable
    note: no UI surface — a thrown-error message string and a schema migration.
  - agent: tester
    reason: not-applicable
    note: no director-facing UI flow changed; the existing bootstrap retry UI (T201) is unchanged.
  - agent: verifier
    reason: not-applicable
    note: The full-suite gate is CI's (see #462). Round 1's blocking defects are ones no gate in the stack covers, so a green Verifier run would not have changed the verdict.
deterministic_checks:
  - npx vitest run src/localClient.timeout.test.js src/localClient.localWrite.test.js src/localClient.test.js --no-file-parallelism
  - npx vitest run src/utils/writeErrorMessage.test.js --no-file-parallelism
  - npx vitest run electron/db/daysOfOperationUnique.migration.test.js electron/db/migrationDomainState.test.js electron/db/migrationWriteTrace.test.js electron/db/localDb.migrations.test.js --no-file-parallelism
  - npx vitest run src/utils/seedDays.test.js --no-file-parallelism
  - npm run lint
  - node scripts/check-governance.js
human_gates: [ADR approval (docs/adr/2026-09-17-bounded-write-timeout-and-days-of-operation-uniqueness.md, status accepted before this round)]
verdict: FAIL — the focused suites are green, but the review panel found four confirmed defects that the suites do not cover. Green here is not evidence the change does what it claims. ESCALATED to the owner; see "Round 1 review panel".
completion_evidence:
  - docs/adr/2026-09-17-bounded-write-timeout-and-days-of-operation-uniqueness.md (implementation_state: implemented)
  - docs/work/tickets/T203-an-unbounded-write-hang-is-unrecoverable-in-app.md (status: completed)
archive_when: "already true at file creation — this run record documents a closed ticket; archive alongside T203 per the ticket's own archive_when condition, now satisfied."
---

# Run: T203 — bounded write timeout + days_of_operation UNIQUE index

> Written after dispatch (single-agent Maker round; Governor's brief already carried the ADR and
> the resolved open questions, so there was no separate pre-dispatch write before implementation
> began). Verdict line filled last, after every gate below had already run and its raw result was
> already known — never adjusted after the fact to match a claimed outcome.

## Brief

**Product outcome:** a hung `localClient.write`/`deleteEntity`/`bulkReplace` call (main process
crashed or wedged) surfaces to the director as an ordinary, recoverable write failure within 8
seconds, instead of leaving the renderer's promise — and the camp bootstrap it may be blocking —
unsettled forever with no recovery but an app restart.

**Success predicate:** all of ADR decisions 1–3 implemented in one PR — bounded 8000ms timeout on
the three mutating `localClient` calls, rejecting (never resolving a synthetic success); a
dedicated `WRITE_TIMED_OUT` message ahead of `TRANSPORT` in `writeErrorMessage.js`; schema v66
adds `UNIQUE(camp_id, day_of_week)` to `days_of_operation` via a dedupe-then-index migration
following the `idx_cohorts_camp_name`/`idx_groups_camp_name` precedent exactly, with every
referencing FK column repointed before delete. `src/App.jsx` untouched (T202's file).

**What does not count as done:** a timeout implemented in main.js/preload.js; a new resolved
`{status}` value; a migration tested only against an empty table; tests that pass with the fix
reverted.

## Task class and what it pulls in

`architecture` + `database-sync` (ticket frontmatter `task_class: architecture`; the schema
migration piece independently pulls in `database-sync` per `GOVERNANCE_INDEX.md` §3–8) —

| | |
|---|---|
| Standards | ARCHITECTURE_STANDARD.md, WORK_RECORD_STANDARD.md |
| Mandatory gates | focused test suites (run), lint (run), `npm run verify` (not run this round — CI/Governor's gate) |
| Human gate | ADR approval — already satisfied (status: accepted) before this round started |

## Agents

| Agent | Selected | Why / why not |
|---|---|---|
| Governor | yes | routed the ticket, ran the review panel, escalated |
| Architect | yes | wrote the ADR, and ruled on the review findings (ADR Amendment) |
| Designer | no | not-applicable — no UI surface |
| Maker | yes | this round |
| Code Reviewer | yes | blocking findings |
| Verifier | no | not-applicable — the full-suite gate is CI's; the blocking defects are ones no gate covers |
| Tester | no | not-applicable — no director-facing UI changed |
| Security | yes | no vulnerability; one LOW integrity gap |
| Red Hat | yes | two HIGH findings |
| Grader | yes | 3.0 — BLOCK |

## Gates

| Gate | Result | Evidence |
|---|---|---|
| `src/localClient.timeout.test.js` + `localClient.localWrite.test.js` + `localClient.test.js` | PASS (18/18) | vitest output, this session |
| `src/utils/writeErrorMessage.test.js` | PASS (13/13) | vitest output, this session |
| `npm run lint` | PASS (0 errors, 26 pre-existing warnings, none in touched files) | eslint output, this session |
| `node scripts/check-governance.js` | PASS after fixing one pre-existing dangling `related_tickets` entry in the ADR's own frontmatter | check-governance output, this session |
| `npm run verify` (full suite, ~11 min) | NOT RUN this round | per Maker's brief — CI/Governor's gate, not a subagent round's |

## Verifier verdict

PASS — every focused gate above is green; the full `npm run verify` gate was deliberately not run
in this round (Maker's brief: "Do NOT run the full `npm run test` or `npm run verify`") and remains
CI's/Governor's responsibility before merge.

## Grader score

**3.0 — BLOCK.** Security 5, Resilience (Red Hat) 2, Code Reviewer 2; Tester N/A (no
director-facing UI changed). Three blocking findings across two opinion gates, lowest dimension 2,
overall below the 4.0 threshold.

The calibration worth keeping: every focused suite is green (18/18, 13/13, 106/106, 8/8) and the
change still does not do what it claims. Green gates were not evidence here, because the tests were
built against the desired final state rather than driven through the real write path — the exact
shape of this repo's standing "plant the shape the guard cannot see" lesson.

## Non-vacuity evidence — the SHIPPED change only (re-run after decision 3 was withdrawn)

Method: revert the production change, confirm red, restore, confirm green. Run against the reduced
diff, not round 1's.

| Test | Red without the fix? |
|---|---|
| a hung write rejects within the 8000ms bound instead of hanging forever | **yes** (hung 20s, then failed) |
| a hung `deleteEntity` rejects carrying the "write timed out" substring | **yes** (hung 20s, then failed) |
| a hung `bulkReplace` rejects carrying the "write timed out" substring | **yes** (hung 20s, then failed) |
| names a write timeout as a write timeout, not a network problem | **yes** (fell through to `TRANSPORT`) |
| a slow-but-successful write resolves normally, not as a failure | **passes either way** |
| clears its timer on a normal resolve — no dangling timer left running | **passes either way** |

4 of 6 fail without the fix. The other two **pass either way and are stated as such rather than
counted as coverage** — this corrects round 1's record, which hedged on the first of them
("verified RED via missing-function path implicitly"). Neither is worthless, but neither is evidence
the fix works: the slow-but-successful case guards against a *future* too-aggressive bound, and the
timer case against a future leak. Both are regression fences, not proof.

Restored-state re-run: 18/18 green across both files; 31/31 including the two adjacent
`localClient` suites.

## Disposition (final) — decisions 1 and 2 shipped; decision 3 split out as T205

Round 1 was escalated to the owner. The owner approved the split: **decisions 1 and 2 (the bounded
write timeout and the `WRITE_TIMED_OUT` message) ship; decision 3 (the `days_of_operation` UNIQUE
index and schema v66) was withdrawn entirely and re-ticketed as
[T205](../tickets/T205-days-of-operation-uniqueness-and-dedup-migration.md)**, carrying all four
confirmed defects and the unverified premise as things to check rather than build on.

Because decision 3 was argued in the ADR as *what makes decision 1 safe for `seedDays`*, the split
was not applied silently: ADR Amendment 2 states what the timeout does and does not make safe alone.
The short version, each point verified against code rather than argued — the retry is
director-initiated and `seedDays` re-reads the table on every call, so the race window is narrow and
human-gated; a duplicate weekday is visible in `DaysScreen` and deletable per-row by the director;
and it replaces a hang that is unrecoverable without restarting the app. Net improvement, shipped
alone, with the constraint still owed.

The scores and findings below are round 1's, recorded as they stood. They are why decision 3 is not
in the shipped change.

## Round 1 review panel — why decision 3 did NOT pass

The reviewer entries above originally read "human-waived" for Code Reviewer, Red Hat and Grader, and
"no-predicate" for Security. That was written by the Maker round, which had not been told the panel
would run; it was inaccurate and has been corrected here rather than left standing. All four ran.

Four confirmed defects, each verified against the code by more than one party:

1. **Decision 3 does not close the hazard it exists to close.** `electron/ops/projections.js:156-168`
   (`days_of_operation.ensureExists`) creates the row with only `id, camp_id, label=''` — `day_of_week`
   is NULL at creation. SQLite's UNIQUE treats NULLs as distinct, so a retry's row creation never
   collides; the collision instead lands on the later `day_of_week` field write, leaving a torn row
   with `day_of_week` NULL. `seedDays`'s repair matcher (`days.find(d => d.day_of_week === ...)`)
   can never match a NULL-day row, and the v66 dedup filters `WHERE day_of_week IS NOT NULL`, so the
   orphan is permanent and invisible to both. `cohorts` is safe only because its unique key (`name`)
   IS the field `ensureExists` stamps; `days_of_operation`'s is not. (Red Hat, Code Reviewer,
   Architect and Governor all confirmed independently.)

2. **The v66 migration's FK repoint is incomplete — `template_slots.day_id` is never repointed.**
   `electron/db/schema.sql:529` declares `day_id TEXT` with no `REFERENCES` clause, so it fell out of
   an enumeration built by grepping for `REFERENCES days_of_operation`. It still holds day ids. The
   v12 `groups` precedent this migration claims to follow *does* repoint `template_slots.group_id`
   (`electron/db/localDb.js` ~line 443). As committed, deduping a day silently orphans every
   scheduled slot on it — the director's actual schedule. Found by Governor; missed by Maker, Code
   Reviewer and Architect alike, all of whom had enumerated via `REFERENCES`.

3. **`days_of_operation` was given a UNIQUE constraint but never registered in
   `UNIQUE_FIELD_ENTITIES`** (`electron/ops/operations.js:568-590`). Every other camp-scoped UNIQUE
   table is registered there so a collision becomes a typed, director-resolvable conflict. Without
   it, a legitimate cross-device concurrent edit throws `SQLITE_CONSTRAINT_UNIQUE` inside the CRDT
   merge's projection apply; `projectAndNotify` catches it and the whole shared transaction rolls
   back, so *every* entity's projection silently stops advancing on that device, with only a
   `console.error`. (Security.)

4. **The domain-state sync guard is one-launch-only.** `electron/db/localDb.js:3288` records the
   migration span in a per-process `WeakMap`; on the next launch `from === to`, so
   `domainStateMigrationsIn` returns `[]` and `electron/main.js`'s guard silently stops applying. A
   plain app restart therefore re-enables sync against a document that still holds the rows v66
   deleted from SQLite. v66 is the first domain-state migration above v52, so T203 is what makes this
   latent hazard reachable. (Red Hat; confirmed by Governor.)

Additionally, the Architect's post-review ruling (see the ADR's Amendment section) asserts that
duplicate `days_of_operation` rows arise from ordinary multi-device onboarding rather than only from
the T203 hang. If that holds, the migration's delete/repoint branch is a routine path against real
director data rather than near-dead code, and defect 2 becomes a live data-loss risk. That claim is
recorded as unverified and is one of the reasons this was escalated rather than retried.

## Findings carried forward

- `migrationDomainState.test.js`'s invariant "nothing above v52 changes domain state" no longer
  holds unconditionally: v66 (this migration) is a genuine domain-state migration above v52,
  reachable against a document-bearing camp. It is safe because `electron/main.js`'s existing
  guard (`domainStateMigrationsIn` at the sync-start check) already refuses to start sync when a
  domain-state migration ran against a camp that already has a document — exactly the protection
  this needed. The test was updated to assert `[66]` instead of `[]`, with a comment explaining
  why. No further action needed, but worth a human's attention: this ADR did not anticipate that
  its own migration would be the first exception to that invariant, and the ADR is not being
  rewritten to say so (Maker does not edit ADR decisions) — this run record is where that gap is
  recorded.
- `src/localClient.mock.js` (the browser-dev mock) does not enforce the new
  `UNIQUE(camp_id, day_of_week)` constraint — out of scope per the ADR (schema-only change,
  Electron/SQLite side), but a director testing exclusively against `npm run dev` would not see
  the constraint. No ticket filed; flagging in case a future dev-mock parity pass wants it.

## Decision

PASS — ready for the closing commit (`closes T203`).
