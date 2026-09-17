---
title: T202-camper-record-purge-path
document_type: ticket
status: open
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
