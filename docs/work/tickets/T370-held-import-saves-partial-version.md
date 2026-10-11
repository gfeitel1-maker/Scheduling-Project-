---
title: T370-held-import-saves-partial-version
document_type: ticket
status: closed
created: 2026-10-11
task_class: database-sync
governing_docs: [docs/governance/GOVERNANCE_INDEX.md, docs/adr/2026-10-11-import-electives-keep-their-shape.md]
archive_when: a held import commit either saves no version or its later full commit replaces the partial version instead of stacking a second one, with a red-first test through ingestCommit
---

# T370: a held import saves a partial version that the full commit then stacks beside

**Problem.** `ingestCommit` in `electron/main.js` calls `materializeImportedVersion` whenever there are placements, without checking whether the commit was held. A held commit skips creating new names (activities, elective sets), so their cells land in the left-out list and a partial "Imported from X" version is saved. When the director resolves and commits again, the slots differ, the identical-version skip does not fire, and two versions of the same import sit side by side.

**Direction.** Skip materializing on a held commit (the left-out notice already explains), or have the follow-up commit replace the partial version it supersedes.

Source: Red Hat review of the F6 electives branch, 2026-10-11 (Risk 4). Pre-dates F6 for activity names; electives widen it.
