---
title: "A hundred-camper import stops paying for a rollback boundary it already has"
document_type: ticket
status: completed
created: 2026-09-29
task_class: database-sync
governing_docs: [docs/governance/constitution/CONSTITUTION.md, docs/governance/standards/TESTING_STANDARD.md]
related_adrs: [docs/adr/2026-09-29-per-op-savepoint-inside-an-atomic-boundary.md]
related_tickets: [docs/work/tickets/T226-camper-preference-import.md]
archive_when: "committing the 100-camper preference sheet costs materially less CPU than it does today, with appendOp's atomicity unchanged at the top level, no change to op-log semantics (entity/field granularity, idempotent client_write_id retries, Trash/Restore/history/ingest-undo), and a structural guard that fails if a write path catches an appendOp throw inside a runAtomic body"
---

# T309 — A hundred-camper import stops paying for a rollback boundary it already has

## What a director hits — and how much, corrected

They import a 100-camper ranked-preference sheet. The main thread blocks for the whole commit —
and in Electron the main process is also serving IPC, so every screen is frozen and, in a paired
camp, every connected staff device is waiting too. `electron/ops/stmtCache.js`'s own header already
records this as a known harm (T66): a 400-group camp once blocked for 37 seconds.

**But the size of the harm was overstated by more than an order of magnitude, and that correction
belongs at the top of this ticket rather than buried in it.** The brief opened with "a director
importing 100 campers waits ~30s on a blocked main thread." On a QUIET machine the same commit takes
**1.6 s**, and 0.7 s after this change. The ~30 s came from a measuring machine saturated by ~211
concurrent `vitest` processes from other sessions. Same for the `10,955 ms` the brief cites for
`scripts/mcp/preferenceSheetE2E.test.js`: quiet, that commit is 1,887 ms before and 791 ms after.

This change is still worth making — it roughly halves the cost of the choke point every mutation in
the app goes through, and the saving scales with op count, so a 300-camper sheet gains three times
as much. But it is a **2× on a 1.6 s operation**, not a rescue from a 30 s freeze, and nobody should
plan the next piece of work believing otherwise.

## What is actually true, measured

### On a quiet machine (load ~11) — the director's reality

Interleaved before/after/before/after/before/after, swapping only `electron/ops/operations.js`.
Wall/CPU ratio held at ~1.0, which is what says this is genuinely CPU-bound work rather than a
scheduling artifact.

| | wall | CPU | µs/op |
|---|---|---|---|
| before | 1634 / 1624 / 2074 ms | 1551 / 1566 / 1782 ms | ~183 |
| after | 617 / 728 / 1099 ms | 652 / 740 / 773 ms | ~84 |

**−55% wall, −53% CPU.** End to end through vitest, `'commits the sheet and writes exactly the rows
the fixture describes'` runs in **1,067 ms**, comfortably inside the 20 s default; the MCP stdio E2E
commit goes 1,887 ms → 791 ms.

### Under saturation (load 430–550) — how this was first found

Measured 2026-09-29 in this worktree, through `runPreferenceSheetCli` against the real
`docs/work/specs/samples/fabricated-camper-preferences-100.csv`, on a machine **saturated by ~211
concurrent vitest processes from other sessions (load average 430–550)**. That saturation is why
every number below is **CPU time (`process.cpuUsage()`, user+sys)** and not wall clock: wall clock
for the identical workload swung between 11s and 38s run to run, while CPU time held within ±10%.

The commit writes **8,564 field-level op rows** (1,000 `elective_preferences` × 8 fields, 100
campers × 5, 18 choices × 3, plus the run).

Arms were run **interleaved** (before/after/before/after/before/after in one shell, swapping only
`electron/ops/operations.js`) so that drift in machine load hits both equally — an earlier
non-interleaved sweep is exactly how the "super-linear" claim below got manufactured.

| | CPU for the whole commit | wall | µs/op |
|---|---|---|---|
| before | 2461 / 2469 / 2417 ms | 14.0 / 14.9 / 14.0 s | ~286 |
| after | 1031 / 1018 / 1021 ms | 6.3 / 6.4 / 6.5 s | ~119 |

**−58% CPU and −55% wall, with no overlap between the arms across three pairs.** CPU and wall agree
and the wall/CPU ratio held steady at ~6 throughout, which is what says the machine was in the same
state for both arms rather than the result being a scheduling accident.

### Root cause

`appendOp` wraps every single op in `db.transaction(() => …)`. Inside `runAtomic`'s outer
transaction, better-sqlite3 issues that as a nested **SAVEPOINT**. Holding a savepoint open makes
SQLite maintain sub-journal undo records for every write that happens inside it, so the cost is
paid by the whole import, not just by the savepoint statements.

This is **not** a statement-preparation cost and cannot be cached away. Replacing
`db.transaction()` with `SAVEPOINT`/`RELEASE` statements routed through `getStmt` was measured and
produced **zero** improvement (2640/2889/3149 ms CPU against a 2686 ms baseline). The savepoint has
to stop being opened, not be made cheaper.

## Three premises from the original brief that did not survive measurement

Recorded because each one would have sent the work somewhere wrong.

1. **"SUPER-LINEAR in document size" — not reproduced.** Per-op CPU is flat to slightly
   *decreasing* as the document grows: 6 campers 395 µs/op, 12 → 358, 25 → 335, 50 → 345, 100 →
   313. The reported climb (2.15 → 3.60 ms/op) was wall clock on a machine whose load was rising
   during the sweep. There is no page-cache spill to fix; `PRAGMA cache_size` was tested at 2 MB,
   8 MB, 64 MB and 256 MB and made no consistent difference. Wall-clock ms/op in a clean sweep runs
   the *other* way (6.27 → 3.15) as fixed startup cost amortises.

2. **"`latestOpForEntity` in `electron/ops/restore.js` has no non-test callers" — it has three:**
   `electron/ops/ingest.js`, `electron/ops/fieldProvenance.js`, and `restore.js` itself. It does use
   a bare `db.prepare`, which is worth routing through `getStmt` for consistency with
   `stmtCache.js`'s stated contract — but doing so was measured at **no** gain on this path
   (3049/3179/3200 ms against a 2686 ms baseline). It is a tidy-up, not a fix, and this ticket does
   not claim otherwise.

3. **"likely an inline copy in `electron/ops/projections.js`" — there is none.** All five
   `SELECT value FROM operations … ORDER BY seq DESC LIMIT 1` sites in that file already call
   `getStmt`.

Also ruled out, consistent with the brief: no scrypt or key derivation on this path; at-rest
encryption defaults OFF (`SHORESH_AT_REST_ENCRYPTION`) so no page cipher is involved; no subprocess.

## One thing the harness under-measures

`runPreferenceSheetCli` prints `liveDoc: userDataDir not configured — Automerge dual-write is inert`.
Every number above is therefore **SQLite only**. In the packaged app the Automerge dual-write is
live, so the real director's import is slower than these figures, and the savepoint saving is a
floor rather than a ceiling.

## Why the savepoint is removable inside `runAtomic`, and only there

`runAtomic`'s documented contract is already that all three stores share **one** rollback boundary:
any throw inside it rolls back SQLite, the op log, and the buffered document writes together. A
per-op savepoint nested inside that boundary can only matter to a caller that **catches an
`appendOp` throw and continues while still inside the transaction** — which would be violating
`runAtomic`'s contract anyway.

Every call site was read. No such caller exists:

- `setElectivePreference.js`, `finalizeElectiveRun.js`, `attributeElectiveSubject.js`,
  `setElectiveAssignment.js`, `commitElectiveRun.js`, `deleteRecord.js` — all catch **outside**
  `runAtomic`, reporting whole-transaction failure.
- `electron/ops/ingest.js`'s two inner `try`/`catch` blocks inside `runAtomic` guard `JSON.parse`,
  not `appendOp`.
- `electron/db/migrationDomainState.js` does not catch; it inspects `appendOp`'s **return value**.
- `commitElectiveCandidates` in `electron/ops/ingest.js` **is** a genuine catch-and-continue around
  `appendOp` — and it runs **deliberately outside any transaction** (its call site says so). There
  `appendOp` is the outermost boundary and **keeps its own transaction**, unchanged.

That last case is the reason the suppression must be scoped to `runAtomic` explicitly rather than
inferred from `db.inTransaction`: top-level `appendOp` atomicity is load-bearing and stays.

**The remote-write path does not reach `appendOp` at all.** Worth stating because it is the first
place a reader will worry about, and because `appendOp`'s own doc comments still describe a
retired architecture that says otherwise. A merge arriving from another device is applied by
`electron/sync/automerge/syncNode.js` through `electron/automerge/projector.js`, which opens its own
transactions and never calls `appendOp` or `runAtomic`. The `syncServer.js` / `handleSubmitOp` "Host
WS submit_op" caller those comments name has not existed since the Stage 6c cutover. That staleness
is real and misleading but spans ~20 files, so it is spun off rather than bundled into a
performance change.

## Review findings folded in

A red-hat review extracted the first draft of the structural guard's algorithm and ran it against
planted violations. It found two blind spots, **both re-confirmed here by planting them in real
files and watching the guard stay green**, and both now fixed and re-verified red:

1. The guard matched only the literal tokens `appendOp(` / `appendBulkReplaceOp(` — but this repo's
   dominant idiom is a local alias (`write`, `remove` in `ingest.js`, `commitElectiveRun.js`,
   `finalizeElectiveRun.js`, `attributeElectiveSubject.js`). A `try { write(db, …) } catch {}` inside
   `runAtomic` passed. Aliases are now collected per file and matched as call tokens.
2. It located the callback body as "the first `{` after `runAtomic(`", which is the *parameter*
   braces for `runAtomic(db, ({ x }) => …)` and the *object literal* for a concise body like
   `attributeElectiveSubject.js`'s. It scanned the wrong span and reported nothing even for a
   direct, unaliased violation. The scan is now the whole `runAtomic( … )` call expression, found by
   paren matching.

Also noted: `electron/ops/operations.js` already carries its own module-private
`latestOpForEntity` twin of `restore.js`'s, already using `getStmt` — so the consistency argument
for the `restore.js` tidy-up was already half-true of the codebase.

## Scope

In: `appendOp` skips its inner transaction only while a `runAtomic` frame is open on that db handle.
`latestOpForEntity` routed through `getStmt` (labelled as idiom consistency, not performance).

Out: `appendBulkReplaceOp` and `applyBulkReplaceProjection` keep their own transactions — they run
once per bulk op, not per row, and no cost was measured there. `runAtomic`'s deferred-document-write
mechanism is untouched.

## Success predicate

Committing the 100-camper sheet costs materially less CPU, **and**:

- an `appendOp` throw at the top level still leaves no `operations` row and no projected row;
- an `appendOp` throw inside `runAtomic` still rolls back the entire boundary;
- a top-level catch-and-continue caller still sees the failed op leave nothing behind and the next
  op succeed;
- op-log semantics unchanged: entity/field granularity, idempotent `client_write_id` retries,
  Trash/Restore/entity history/ingest-undo;
- a structural guard fails if a write path catches an `appendOp` throw inside a `runAtomic` body;
- the full gate is green.

## Non-goals

Not making the import asynchronous or moving it off the main thread. Not batching op rows into
fewer INSERTs. Not changing op-log granularity from entity/field. Not touching any SECURITY.md
parameter — none is on this path.

## Closed

All four `archive_when` clauses discharged, landed in `c4144454` (#630) with the full gate green on
CI. Status flipped per `WORK_RECORD_STANDARD.md` §3 ("flip the ticket's status as part of the work,
in the branch that lands it") — late, in a follow-up, which is the discipline this ticket did not
follow first time.

### The 120 s override — resolved, by the session that owned it

The override was never in this tree; it was uncommitted work in a sibling worktree
(`claude/objective-babbage-980cc9`). That session was told this landed, dropped it, and reports
9/9 green at the 20 s default.

**It found a trap worth recording for anyone else holding an unmerged branch.** Its branch did not
contain `c4144454`, so removing the override *on its tree as it stood* would have reintroduced the
failure the override was compensating for. It had to merge main in and confirm the fix was actually
present before deleting the workaround. "The fix landed" is a statement about `main`, not about the
tree you are editing.

### Independent replication of the premise correction

That session re-measured its own "super-linear" claim the way this ticket describes — CPU time,
sizes interleaved one rep per round — and got **170 / 119 / 104 / 98 µs/op at 6 / 25 / 50 / 100
campers**: falling with size, the opposite of what it first reported. Its diagnosis is the clearest
statement of the failure mode in this whole investigation:

> "I measured wall clock on ASCENDING sizes while load was climbing, so 'ms/op grows with document
> size' was my loop tracking the load."

It also measured a **4.5× spread across four identical reps** of the same 8,564-op commit
(715/879/896/1013 ms CPU against 2.2/3.8/5.5/9.8 s wall at load ~426) — which is the reason this
ticket reports CPU and not seconds, and the reason no local wall-clock margin figure is recorded
next to the decision.

### Follow-on found while closing, fixed separately

`graphify affected "<symbolName>"` — a standing pre-change rule in `CLAUDE.md` — resolves to a
documentation-concept node when one shares the symbol's name, and answers about that instead. On
`appendOp` it returned 4 nodes against 169 for `"appendOp()"`. Corrected in `dd45dd96` (#633).
