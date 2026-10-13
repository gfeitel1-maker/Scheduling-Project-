---
title: T381-save-whole-camp-and-open-a-saved-camp
document_type: ticket
status: open
created: 2026-10-13
task_class: architecture
governing_docs: [docs/governance/constitution/CONSTITUTION.md, docs/governance/standards/ARCHITECTURE_STANDARD.md, docs/governance/standards/DESIGN_STANDARD.md, SECURITY.md]
related_adrs: [docs/adr/2026-10-13-whole-camp-file-save-and-open.md]
related_tickets: []
archive_when: "a camp built in one profile is saved with Save whole camp and opened through Start from a saved camp file in a fresh profile, and the round-trip test shows every exported table and both schedules equal after id normalization, the hostile-file tests reject every case in the ADR, Security and Red Hat have reviewed, and final-audit step 19 passes"
---

# T381: Save whole camp, and open a saved camp

**Owner ruling (2026-10-13):** "Second device + camp file": build **Save whole camp** and **Open a saved camp** for v1. Backups are encrypted with this computer's key and restore only on it; if a camp's only laptop dies, the director needs a file that opens into a fresh camp on any computer.

**Design.** `docs/adr/2026-10-13-whole-camp-file-save-and-open.md` (accepted 2026-10-13).

**Progress.** Phase 1 (scope, export, validate, load, round-trip tests) landed in 880b909b. Phase 2 (IPC, sidebar Save whole camp, start-screen Open a saved camp, load-incomplete Start over, caps, final-audit step 19, docs) is built on this branch. Measured caps (CPU time): audit-size 40-group camp is 4,184 rows / 8.4 MB / 3.9 s load; the largest schedulable camp (99 groups) is 10,233 rows / 20.8 MB / 7.7 s; with 30 versions 52.8 MB / 12.0 s. Final caps: 64 MiB, 30,000 rows per entity, 50,000 rows total (ADR section 1). Still open: Security and Red Hat review, and running final-audit step 19 in the packaged audit.

**Scope.** Versioned JSON envelope shaped by the `PROJECTIONS` registry; admin-gated save and load IPC; start-screen card "Start from a saved camp file"; load through `appendOp` / `appendBulkReplaceOp` with derived ids re-derived; "load incomplete" flag with Start over; schema-enumeration guard; red-first round-trip and hostile-file tests; final-audit step 19; Security and Red Hat review.

**Non-goals.** No encryption of the file, no merge into an existing camp, no migration of old files, no cross-version tolerance beyond refusal, no campers or elective assignment runs unless the owner reverses open question 1. The Restore copy and the guide's backup paragraphs belong to a separate worker; this ticket owns only the new guide subsection after "Restoring from a backup".

**Constraints for the maker.** Test-first. Follow the ADR section 6 order. One test file at a time with `--no-file-parallelism`; no `npm ci`, build, verify or packaged runs locally; CI is the gate. Run `graphify affected "appendBulkReplaceOp()"` before touching shared write paths. Run `npm run check:governance` before every push.
