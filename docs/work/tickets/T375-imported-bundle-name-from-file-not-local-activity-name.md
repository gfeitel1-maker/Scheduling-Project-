---
title: "An imported double-period bundle's name comes from each device's local activity name, so two concurrent imports can conflict"
document_type: ticket
status: completed
created: 2026-10-11
task_class: database-sync
governing_docs: [docs/governance/constitution/CONSTITUTION.md, docs/governance/standards/ARCHITECTURE_STANDARD.md]
related_adrs: [docs/adr/2026-09-29-linked-elective-bundles.md]
related_tickets: [docs/work/tickets/T219-multi-day-catalog-linkage.md]
archive_when: "two devices importing the same file, one holding an unsynced rename of a choice activity, write the same elective_bundles.name for the bundle, proven by a test that drives both devices' imports and asserts no conflicts row; and an import undone on one device is re-importable on another (the undo origin is carried in the document), proven with two devices, while a director delete still suppresses re-import on both"
---

# T375: an imported bundle's name can differ between two concurrent imports

Found by Red Hat on #961 (T219). The keeper ruled it gets fixed if small and ticketed otherwise. It is ticketed because the fix needs data that `materializeImportedVersion` does not have today.

## Cause

`writeSpanBundles` (`electron/ops/materializeImportedVersion.js`) names each bundle `<choice activity name> — <day label>`. It reads both parts from the device's own database at import time.

- Bundle ids are content-derived from set, activity, day and block ids, not from names. So the same file converges on the same rows.
- The `name` field, though, is written by every device that runs the import.
- Suppose device A has renamed the Pottery activity to Ceramics and that rename has not synced yet. If A and B both import the same file, A writes "Ceramics — Monday" and B writes "Pottery — Monday".
- That is a concurrent write of different values to one field, so a `conflicts` row is raised.

**When it does not happen:** if only one device imports, nothing conflicts. The other device's rename touches `activities.name`, never the bundle.

## Fix direction

Name the bundle from the file's own text (the choice label and day as printed), so every device importing the file writes identical bytes.

- `materializeImportedVersion` receives the placements, which carry the day name and, for list cells, the choice text.
- A header-word elective's choices arrive through `confirmedElectiveSets` at commit time and are not passed to materialize. They would need to be threaded through, or the name settled at commit time.

## Not in scope

The id derivation, which already converges.

## Added scope (keeper ruling, 2026-10-11): undo origin must cross devices

#961 made an undo delete stop acting as a re-import tombstone (`isHumanDeleted` in `electron/ops/fieldProvenance.js` ignores deletes whose client_write_id carries `UNDO_DELETE_PREFIX`). That marker lives only in the device-local op log.

A second device sees only the document deletion. Its op log therefore reads the deletion as a director's delete, and a re-import there keeps the rows away. Same "two devices import" seam as the bundle name, so both ship in one PR.

**Required:**
- Carry an undo marker in the Automerge document, so another device's re-import knows the deletion was an undo.
- Red-first with two devices: device A imports, undoes, syncs; device B re-imports the same file and gets the rows back. A director's own delete still suppresses the re-import on both devices.

## Shipped (2026-10-11)

**Bundle name.** `materializeImportedVersion` names each bundle from the file (`fileLabelsFor`). It uses the choice as printed: the commit's `confirmedElectiveSets` choices, threaded through from `electron/main.js`, plus a list cell's own choices. It uses the day as printed too. A choice is tied to its printed label by the id the import derived from that text (`deriveSpecialDayActivityId`). A device holding an unsynced rename therefore writes the same name as one without it.

Residual: a choice that matched a pre-existing catalog activity by spelling, rather than by derived id, falls back to the local name.

**The cross-device premise was backwards.** A merged delete was recorded in the receiving device's history ledger with `source` NULL. So on device B neither an undo nor a director's delete counted as a rejection:
- An undo on device A was already re-importable on B.
- A director's delete on A did **not** suppress a re-import on B. That gap was pre-existing and applied to fixed events too.

**The fix carries the rejection in the document.**
- A director's delete (explicit `source: 'human'`) writes a `'human'` marker under the delete sentinel in the sparse `field_provenance` collection (`electron/automerge/campDocument.js`).
- An undo (`undo-import:` client_write_id, sent to the document as source `'undo'` by `electron/ops/operations.js`) writes no marker, and neither does an import teardown (no source).
- The receiving ledger records the delete as `'human'` only when the marker is present (`electron/automerge/historyLedger.js`). `isHumanDeleted` then gives the same answer on every device.
- The marker clears when the record comes back.

Pinned two-device by `electron/automerge/deleteProvenanceAcrossDevices.test.js`, red first: the director-delete case failed before the fix.

**Every delete a director causes is a rejection** (keeper ruling on Red Hat risk 2). These paths now write `source: 'human'` on each delete they make:
- `deleteRecord`: the direct delete, a group's cascade over its fixed events and slots, and removing a day with its fixed events and slots.
- `deleteEvent`.
- `deleteElectiveRun`, and so the season purge that shares its cascade.
- `mergeActivity`: the merged-away activity.

Pinned one test per path by `electron/ops/directorDeletesAreRejections.test.js`, which also covers the group cascade across two devices. Only undo and import teardown are not rejections.

**Accepted (keeper):** two devices that make different confirm-step edits write different bundle names, and the conflict row is the right outcome.
