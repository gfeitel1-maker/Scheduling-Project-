---
title: "A rollback module that is not the rollback it names"
document_type: ticket
status: in-progress
created: 2026-09-26
archive_when: Every file matching electron/db/rollback/vN_down.js is checked by an automated gate that its exported function name, its CLI self-guard filename literal, its Usage line, and the version in its schema_migrations DELETE all agree with N in its own filename - and the gate is shown red by each of four planted defects - a wrong export name, a CLI guard naming a different file, a correct export name whose DELETE targets a different version, and a new module using the retired down(dbPath) convention - with electron/db/rollback/v67_down.js corrected to export rollbackV67 and guard on v67_down.js
governing_docs: [docs/governance/constitution/CONSTITUTION.md, docs/governance/standards/ARCHITECTURE_STANDARD.md, docs/governance/standards/TESTING_STANDARD.md]
related_adrs: [docs/adr/2026-09-26-ingest-category-exclusivity-and-anchor-identity.md]
related_tickets: [docs/work/tickets/T266-ingest-pass-exclusivity.md]
---

# T269 — A rollback module that is not the rollback it names

## The shape of this defect

This is the same shape as the finding that produced
`docs/adr/2026-09-26-ingest-category-exclusivity-and-anchor-identity.md`: **a guard whose success
condition is not the system's success condition.** That ADR's case was a comment asserting exclusion
over code performing demotion. This one is a guard asserting "the rollback modules are checked" over
a scan that can only see one SQL clause. It is cited, not re-litigated.

## The durable defect

`electron/db/rollback/bareEqualityRollback.guard.test.js` scans every `vN_down.js` for the
`DELETE FROM schema_migrations WHERE version >= N` shape. It is a correct and valuable guard. It is
also **structurally incapable** of seeing whether a module is the rollback it claims to be — its
export name, its CLI self-guard, its documented usage, and the version it actually targets are all
outside what it reads. Its green reads to the next person as "the rollback modules are checked,"
over a surface it never scanned.

## Confirmed instances (verified by opening every file in the directory at 8414c385)

**`electron/db/rollback/v67_down.js` — live on main.** Exports `rollbackV66` (copy-paste from
`v66_down.js`), its CLI self-guard tests `process.argv[1].endsWith('v66_down.js')`, and both its
`// Usage:` comment and its `usage:` error string name `v66_down.js`. Its
`DELETE FROM schema_migrations WHERE version >= 67` is correct, so the *logic* is v67's; only its
*identity* is v66's. Consequence: `node electron/db/rollback/v67_down.js <db>` is a **silent
no-op** — the guard is false, nothing runs, exit 0. It has no test file and **no importers**, so
correcting the export name breaks no caller. This is a correction of dead code, not a behaviour
change.

**The near-miss that prompted the ticket.** T266 shipped `v75_down.js` exporting `rollbackV75`
while an in-flight branch was independently using that same export name for unrelated
rename-reversal logic. Caught by a human reading the file. On `main` at 8414c385 that collision is
resolved and all four implicated test files (`anchorEventLocation.migration.test.js`,
`anchorKindSplit.migration.test.js`, `anchorRecurrence.migration.test.js`,
`v71_down.test.js`) import the function matching their target version. **Reported as a live defect;
found already clean in the tree. The code won.**

## The convention decision, which must precede the check

A consistency guard can only enforce a *stated* convention, and this directory has two. Stating
which is normative is therefore part of this ticket, in words, so that the rule lives in the ticket
and the guard merely enforces it — rather than the rule existing only inside the guard, which is the
defect being fixed.

| Form | Count | Files |
|---|---|---|
| `export function rollbackVN(db)` — takes an **open handle** | 34 | `v24`–`v76` excluding the two below |
| `export function down(dbPath)` — takes a **path**, opens and closes its own db | 2 | `v62_down.js:10`, `v64_down.js:11` |

**Decision: `export function rollbackVN(db)` is normative. Confidence: high.**

The count (34:2) is the weakest of the reasons and is not the argument. The argument is that the
handle form is the only one that works:

1. **Testability.** Over thirty `*.migration.test.js` files open a temp db, migrate it, call
   `rollbackVN(db)`, and inspect the same handle. The path form cannot participate: it closes the
   db it opened. `v62_down.js` and `v64_down.js` have **no tests at all**, and that is not a
   coincidence — it is the contract preventing them.
2. **Composability.** `electiveRunLifecycle.migration.test.js:224-225` walks a db down two versions
   by calling `rollbackV74(db)` then `rollbackV73(db)` on one handle. The path form cannot be
   chained inside a transaction or a single fixture.
3. **The CLI argument for the path form does not survive contact with the files.** Taking a path
   looks like the safer contract for a command-line tool — but neither `v62_down.js` nor
   `v64_down.js` has a CLI invocation block, so neither is runnable from the command line at all,
   and neither sets `foreign_keys = ON`. The handle-form modules solve CLI lifecycle with the
   `import.meta` block that opens the db, sets the pragma, calls, and closes. The path form's
   supposed advantage is unexercised; the handle form's is exercised 34 times.
4. **Zero importers.** Nothing in `electron/`, `src/`, `scripts/` or `test/` imports `v62_down.js`
   or `v64_down.js`. The `down(dbPath)` form was never consumed by anything.

**Disposition of the two non-conforming modules: exempted by explicit name, not converted.**
Converting them is a signature change to working (if unexercised) code, needs its own tests, and
exceeds this ticket. They are listed in the guard by literal filename with the reason inline, so the
exemption is *visible*. A tolerant pattern — accepting either form anywhere — would silently
tolerate the class and is the thing to avoid. Because the legacy set is **closed and enumerated**,
the guard can distinguish "deliberately uses the retired convention" from "meant to use the current
one and got it wrong": anything not on the two-name list must use `rollbackVN(db)`.

Follow-up, not this ticket: convert or delete `v62_down.js`/`v64_down.js`.

## Success predicate

A rollback module whose exported function name, CLI self-guard filename, documented usage, or
targeted version disagree with its own filename **fails the gate**, naming the file and the
mismatch. `v67_down.js` is corrected.

## Non-goals

- No redesign of the rollback system.
- No new rollback modules for versions that lack one. **`v72` has no `v72_down.js`.** The guard
  checks *consistency of what exists*, never *completeness of the set*. Completeness is handed up
  as a finding, not decided here.
- No change to `v77_down.js` semantics (T267, in flight).
- No conversion of `v62_down.js` / `v64_down.js`.

## Stated limits of the new guard

Recorded next to the green deliberately, because a pass that implies more coverage than it has is
this ticket's own subject matter:

- It is **static**. It reads source text; it does not execute a rollback.
- It **cannot** detect a module that is internally consistent but whose *body* performs another
  version's work — semantically duplicated logic under a correct name. A normalized body-identity
  check catches only a verbatim duplicate, not a paraphrased one.
- It does not verify that `vN_down.js` actually inverts migration `vN` in `localDb.js`.
- It **does not read prose rationale**, and a copy-pasted rationale can name the wrong version while
  every scanned shape is correct. This is not hypothetical: `v67_down.js`'s in-body comment
  explaining its `>= 67` DELETE was itself a v66 leftover, arguing about v66/v65 and citing the v66
  migration's guard. Found by a human reading the file during this ticket and corrected here — the
  guard did not and could not see it. Prose is checked by review, not by this gate.
