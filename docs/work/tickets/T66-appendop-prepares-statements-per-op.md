---
title: T66-appendop-prepares-statements-per-op
document_type: ticket
status: completed
created: 2026-08-07
task_class: database-sync
governing_docs: [docs/governance/GOVERNANCE_INDEX.md, docs/governance/standards/ARCHITECTURE_STANDARD.md, docs/governance/standards/TESTING_STANDARD.md]
related_tickets: [docs/work/tickets/T61-replace-ingest-atomic-transaction.md]
related_adrs: [docs/adr/2026-07-30-deleting-a-record-a-schedule-uses.md]
related_specs: [docs/work/specs/S-replace-ingest-atomic-transaction.md]
archive_when: a multi-hundred-op transaction (Replace ingest, or a delete of a record a full schedule uses) completes fast enough that the Host does not visibly stall, with a wall-clock test proving it
---

# T66 — `appendOp` re-prepares its statements on every single op

**Raised:** 2026-08-07, during T61 implementation. Measured, not estimated.

## The problem

`electron/ops/operations.js`'s `appendOp` issues roughly four `db.prepare()` calls per op,
at about 1.3 ms each. Because every mutation in this app is an op, the cost is paid by
every multi-op write path in the codebase.

Measured during T61:

- **~15 ms of blocked main thread per row.**
- A 400-group camp with a full five-day schedule — about 2400 ops — took **37 seconds**.

The cost is entirely in statement preparation, not in the writes themselves. `replaceScope`
adds no per-row work beyond one enumerating `SELECT` per table.

## Why it matters operationally

better-sqlite3 transactions are synchronous on the single main-process thread, which also
serves every IPC handler and, in Host mode, the whole `syncServer.js` message loop. For the
duration:

- The director sees an unprogressed `working` state with no feedback.
- **Every connected staff device sees the Host stall.**

This is not specific to ingest. `deleteRecord.js` shares the same path and the same
exposure — deleting a record that a full schedule uses is the other realistic way to reach
several hundred ops in one transaction.

## What to build

Prepare each statement **once per transaction** (or once per process, cached on the `db`
handle) rather than once per op. better-sqlite3 statements are reusable and this is the
library's intended usage.

Do **not** attempt to fix this by chunking the transaction. Atomicity is the entire point of
T61 and of `deleteRecord.js`; a chunked write forfeits it.

## Definition of done

- `appendOp` prepares no statement more than once per transaction.
- The T61 perf gate in `electron/ops/ingest.test.js` ("finishes a 400-group camp inside the
  wall-clock budget") is tightened to reflect the new floor, so the improvement cannot
  silently regress. It currently runs at ~1.4 s against a 15 s budget on a reduced 400-row
  fixture.
- A test covers the full-schedule scale that motivated this ticket (~2400 ops), with a
  budget that would have failed at 37 s.
- Op-log semantics are **unchanged**: same rows, same ordering, same `client_write_id`
  idempotency, same replication behaviour. This is a performance change only, and the
  existing suite is the guard.

## Notes

- Test-first. This is a data seam under `TESTING_STANDARD.md`.
- `npm rebuild better-sqlite3` before `npm run test`.
