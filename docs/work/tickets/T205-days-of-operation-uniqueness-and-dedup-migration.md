---
title: "days_of_operation needs the uniqueness its own comments already claim — and the round-1 design for it was wrong in four ways"
document_type: ticket
status: completed
created: 2026-09-17
task_class: database-sync
governing_docs: [docs/governance/GOVERNANCE_INDEX.md, docs/governance/standards/ARCHITECTURE_STANDARD.md, docs/governance/standards/TESTING_STANDARD.md, docs/governance/constitution/CONSTITUTION.md]
depends_on: "T203 (PR #469) shipped the bounded write timeout — decisions 1 and 2 of docs/adr/2026-09-17-bounded-write-timeout-and-days-of-operation-uniqueness.md. Decision 3 was split out into this ticket after its round-1 implementation failed review four distinct ways. See that ADR's Amendment 2."
archive_when: "days_of_operation cannot hold two rows for the same (camp_id, weekday) through any path — interactive write, importer, bootstrap retry, or CRDT merge — the four round-1 defects below are each closed or explicitly dismissed with reasoning, the premise in section 1 has been checked rather than assumed, fixtures are driven through the real write path, and `npm run verify` is green"
---

# T205 — the days_of_operation UNIQUE constraint, re-derived rather than ported

Round 1 of T203 built this and it did not work. **Nothing below is a conclusion to build on.** The
round-1 design is recorded here so it is not re-derived from scratch, and its defects are recorded so
they are not repeated. Treat the whole of it as suspect.

## 1. The premise to CHECK FIRST — everything else depends on it

Architect asserted, after round 1's review, that duplicate `days_of_operation` rows arise from
**ordinary multi-device onboarding** rather than only from the T203 hang. **This is unverified.**

It is the first thing to establish, because it decides the shape of the whole ticket:

- If it is **true**, the migration's dedupe/delete/repoint branch is a routine path that will run
  against real director data on real machines, and defect 3 below is live data loss.
- If it is **false** — duplicates could until now only arise from a race that required an unbounded
  hang, which T203 has since bounded — the delete branch is close to dead code in practice, and the
  ticket is mostly about making a constraint hold going forward.

Check it against the code and against what a second device actually does on join; do not settle it by
argument. Report which it is before designing the migration.

## 2. What the round-1 design was

`UNIQUE(camp_id, day_of_week)` on `days_of_operation`, as schema v66, following the
`idx_cohorts_camp_name` (v11) and `idx_groups_camp_name` (v12) precedents: dedupe survivors by
`MIN(rowid)`, repoint referencing rows onto the survivor, delete the losers, create the index. Motive
unchanged and still valid: `cohorts` already has the equivalent constraint, and two comments
(`electron/db/schema.sql` near the `time_blocks` definition, `electron/db/localDb.js`'s Round-2 Red
Hat comment) **already claim `days_of_operation` has one when it does not** — flagged by
`src/utils/seedDays.js`'s header TODO, which is still there and still accurate.

## 3. The four confirmed defects — each verified against the code in round 1

1. **The constraint is inert where it was supposed to fire.**
   `electron/ops/projections.js`'s `days_of_operation.ensureExists` creates the row with only
   `(id, camp_id, label='')` — `day_of_week` is **NULL at row creation**. SQLite treats NULLs as
   distinct from every value including other NULLs, so a retry's row creation never collides. The
   collision instead lands on the *later* `day_of_week` field write, and `seedDays` throws
   `write failed for field "day_of_week"`, leaving a torn row with `camp_id` and `label` set and
   `day_of_week` NULL. That row is then **permanent and invisible**: `seedDays`'s repair matcher is
   `days.find(d => d.day_of_week === day.day_of_week)`, which can never match a NULL-day row, and the
   round-1 dedupe filtered `WHERE day_of_week IS NOT NULL`, so it could not see it either.
   Note the structural asymmetry the round-1 per-caller table missed: **`cohorts` is safe only
   because its unique key (`name`) IS the field `ensureExists` stamps at creation.**
   `days_of_operation`'s unique key is a field written separately, afterwards. Any design that does
   not reckon with that difference will reproduce this defect.

2. **`days_of_operation` was constrained but never registered in `UNIQUE_FIELD_ENTITIES`**
   (`electron/ops/operations.js`). Every other camp-scoped UNIQUE table is registered there so a
   collision becomes a typed, director-resolvable conflict instead of a raw
   `SQLITE_CONSTRAINT_UNIQUE`. Without it, a legitimate cross-device concurrent edit throws inside
   the CRDT merge's projection apply; `projectAndNotify` catches it and the shared transaction rolls
   back, so **every** entity's projection silently stops advancing on that device — with only a
   `console.error`. Adding the constraint without the registration is not optional.

3. **The migration never repointed `template_slots.day_id` — live data loss.**
   `electron/db/schema.sql` declares it `day_id TEXT` with **no `REFERENCES` clause**, so it dropped
   out of three separate enumerations (Maker's, Code Reviewer's and Architect's) that were all built
   by grepping for `REFERENCES days_of_operation`. It holds day ids regardless, and the v12 `groups`
   precedent the migration claimed to follow exactly **does** repoint `template_slots.group_id`.
   As written, deduping a day silently orphaned every scheduled slot on it — the director's actual
   schedule. **Enumerate references by what a column HOLDS, not by what it declares.**

4. **The domain-state sync guard is one-launch-only.** `electron/db/localDb.js` records the migration
   span in a per-process `WeakMap`; on the next launch `from === to`, `domainStateMigrationsIn`
   returns `[]`, and `electron/main.js`'s guard silently stops applying. A plain app restart
   therefore re-enables sync against a document that still holds the rows the migration deleted from
   SQLite, and `projectAll`'s delete-reconcile resurrects them. Any migration here that deletes rows
   is the **first domain-state migration above v52** and makes this latent hazard reachable. It is
   also invisible to the director (`console.error` plus an audit row nothing reads). Decide
   deliberately whether this ticket fixes the guard, avoids needing it (e.g. by routing the dedupe
   through the document so SQLite and the document never diverge), or escalates it.

## 4. Required change of METHOD, not just of code

This is the most valuable thing round 1 produced and it is a requirement, not a footnote.

**Round 1's tests were all green — 106/106 on the migration suite — and the change did not work.**
Every migration fixture was hand-built with raw `INSERT`s that supplied `day_of_week` directly,
rather than driven through the real write path. So the suite proved that an index behaves like an
index, and was structurally incapable of catching defect 1, which lives in how rows are actually
created.

Therefore, for this ticket:

- **Fixtures must be built by driving the real write path** (`ensureExists` / `applyProjection` /
  `localClient.write` as the app uses them), not by hand-writing the desired end state. Where a raw
  `INSERT` is genuinely necessary, say why in the test.
- There must be a test that **plants the actual scenario**: a timed-out-but-landed write followed by
  a retry, asserting exactly one surviving row for that weekday.
- Plant defects the guard is **not** designed for, per this repo's standing lesson — a non-vacuity
  test that plants only the defect you designed for proves nothing. Round 1's dedupe test planted
  only `(1, 1)` duplicates with `day_of_week` already set; the NULL-day orphan it actually produces
  was never planted.
- Every new test: revert the change, confirm red, restore. Report per test, and state "passes either
  way" plainly rather than counting it as coverage.

## 5. Governance

`database-sync`: migration/rollback plan and the **mandatory integration gate**, plus fresh-vs-
migrated schema equivalence. ADR required — amend
`docs/adr/2026-09-17-bounded-write-timeout-and-days-of-operation-uniqueness.md` or supersede it with
a new one, and do not carry its decision 3 forward unexamined; Amendment 2 there records why it was
withdrawn. If the migration would have to destroy rows a camp needs in order to apply, that is an
owner decision — stop and ask.

## 6. Closure audit (2026-09-23) — every `archive_when` clause checked against the tree

Shipped as a2d9721 (schema v70, PR #504). This section records the independent re-verification
against the tree at 3b4aa0a, clause by clause, because `archive_when` here is unusually wide and
several clauses exist precisely to stop someone assuming rather than checking.

**Uniqueness through every path.** Both enforcement mechanisms are present, and the asymmetry this
repo keeps tripping over is handled and documented: `electron/db/schema.sql:669` declares
`UNIQUE(camp_id, day_of_week)` inline, which — because the whole file is `CREATE TABLE IF NOT
EXISTS` — binds **brand-new installs only**; already-existing dbs are enforced by
`CREATE UNIQUE INDEX ... idx_days_of_operation_camp_day` at `electron/db/localDb.js:3000`. The
schema file states this caveat in-place (`schema.sql:671-676`), matching the cohorts/groups
precedent.

**Premise (§1) — genuinely checked, not assumed.** ADR Amendment 3 records the verdict as **TRUE**
with a mechanism different from the one originally analyzed: a Host's un-awaited `seedDays` racing
an immediate second-device invite on a brand-new camp. So the dedupe/repoint branch is a routine
path against real director data, not near-dead code — which is why defect 3 was live data loss.

**The four defects (§3) — all CLOSED**, each traced through code rather than taken from the commit
message: (1) `day_of_week` is stamped in the same INSERT via `parseDayOfWeek`
(`electron/ops/projections.js:187-206`), with ids minted by `deriveDayId` in both `seedDays`
(`src/utils/seedDays.js:54`) and the importer (`electron/ops/ingest.js:1379-1385`); (2) registered
in `UNIQUE_FIELD_ENTITIES` (`electron/ops/operations.js:593`) with cross-registry drift blocked by
`electron/uniqueFirstFieldRegistryParity.test.js`; (3) all **four** `day_id`-holding columns
repointed (`localDb.js:2938-2944`) — `template_slots`, `anchor_activities`, `elective_sets`,
`elective_occurrences`, two of which declare no FK, which is exactly how round 1's grep-based
enumerations missed them; (4) the one-launch-only guard is now restart-durable via the
`domain_state_migration_pending` marker and, critically, *resolvable* — `main.js:2843-2861` runs
`resolvePendingDomainStateMigrations` before deciding to refuse, so it cannot deadlock a device.

**Method (§4) — met.** `electron/db/daysOfOperationDedup.migration.test.js` builds fixtures by
driving `applyProjection` (what `appendOp` actually calls), states in-test why each raw `INSERT` is
necessary, plants the timed-out-write-then-retry scenario, and plants the NULL-day orphan in both
directions — the defect round 1 was structurally incapable of catching.

**Gate.** CI `gate.yml` conclusion `success` at `3b4aa0a`. Note the known blind spot: CI
shallow-clones, so the status-drift check is **skipped** there — which is why this ticket sat at
`status: open` after its own implementation merged, and why the flip is being made by hand here.

### Scoped OUT, deliberately — not a narrowing of this ticket's condition

A merge-path collision between two records holding the same weekday under **different** ids is
caught by the per-row `SAVEPOINT` in `electron/automerge/projector.js:489` and recorded to
`projection_failures` — so the table genuinely cannot hold two rows, and defect 2's catastrophic
form (a raw `SQLITE_CONSTRAINT_UNIQUE` rolling back `projectAll`'s shared transaction and freezing
every entity's projection) is closed. But the losing row is *silently skipped* rather than surfaced
as the typed, director-resolvable conflict the `UNIQUE_FIELD_ENTITIES` registration promises:
`detectUniqueFieldCollision` is invoked only from `electron/sync/localWriteClient.js:102` and
`electron/ops/restore.js:262`, never from the projector's merge-apply path.

This is **repo-wide and predates T205** — it is equally true of `locations`, `activities`, `events`
and `elective_sets`, every entity in that registry — so closing it is not this ticket's job and
holding T205 open for it would misattribute an architectural gap to a weekday constraint. Spun off
rather than absorbed. The reachable trigger worth naming for that ticket: `useCrudScreen`'s generic
add (`src/hooks/useCrudScreen.js:57`) and `DaysScreen`'s own import (`src/screens/DaysScreen.jsx:209`)
both mint `crypto.randomUUID()`, so the deterministic-id convergence that protects the seed and
importer paths does not cover an interactive create.
