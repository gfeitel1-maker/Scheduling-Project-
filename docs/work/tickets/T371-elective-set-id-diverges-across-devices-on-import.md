---
title: T371-elective-set-id-diverges-across-devices-on-import
document_type: ticket
status: completed
created: 2026-10-11
task_class: database-sync
governing_docs: [docs/governance/GOVERNANCE_INDEX.md, docs/adr/2026-10-11-import-electives-keep-their-shape.md]
archive_when: two devices importing the same file converge on one elective set and one activity per choice name, with no nameless stub set, proven by a two-device test
---

# T371: two devices importing the same electives can leave a stub set

**Problem.** `commitElectiveCandidates` in `electron/ops/ingest.js` gives each new elective set a random id. Two devices importing the same file each create a set of the same name; the name uniqueness keeps one, but the loser's choice rows still replicate and the projection seeds a stub `elective_sets` row for the dead id. Activities minted for choice names also get random ids, so the same choice can exist twice.

**Direction.** Derive the set id (and minted choice activity ids) from the camp and normalized name, as other import ids are derived, so both devices write the same rows.

Source: Red Hat review of the F6 electives branch, 2026-10-11 (Risk 6, plausible; `ensureSetStub` body not yet read).

**Resolution (2026-10-11).** Imported elective set ids derive from the camp and the spacing-blind name key (`deriveElectiveSetId`); choice activities mint through `deriveSpecialDayActivityId`, the special-day path's derivation. An import never rewrites a row already under a derived id, so a director's rename survives re-import. Pinned by `electron/ops/electiveImportConvergence.test.js`. Not covered: a delete on one device concurrent with an import on another can bring the set back after merge (no tombstone for `elective_sets`), and differently-spelled names on two devices raise a name conflict for the director rather than duplicating.
