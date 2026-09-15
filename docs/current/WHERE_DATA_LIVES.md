---
title: "Where data lives, and which copy wins"
document_type: reference
authority: descriptive
status: active
date: 2026-09-12
created: 2026-09-12
archive_when: never — this is a standing lookup, refreshed when the stores change
---

# Where data lives, and which copy wins

**This page exists to be looked up, not read.** Find your row, get one answer.

It was written because two careful reviewers gave *opposite* answers to "does
this change survive being saved," and neither was right. Both were describing
real code. The fact that settled it — which function runs on an ordinary save —
existed only in a grep of call sites. That is the gap this closes.

Every claim here has a **check** beside it. A claim with no check is marked as
such, honestly, rather than borrowing the confidence of the rows that have one.

---

## The three places a fact can live

| | Name | What it is | Can it be rebuilt? |
|---|---|---|---|
| **A** | **SQLite tables** | What every screen reads. The query engine. | Yes — from B |
| **B** | **The Automerge document** | One file per camp. What travels between devices. | No. This is the original. |
| **C** | **The `operations` table** | A local diary of every change this device saw. | Yes — from B, on receive |

**The one-sentence rule: B wins.** SQLite is a copy of the document, kept for
fast reading. `projectAll` makes A match B after every local change and every
incoming sync — it upserts what the document has and **deletes any row the
document does not have**. A fact that is in A but not in B is not "extra data";
it is data that is about to be removed.

`docs/adr/2026-09-06-productionize-automerge-libp2p-sync.md` §Decision states
this ("SQLite is demoted from authoritative store to a rebuildable projection").
`docs/current/PLATFORM_STATE.md` repeats it. This page is the per-row version.

---

## "Delete SQLite and rebuild from the document" — the precondition (T151)

The promise is real and is now measured as a system property, not entity by
entity: `electron/automerge/rebuildFromDocument.test.js` builds a camp through
the real write paths (an import, parent-scoped children, the bulk-replace
primitive, a tombstone), seeds a document from it, and projects into a
**genuinely empty database of the current schema**. Every modeled table comes
back identical.

It needs one thing the sentence does not say: **the fresh database must already
hold the `camps` row, with the matching id.** Document replay never creates it —
`projector.js` says so — and the projection guard rejects every `camp_id` write
whose value does not match this device's camp. Against a truly empty database
the rebuild does not degrade into a partial camp, it fails outright, which is
the better of the two behaviours and is pinned by its own test.

So the operation is: *bootstrap the camps row with the right id, then project.*
In production that row comes from `bootstrapCamp` or the join flow. **No code
path performs the full sequence today** — it is a recovery procedure a human
runs, not a feature.

**What a rebuild does not bring back:** the `operations` table is this device's
own history ledger and is not in the document (`historyLedger.js`). Trash,
Restore's prior values, and ingest-undo are lost. Per-field provenance and
authorship do survive — those live in the document.

---

## The lookup table

Counts below are computed from a fresh database, not remembered:
**50 tables — 28 synced, 1 projected-but-never-synced, 21 SQLite-only.**

| Data | Wins | Written by | If two devices disagree | Check |
|---|---|---|---|---|
| **The 27 camp entities** — groups, activities, days, time blocks, tiers, cohorts, locations, anchor_activities, schedule_templates, schedule_weeks, events, special_days, elective_sets, and the rest (`day_overrides` was the 28th and was removed entirely at schema v59, T145 — the Automerge genesis deliberately keeps an orphan empty collection for it, see PLATFORM_STATE) | **B** | `appendOp` → SQLite + `operations`, then the document. Inside a job, `runAtomic` holds the document write until the job commits. | Automerge merges; a genuine clash is recorded in `conflicts` and resolved by a human | `node -e` diff of `PROJECTIONS` vs `MODELED_ENTITIES` (see below) |
| **`template_slots`** (schedule cells) | **B**, but by *scope* not by row | `appendBulkReplaceOp` for a whole schedule; `appendOp` for one edited cell | A whole-schedule regenerate owns row existence; a single-cell edit it doesn't know about is dropped | `electron/automerge/projector.js` `deleteReconcileBulkReplaceEntity` |
| **`camps`** (the camp's own identity row) | **A**, deliberately | Created only by `bootstrapCamp` / `joinSession`. The projection **refuses** to create it. | Cannot — one camp per device | Protected by name in `deleteReconcileEntity`; `projections.js` `camps.ensureExists` throws |
| **`conflicts`** | **A** only | `conflictStore.js` | Never syncs — each device tracks its own | The computed diff below reports exactly one such entity |
| **`projection_failures`** | **A** only | `projectionRepair.js` (`store='projection'`), `documentWriteFailures.js` (`store='document'`) | Never syncs — this device's own diagnostics | The MCP tool `check_projection_health` reports both kinds separately; they need opposite remedies (replay the op-log vs re-seed the document) |
| **`operations`** (history) | **C**, derived | `appendOp` locally; `historyLedger.js` from an incoming merge | Not a sync input since Stage 6 — a record, not a mechanism | `syncNode.js` synthesizes rows *from* the merged document |
| **The 21 SQLite-only tables** — `source_aliases`, `compound_cell_decisions`, `declined_two_row_splits`, `location_word_decisions`, `open_reconciliation_decisions`, `location_migration_reviews`, `import_evidence`, `import_decisions`, `projection_failures`, `audit_events`, `login_attempts`, `host_signing_key`, `devices`, `device_identity`, `locks`, `pending_writes`, `pending_restores`, `schema_migrations`, the two migration logs, `operations` | **A**, deliberately | Direct SQL | Never syncs, by design — these are *this device's* answers, keys and bookkeeping | `appendOp` hard-throws for `source_aliases`; the rest are convention, **not enforced** |

### The computed check

Run this. It should print `conflicts` and nothing else:

```
node -e "import('./electron/ops/projections.js').then(async p => {
  const d = await import('./electron/automerge/campDocument.js')
  console.log(Object.keys(p.PROJECTIONS).filter(e => !d.MODELED_ENTITIES.has(e)))
})"
```

Anything new in that list is a table that screens can write and other devices
will never see — and that `projectAll` may delete.

---

## Where the code does NOT obey the rule

Stated plainly, because a page that quietly overclaims is worse than no page.

| Gap | What it means | Status |
|---|---|---|
| **A document write can fail on its own** | The edit is in A, not B, so it silently reverts at the next projection — or a new row disappears outright. | **Open, but no longer silent.** Now recorded durably in `projection_failures` with `store='document'`. Measured: `electron/ops/operations.loneWriteFailure.test.js`. Recording it is not preventing it. |
| **Migrations write synced tables with raw SQL** and no document write (`localDb.js` v11–v32 re-points, the v27 week backfill, `backfillLocations`) | If a document already exists, `projectAll` reverts those edits. | **Guarded (T152).** Still true of those migrations, but they are unreachable for a document-bearing camp (all are ≤ v32; a camp with a document is at v57+), every version is now classified in `migrationDomainState.js`, a new migration fails the suite until it is classified, and sync refuses to start if a domain-state migration ran against a camp that already has a document. |
| **`projectionRepair` rebuilds A from C**, not from B | Running it produces state the document disagrees with, which the next `projectAll` reverts. | **Open**, and now fenced: it scopes to `store='projection'`, so it can no longer mark a document failure resolved by replaying ops that were never the problem. Reachable only via the MCP tool with `--allow-write`. |
| **The empty-document guard is deliberately narrow** | It refuses a *totally* empty document, but a *partially* empty one passes and can delete-reconcile away whichever entities it is missing. | **Known and accepted**, stated in `projector.js`. |
| **`SHORESH_SYNC_ENGINE=oplog`** skips every document write | That device silently stops syncing while looking completely normal. Nothing on screen says which engine is running. | **Open.** Default is safe. |

### Closed 2026-09-12

**A document write failing on its own left no trace.** The op-log said the
write succeeded — for SQLite it had — so there was nothing to find afterwards,
and `repairProjectionForEntity` would have replayed those ops into SQLite,
succeeded, and marked the divergence *resolved* while the document was still
behind. Failures are now recorded with `store='document'` (schema v58) and the
projection repair/health paths scope themselves to `store='projection'`.

**A rolled-back job used to leave its writes in the document.** `appendOp` wrote
the document after its own transaction returned, believing it had committed —
but nested inside another transaction (every import, delete cascade, undo,
restore) better-sqlite3 makes that a SAVEPOINT, so nothing had committed. On
rollback, A and C were undone and B kept everything, and the next `projectAll`
wrote it back. A failed import came back.

`runAtomic` now holds document writes until the outermost transaction commits
and drops them on a throw. Check: `electron/ops/operations.transactionBoundary.test.js`
(including a structural guard that fails if a new write path opens its own
transaction) and `electron/ops/operations.flushFailure.test.js`.

---

## How to keep this page honest

The **Check** column is the point. `PLATFORM_STATE.md`'s narrative goes stale
because nothing fails when the prose and the code drift apart.

- Changing which store owns something? Change the row, and the check with it.
- Adding a table? The computed check above tells you which column you are in.
- A row whose check says *"convention, not enforced"* is telling the truth
  about itself. Do not upgrade the wording without upgrading the mechanism.

If this page and the code disagree, **the code is right and this page is a
bug** — say so, rather than reasoning from the stale text.
