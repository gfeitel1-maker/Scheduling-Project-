---
title: "Comments stop describing the deleted WebSocket Host as if it were the live write path"
document_type: ticket
status: completed
created: 2026-09-29
task_class: documentation-governance
governing_docs: [docs/governance/constitution/CONSTITUTION.md]
related_tickets: [docs/work/tickets/T309-op-log-import-write-cost.md]
archive_when: "no comment in electron/ or src/ names syncServer.js, syncClient.js, handleSubmitOp or the submit_op/op_applied/full_sync/sendMissedOps vocabulary as a LIVE mechanism, and the findings this sweep surfaced are recorded on the board for the owner to choose from"
---

# T311 — Comments stop describing the deleted WebSocket Host as if it were the live write path

## The defect

The Stage 6c cutover deleted `electron/sync/syncServer.js` and `electron/sync/syncClient.js`.
Comments across the op-log, auth, db and sync layers went on describing that transport in the
present tense. `find electron -iname "syncServer*"` returns nothing; `handleSubmitOp` survives only
in prose.

This is worse than ordinary comment rot in one specific place. Nine of the sites sit in
`electron/ops/operations.js`, on `appendOp` — the choke point every mutation in the app passes
through (graphify `god-nodes` ranks it 3rd, 105 edges). They assert a SECOND top-level caller that
does not exist:

> this covers BOTH write() (the no-serverUrl client above) and the Host's WS submit_op path
> (syncServer.js's handleSubmitOp), which both call appendOp.

Anyone reasoning about `appendOp`'s caller census is told there are two entry points when there is
one. T309 had to establish that census to size a performance change, and hit this directly.

## What is actually true

`appendOp` is a **local-write primitive only**. Every caller is a first-party committer on this
device: `localWriteClient.js`'s `write()` behind the IPC surface, plus the typed committers
(`ingest.js`, `deleteRecord.js`, `restore.js`, `duplicateWeek.js`, `promoteToAdmin.js`,
`migrationDomainState.js`, the elective committers).

A write arriving from another device never reaches `appendOp`. It arrives as a merged Automerge
document — `syncNode.js`'s `A.merge()` → `projectAll` → `electron/automerge/projector.js`, which
replays each field through `applyProjection` as a synthetic op, writing straight to SQLite. That
path inherits `applyProjection`'s guards and **not** `appendOp`'s.

## Approach

Comment- and doc-only; no behaviour change. Per CLAUDE.md's convention for text that names
something in order to say it is gone, each site is **re-described rather than deleted** — the
reasoning these comments carry is usually still valid and only the mechanism is retired. The
retired mechanism is marked historical (`_Prior:`), and where a live path exists it is named.
Where a claim is simply **void** now, the comment says so rather than dropping the sentence.

`operations.js` carries one canonical retired-mechanism note after its imports; its other sites
refer back to it instead of repeating the explanation nine times.

## Found on the way — NOT fixed here, and NOT ticketed

**These are recorded as ONE board item, `h-t311-followups`, owner-gated.** Per the owner's standing
scope-discipline rule (board item `i-standing-scope-discipline`, 2026-09-25), a finding discovered
mid-ticket is recorded for the owner to choose from, never dispatched as its own stream. They are
listed below because the comments that used to hide them now name them — not as a work queue.

Each of these is a code, schema or product change, deliberately kept off a comment sweep. They are
recorded because the comments that used to hide them now name them.

1. **`MAX_FIELD_VALUE_LENGTH` is not enforced on the remote path.** The cap on
   `camp_maps.image_data` is read in exactly one place, `appendOp` (`operations.js`). Its comment
   claimed to be "the AUTHORITATIVE gate ... so a compromised or buggy paired device cannot bypass
   it". Since the remote path no longer passes through `appendOp`, an oversized `image_data` inside
   a merged document is projected without the check. **Security-relevant; needs its own ticket.**

   The chain, each link read in the file rather than inferred: `MAX_FIELD_VALUE_LENGTH` has ONE
   reader, `operations.js:215` inside `appendOp` (its only other non-test mention is a comment in
   `projections.js`); `camp_maps` IS modeled in the document (`campDocument.js`) and `image_data` IS
   in its projection field list (`projections.js`); and `projector.js` writes SQLite generically
   through `PROJECTIONS`, states "never through appendOp" in its own header, and carries no length
   check of any kind. Confirmed independently by a second session, 2026-09-29.

   **Provenance, so nobody bisects toward the wrong change: this gap is NOT caused by T309.** The
   remote path has not passed through `appendOp` since the Stage 6 cutover, and T309 changed
   `runAtomic` nesting without moving that boundary. What T309 and T311 did was remove the comment
   that was hiding it.

2. **The op-log's conflict-arbitration layer is dead in production.** `recordConflict`,
   `detectConflict`, `detectBulkReplaceConflict` and `latestScopeOpSeq` have no non-test callers —
   no live code passes `based_on_seq` at all. Their replacement is the CRDT reconciler
   (`electron/automerge/reconcile.js` → `reconcileForProjection.js` → `conflictStore.js`'s
   `recordConflicts`). Two counts are worth stating exactly, because a first pass got both slightly
   wrong: `latestScopeOpSeq` LOOKS like it has one caller, but that caller is
   `detectBulkReplaceConflict` itself — dead calling dead; and `based_on_seq`'s only non-test
   occurrences are inside `detectBulkReplaceConflict`'s own signature and doc comments, so nothing
   live passes it. Confirmed independently by a second session, 2026-09-29.
   `handleSubmitBulkReplaceOp`, named in a comment as a caller, never existed
   anywhere else in the repo.

   **2026-09-30 — finding (2) is discharged.** All four functions are deleted from
   `electron/ops/operations.js`, the tests that exercised only them are removed, the
   `listPendingConflicts` coverage they fixtured is re-expressed and still green, and the comments
   naming them are rewritten or marked historical. Evidence, per-test disposition and three
   remaining out-of-scope citation sites:
   `docs/work/runs/2026-09-30-sweeps-d-t311-dead-conflict-layer.md`.

3. **TWO vestigial tables, not one.** `electron/sync/pendingRestores.js` is a vestige: its drainer
   was `syncClient.js`.
   `insertPendingRestore` has no caller outside tests, so nothing enqueues and nothing drains;
   `main.js` imports only `listPendingRestores`, which can now only return rows written by a
   pre-cutover build. The `pending_restores` table is in the same position.

   `pending_writes` is the same shape and was found late, by widening the census vocabulary rather
   than by reading: its schema comment still described it as "durable backing store for syncClient's
   write queue", reloaded on `syncClient` startup and cleared by `flushQueue`. `syncClient.js` and
   `pendingWrites.js` both went at the cutover, and `grep` for `INTO pending_writes` / `FROM
   pending_writes` outside tests returns nothing — the table is still CREATEd by `localDb.js`'s
   migration and named in `purgeCollateral.js`, but has no reader or writer.
   `electron/sync/localWriteClient.js`'s header already said so ("No offline queue ... the
   `pending_writes` table ... belong to the transport that is being retired"), in the future tense.
   Dropping either table is a schema change, not a comment fix.

4. **`ingestCommit`'s HOST-ONLY gate rests on a premise that no longer holds.** It was justified
   because "an import run on a Client is invisible to the Host and every peer". `appendOp` now
   mirrors every write into the document, so an import committed on a join-mode device WOULD
   replicate. The gate plausibly still belongs — ingest reads and writes host-local tables that are
   never replicated (`source_aliases`, `compound_cell_decisions`, `location_word_decisions`,
   `declined_two_row_splits`) — but that is not the reason recorded, and restating it is a product
   judgement, not a comment fix.

## Scope, stated so the boundary is auditable

The brief's census pattern was `syncServer\.js|handleSubmitOp`, which matches 31 files under
`electron/`+`src/`. The **retired vocabulary as a whole** (`sendMissedOps`,
`sendFullSyncIfFirstPairing`, `authorizeWs`, `handleBulkReplace`, `submit_op`, `op_applied`,
`acquire_lock`, `full_sync`, `syncClient`) matches **61**. This ticket sweeps the 31, plus sibling
retired vocabulary inside comments it was already rewriting there, plus one file it points a reader
at (`pendingRestores.js`). The remaining ~30 files are a follow-up, not a claim of completeness.

**2026-10-01 — the remainder is swept.** The ~30 files this ticket left as a follow-up are done
(comment and doc prose only, zero executable change); the framing audit now reports zero UNFRAMED
comment lines outside the two excluded files, the residue being seven string literals in executable
code. Evidence, both audit tables, the live-identifier census and four findings carried forward:
`docs/work/runs/2026-10-01-retired-vocab-sweep-remainder.md`.

Deliberately untouched: `scripts/check-governance.js` and `scripts/checkDocFileRefs.test.js`, which
name `syncServer.js` as fixture data for the doc-refs gate precisely BECAUSE it does not exist;
`docs/current/PLATFORM_STATE.md`'s historical regions, which already describe the deletion
correctly.

## Two things noted while editing

- `electron/db/schema.sql` was edited with its **line count held at 1676**. Five live
  `schema.sql:NNN` citations point below the edit points (`catalogRoleConflict.test.js`,
  `localDb.js`, `src/localClient.mock.js`, `buildOfferings.js`, `slotCellConstants.js`); shifting
  lines would have silently invalidated them.
- Two pre-existing truncated words in `electron/ops/projections.js` (`inside tha`, `reply, agains`)
  fall inside rewritten blocks and are corrected as a side effect.
- `main.js`'s local variable `syncClient` is bound to `createLocalWriteClient`, NOT to the deleted
  module. Comments naming `syncClient.write` describe live code and were left as such; only the
  reasoning attached to them was stale. Renaming the variable is out of scope.
