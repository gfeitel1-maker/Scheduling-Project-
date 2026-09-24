---
title: T202-camper-record-purge-path
document_type: ticket
status: completed
created: 2026-09-17
archive_when: the purge procedure is implemented and its limits are documented in SECURITY.md
governing_docs: [docs/governance/standards/ARCHITECTURE_STANDARD.md, SECURITY.md]
related_adrs: [docs/adr/2026-09-17-individual-elective-scheduling.md]
related_specs: [docs/work/specs/2026-09-17-individual-elective-scheduling-implementation.md]
---

# T202 — the camper-record purge path

A real Delete is permitted (ADR D10). This ticket owns the procedure behind it, because two of its
steps do not exist and one existing step silently defeats erasure.

Split out of T194: the substrate slice should not also be the slice that builds device-fleet
tooling.

## What already works

| Step | Mechanism | Status |
|---|---|---|
| Delete the record from document + projection | `electron/ops/deleteRecord.js`; `applyProjection`'s `__deleted__` sentinel runs a real `DELETE FROM <table> WHERE <key> = ?` (`electron/ops/projections.js:820-834`) | **exists** |
| Rebuild SQLite from the document | `rebuildProjectionFromDocumentAtPath()` (`electron/automerge/rebuildSupportCommand.js:126-175`) deletes the db file plus `-wal`/`-shm` and recreates from schema — the only existing path that erases `operations` rows | **exists** |
| Reject a stale peer | `sharesGenesis()` (`electron/automerge/campDocument.js:322-330`) and `electron/sync/automerge/syncNode.js:147-153` refuse and drop a document that does not share genesis, even from an admitted peer | **exists** |

That last one is the good news, and it is why a purge is genuinely possible here: a device that was
offline during the purge **cannot re-introduce the data** when it reconnects. It is refused at the
sync boundary and must re-pair.

## What must be built

**1. The pre-migration backup defeats the whole procedure.** `writePreMigrationBackup()`
(`electron/db/projectManager.js:151-158`) writes a complete copy of the pre-rebuild database —
op-log included — to `<dbPath>.pre-migration-<ts>.bak` at mode 0600, and **nothing ever deletes
it**. A purge run through the existing rebuild tool leaves the entire pre-purge database sitting
next to the live one. The purge path must remove it deliberately, and must not silently skip a
backup that a normal migration still needs.

**2. There is no op-log prune.** Nothing anywhere deletes from `operations` — no targeted delete, no
prune, no compaction. Today the only erasure is the whole-file rebuild. A targeted prune (remove
this record's rows, keep the rest of the ledger) does not exist and must be built if targeted purge
is wanted; otherwise the procedure is whole-camp reset only, and the docs must say so.

**3. There is no runtime genesis regeneration.** `GENESIS_B64`
(`electron/automerge/campDocument.js:254`) is a hardcoded source constant; it has been regenerated
five times by editing the source and shipping a release. Erasing a record from *document history*
requires a new genesis, which today means a build — not an action a director can take. Decide and
record which this is: a support procedure, or a product feature.

## Exit condition

- A documented, executable procedure: delete record → prune op-log → rebuild document/genesis →
  remove backups → re-pair devices. Each step names its function.
- A test proving the data is unrecoverable afterwards **on that device**, including from the
  `.bak` file.
- The limits are written down honestly in `SECURITY.md`: a copy already taken off-device, and a peer
  that never rebuilds or re-pairs, are out of reach. Per-record erasure from document history is not
  possible without a whole-document reset.
- The Delete control's copy (T199) matches what this procedure actually does.

## Shipped (2026-09-18)

- `electron/automerge/purgeSupportCommand.js` (`purgeCamperRecord`) — support-command only, no UI,
  no preload/IPC surface, matching how `rebuildProjectionFromDocumentAtPath` ships today. Composes
  alongside `rebuildSupportCommand.js` rather than overloading it.
- Procedure implemented: delete camper + dependent `elective_preferences`/`elective_assignments`
  rows from the live projection → regenerate a fresh document via
  `seedAllFromSqlite(oldDb, createEmptyDoc())` (no prior-value history for the purged rows) →
  rebuild SQLite from that document via the existing `rebuildProjectionFromDocumentAtPath` pipeline
  (empties `operations` as a whole-file side effect) → shred every `*.pre-migration-*.bak` for the
  db path (purge-only; the three ordinary `writePreMigrationBackup` call sites are untouched).
- Test: `electron/automerge/purgeSupportCommand.test.js` — negative control (ordinary rebuild keeps
  its backup), happy path (projection rows gone, `operations` empty for both the camper and its
  dependent row, every pre-migration backup gone including a pre-existing one, and a walk of
  `A.getAllChanges`/`decodeChange` on the regenerated `.automerge` confirms no change touches the
  purged ids), a non-vacuity case (an `operations`-only row with no projection row is also purged),
  and a documented "known gap" case (an untouched peer's old document still shares genesis and an
  ordinary merge would reintroduce the camper — proving the re-pair requirement rather than papering
  over it).
- Explicitly NOT built, matching Governor's scope decision: no schema migration (schema stays v71,
  no new tables), no targeted per-record op-log prune (the whole-file rebuild already clears
  `operations`), no runtime per-camp genesis rotation (app-wide genesis unchanged).
- `SECURITY.md` gained a "Camper-record purge" subsection under Known limitations; the ADR's D10
  gained a "Resolved by T202" note.
- T199's Delete-control copy was not touched by this ticket — out of scope here, tracked separately.

## Round 2 hardening (2026-09-18)

Security/Red Hat/Code Reviewer found three real gaps in the first cut (commit 4fbff5a), all fixed:

- **Atomicity.** The camper/dependent-row deletes, `seedAllFromSqlite`, and the genesis check now
  run inside one `oldDb.transaction()` — a failure anywhere in that block rolls the deletes back
  instead of leaving SQLite purged while the still-current `.automerge` holds the camper. The
  document save and whole-file rebuild happen only after that transaction commits. A crash in the
  remaining window is recovered by an ordinary re-run (idempotent). Regression test: forces a throw
  inside the transaction via `vi.spyOn(seedModule, 'seedAllFromSqlite')` and asserts the camper and
  its dependent row are still present afterward — fails against the pre-fix code (verified red
  before the fix, green after).
- **Blast radius disclosed.** The reused rebuild wipes every host-only table on this device
  (`conflicts`, `import_evidence`, `import_decisions`, `open_reconciliation_decisions`,
  `pending_writes`, `pending_restores`, `device_health_events`, `projection_failures`,
  `source_aliases`, `compound_cell_decisions`, `location_word_decisions`,
  `declined_two_row_splits`) plus this device's `host_signing_key`/`device_identity_key` and
  `camps.signing_secret` — camp-wide, not scoped to the purged camper. `schedule_snapshots` is
  document-replicated and correctly survives (round 1's own review misnamed it as collateral; this
  is the correction). `purgeCamperRecord` now returns `notRecoverable`/`before`/`after` from the
  rebuild rather than dropping them, SECURITY.md/ADR state the collateral plainly, and a test pins a
  seeded `conflicts` row and `host_signing_key` row as gone after purge. A new refusal (before any
  destructive step) rejects an id with no camper row and no `operations` history, so this cost is
  never paid for nothing.
- **Re-pair enforcement corrected.** SECURITY.md now states plainly that nothing in code prevents an
  already-paired peer from reintroducing the purged record via ordinary sync — `sharesGenesis()` is
  the only gate and cannot distinguish a purged record from an ordinary one. Per-camp genesis
  rotation (the real fix) is deferred to a separate ticket.
