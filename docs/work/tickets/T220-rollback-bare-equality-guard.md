---
title: "Rollback migrations stranding a higher schema_migrations row on bare equality — sweep plus a build-time guard"
document_type: ticket
status: closed
created: 2026-09-18
task_class: database-sync
governing_docs: [docs/governance/GOVERNANCE_INDEX.md, docs/governance/constitution/CONSTITUTION.md, docs/governance/standards/TESTING_STANDARD.md, docs/governance/standards/WORK_RECORD_STANDARD.md]
related_tickets: [docs/work/tickets/T216-gate-semantics-write-up.md, docs/work/tickets/T162-device-identity-and-token-binding.md]
archive_when: "The bare-equality sweep is complete, the guard is committed and proven non-vacuous (red on a planted defect, green after removal), and v68_down.js — merged the same morning this ticket was opened — is confirmed fixed rather than left as the counterexample that motivated the guard"
---

# T220 — Rollback migrations: bare-equality `schema_migrations` cleanup, swept and guarded

## The defect

Every rollback migration under `electron/db/rollback/` ends its transaction by removing its own row
from `schema_migrations`. The correct shape, established by `v46_down.js` and restated at
`v66_down.js` (naming v67/T162 as what exposed it there), is:

```js
db.prepare('DELETE FROM schema_migrations WHERE version >= N').run()
```

A bare `WHERE version = N` strands any **higher** version row: rolling back vN on a database that
has since migrated to vN+1 leaves `getSchemaVersion()` reporting N+1 while vN's tables are gone — a
shape no forward migration path can produce (they only ever add rows in increasing order) and none
will repair (nothing re-derives a missing intermediate table from a schema_migrations row that says
the db is already past it).

**`v68_down.js` — merged the same morning this ticket was written — already carried the defect.**
That is the lead argument for building a guard rather than only sweeping: a sweep with no mechanical
enforcement has now been empirically shown to regrow on the very next migration added after the
previous sweep would have run. Fixing the 20 instances found today and stopping there reproduces the
same failure mode at v69.

## File set — OPEN-ENDED BY CONSTRUCTION

The 20 files fixed by this ticket (`v24`, `v25`, `v26`, `v30`, `v31`, `v34`, `v35`, `v36`, `v37`,
`v38`, `v39`, `v40`, `v41`, `v42`, `v43`, `v44`, `v45`, `v47`, `v51`, `v68`) are **not** the
deliverable — they are today's instance of a class that grows by one candidate every time
`CURRENT_SCHEMA_VERSION` is bumped and a rollback is written for it. `v32`, `v46`, `v53`, `v59`,
`v62`, `v63`, `v64`, `v66`, `v67` were already correct and were not touched. **The guard, not the
sweep, is what this ticket is actually shipping** — the sweep is necessary but insufficient on its
own, exactly as demonstrated by `v68_down.js` landing broken on the same morning.

## What was NOT touched — the adjacent class

Assertions about which version a rollback **lands on** (`getSchemaVersion(db)` after rollback,
e.g. `.toBe(67)` in `v68_down.test.js`), and assertions about what a rollback **deletes**
(`SELECT COUNT(*) ... WHERE version = 68` in the same file), are a different, correct claim — not
this bug. No test assertion was rewritten to match a code change.

## The guard

`electron/db/rollback/bareEqualityRollback.guard.test.js`. Scans every `v*_down.js` (non-test) file
in the directory for its `DELETE FROM schema_migrations WHERE version ...` statement and fails if the
comparator is not `>=`. Scoped to non-test files specifically because `*_down.test.js` files
legitimately assert `WHERE version = N` — a different, correct claim (see above) — and including them
would false-positive.

Non-vacuity requirements met: the file-count assertion (`expect(files.length).toBe(29)`) fails loud
if the glob breaks and matches nothing, rather than vacuously passing zero files; the shape assertion
collects every offender before failing so one run reports the whole sweep, not just the first hit.

## Non-vacuity proof — see the Maker report accompanying this ticket for the exact commands and raw
output. Summary: the bare-equality pattern was planted into `v24_down.js`, the guard was run and
observed RED (`v24_down.js: uses '= 24', must be '>= 24'`), the plant was reverted, and the guard was
observed GREEN.

## The adjacent finding this exposed — recorded in T216

`v68_down.test.js:46` (`SELECT COUNT(*) c FROM schema_migrations WHERE version = 68` is `0`) passes
identically whether the production code reads `= 68` or `>= 68`, because a fresh single-version
rollback never seeds a row above 68 to distinguish the two. Twenty files carried this defect under a
green suite for exactly that reason. Recorded as Family 3 in
`docs/work/tickets/T216-gate-semantics-write-up.md` rather than duplicated here, per that ticket's
own scope note that new instances of the gate-semantics pattern belong there.

## Carried alongside this ticket

The T162 admission-invariant test block (`describe('libp2p_peer_id in connectionAuth.js is an
admission concern, never a role/permission grant', ...)`) in
`electron/db/libp2pPeerId.migration.test.js` was applied from an orphaned patch in this same
session — real coverage of `bindOrVerifyPeerIdentity`'s admission-vs-authorization boundary that had
never been merged. Unrelated to the rollback defect; bundled here only because it landed in the same
branch. The stale `CURRENT_SCHEMA_VERSION.toBe(67)` hunk in that same patch was discarded — `main` is
correctly at 68.

## Does NOT count as done

- Fixing today's 20 files without the guard. The guard is the point; see `v68_down.js` above.
- A guard that scans zero files and passes. Non-vacuity must be demonstrated with the actual RED/GREEN
  transcript, not asserted.
- Rewriting `v68_down.test.js:46` or the equivalent in `v66_down.test.js` to "fix" them — they are not
  wrong, they test a different (correct) claim.
