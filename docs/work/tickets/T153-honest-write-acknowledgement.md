---
title: "A write says whether the authoritative copy has it"
document_type: ticket
status: completed
created: 2026-09-13
task_class: database-sync
governing_docs: [docs/governance/GOVERNANCE_INDEX.md]
archive_when: a write result distinguishes reaching SQLite from reaching the document, a buffered write is never reported as a completed one, and a director can see that this computer holds changes the shared copy does not
---

# T153 — A write says whether the authoritative copy has it

From the external architecture review of 2026-09-13 (item 1), the half T148
deliberately left open. T148 made every way a write can miss the document
**recorded**; this makes it **acknowledged**.

The invariant the review asked for: *a user-visible successful mutation must
imply the authoritative state contains it, or the application must explicitly
know it has not yet become durable.* The second clause is the reachable one, and
it is what this implements.

## What "applied" meant

`{ status: 'applied' }` has always meant "this device's SQLite has it". Under the
current authority model that is a different claim from "the camp has it". Nothing
in the reply distinguished them, and the sidebar's offline copy actively said the
wrong thing — *"your changes are saved here and will reach it when it is back"* —
which is true of an ordinary disconnection and false of a write the document
never received.

## What changed

- The op carries `DOCUMENT_OUTCOME` (a Symbol, so it cannot silently widen the
  wire payloads the op is spread into): `applied`, `failed`, `deferred`,
  `not-modeled`, `engine-off`. `localWriteClient` surfaces it as `document` on
  the write reply.
- **`deferred` is its own answer.** Inside `runAtomic` the document is
  deliberately not written until the outermost transaction commits, so the
  outcome is genuinely unknown at that moment. Reporting it as success would be
  the same collapse this ticket exists to undo.
- `getSyncStatus` reports `unsharedWrites`, on **every** state including
  standalone and host — this is not a connectivity fact. A lone device with a
  failed document write is diverged from the camp whether or not anyone is
  reachable.
- `syncStatusLabel` lets that count **override** the connection label, in the
  same one-line slot beside Devices that every other sync state uses. Not a
  banner, per the standing rule.

## What `applied` honestly means, and what it does not

It means the in-memory authoritative document has the write. Durability is the
debounced save, which happens later and can fail on its own — that is the
architecture, not an oversight, and the failure is recorded (T148) and counted
here. The write path cannot promise more without a synchronous fsync per field
op, which a bulk import does not survive.

## A masked failure found while measuring this

`withRetry` re-invoked `applyLocalWriteNow`, which is not idempotent. On a first
attempt that seeded the document and then failed to save it, the retry found the
document already cached, took the `seeding = false` path, **skipped the save
entirely, and returned success** — logging "succeeded on attempt 2 after a
transient failure" for a failure that was neither transient nor survived. The
seed save now rolls the registry back before rethrowing, so each attempt starts
from the same state. Retrying is only honest if that is true.
