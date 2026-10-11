---
title: T372-import-undo-trusts-renderer-entity-list
document_type: ticket
status: closed
created: 2026-10-11
task_class: security-auth
governing_docs: [docs/governance/GOVERNANCE_INDEX.md, docs/adr/2026-10-11-import-electives-keep-their-shape.md]
archive_when: import undo deletes only rows the named import run actually created (checked in the main process, not from the renderer's list), and snapshot slots that point at an undone row are handled, each with a red-first test
---

# T372: import undo trusts the renderer's list of what the import created

**Problem.** Import undo receives `createdEntityIds` and each entry's `fieldSnapshot` from the renderer (`electron/main.js`, `undoIngest` in `electron/ops/ingest.js`). An entry with an empty `fieldSnapshot` skips the "edited since import" check, so the reference check is the only guard. A caller with the import permission can therefore delete any unreferenced row of an undo-deletable type, which since F6 also includes `elective_sets` and `elective_set_activities`. Separately, saved schedule versions (`schedule_snapshots` slots) can still name an undone set or activity; restoring one shows a blank cell.

**Direction.** Record what each import run created in the main process (elective sets and join rows get no `import_evidence` today) and have undo accept only those ids. Decide whether a version slot that names an undone row blocks undo or is reported.

Source: Red Hat re-review of the F6 electives undo change, 2026-10-11 (findings 2 and 6).
