---
title: "Every way a write can miss the document leaves a durable trace"
document_type: ticket
status: completed
created: 2026-09-13
task_class: database-sync
governing_docs: [docs/governance/GOVERNANCE_INDEX.md]
related_adrs: [docs/adr/2026-09-06-productionize-automerge-libp2p-sync.md]
archive_when: a write that reaches SQLite but not the authoritative document is recorded in every path that can produce one — in-memory apply, bulk-replace, the debounced save, and a merge that will not project
---

# T148 — Every way a write can miss the document leaves a durable trace

From the external architecture review of 2026-09-13 (item 1), after tracing the
write lifecycle. See
`docs/work/architecture-reports/2026-09-13-external-authority-review-response.md`.

The review's concern — SQLite commits, the document write fails, the UI says it
worked — is real and was already known and recorded
(`electron/ops/documentWriteFailures.js` says so in its own header). What the
review did not name are three sibling paths that produced the SAME divergence
with **no** record at all:

1. **The debounced save.** `flushPendingWrites` called `saveDoc` with no
   try/catch. A disk error threw inside a `setTimeout` callback — an uncaught
   main-process exception — and every write in the 250 ms window was missing
   from the file with the op ids already discarded.
2. **`appendBulkReplaceOp`.** Its document dual-write failure was a
   `console.error` and nothing else. This is the highest-volume write the app
   makes: one op carries a whole regenerated schedule.
3. **The mirror direction.** `syncNode`'s `onProjectionError` — a merged
   document that will not project, leaving SQLite *behind* the authoritative
   document — was never wired to anything in production. It existed only in a
   test. `PLATFORM_STATE.md` had already flagged this as suspicious; it is
   confirmed.

## What changed

- `scheduleSave` now carries the op ids in flight for the window;
  `flushPendingWrites` contains a save failure and records each of them in the
  existing `store='document'` ledger. One camp's failure never skips another's
  save or broadcast.
- `appendBulkReplaceOp` records its document failure against the bulk op's id.
- `onProjectionError` is wired to the device audit log. `projection_failures`
  cannot hold it (its primary key is an op id; a merge has no op), so it goes
  where support can still read it.
- `check_projection_health` reports the new `syncHealthEvents` alongside the two
  existing failure kinds — a durable trace is only worth having if something
  surfaces it.

## What this deliberately does NOT do

It does not make the write path document-first, and it does not yet tell the
renderer that a write was not durable. See T153 for the second; the first was
considered and rejected in the review response (a document cannot be rolled
back, so document-first converts a recorded, bounded loss into an unbounded one).
