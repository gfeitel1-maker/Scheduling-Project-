---
title: T195-preference-import-service
document_type: ticket
status: in-progress
created: 2026-09-17
archive_when: the import service ships and a real preference sheet imports cleanly
governing_docs: [docs/governance/standards/ARCHITECTURE_STANDARD.md, docs/governance/standards/TESTING_STANDARD.md, SECURITY.md]
related_adrs: [docs/adr/2026-09-17-individual-elective-scheduling.md]
related_specs: [docs/work/specs/2026-09-17-individual-elective-scheduling-implementation.md]
---

# T195 — Slice 3: the preference import service

A dedicated import path: bounded CSV/XLSX parse, column mapping, identity resolution, preview,
commit. **Blocked on T194.**

## Do not reuse the generic planner; do reuse the parser

`src/ingest/buildPlan.js:1-13` proposes *structural setup entities* from a schedule — a different
job. But `readWorkbookSafely` (`src/utils/exportSanitize.js:84`), `src/ingest/sheetGrid.js` and
`parseGridSchedule.js` are the right parse layer and must be reused, including
`IMPORT_LIMITS` (10 MB / 32 sheets / 20 000 rows, `exportSanitize.js:57-61`). Note there is no
CSV-specific reader — CSV/TSV route through the same XLSX read (`sheetGrid.js:183`).

## Resolution rules

- `external_id` matches one camper → update allowed scheduling fields, same camper id.
- No `external_id`, name + group uniquely matches → offer in preview, require confirmation on first
  import.
- Duplicate names or missing group → block the row.
- **Same display name in the same group** → block, and offer an explicit disambiguation UI showing
  existing camper ids and creation dates. The brief assumed duplicates are separable by group; twins
  and common names in one bunk are not, ever, and DOB is out of scope. Without this the director
  blocks forever with no exit.
- Choice text matches one offering in that occurrence → resolve, show the canonical activity.
- Choice matches an activity globally but not in the occurrence → block; never add the offering.
- Blank or duplicate rank → row-level error. "No preference" only as an explicitly mapped value.
- Repeated source file hash → warn and offer the existing draft; never duplicate silently.
- A choice spanning linked periods or multiple days → **imported as a linked choice**, not
  rejected (ADR D12). The mapping screen must let the director declare that two ranked-choice
  columns are one linked choice, and the preview must show it as one choice with N member
  occurrences. `UNSUPPORTED_LINKED_CHOICE` fires only on malformed linkage — members referencing
  occurrences outside the run, or that the camper is not eligible for.

## Data footprint

This is a sorting problem, not an intake system (ADR D8). The mapping screen must not offer to map
contact details, DOB, household, medical, or emergency fields even when present in the sheet — the
stored footprint is name, group, optional external id, preferences, assignments, and nothing else.
No camper field value may reach `recordAuditEvent` metadata (`electron/audit/auditLog.js:1-9` is a
key-name blocklist, not a PII filter, and `audit_events` is append-only). Import is admin-only
(ADR D9).

## Exit condition

A realistic fixture imports with zero guesses; every ambiguous row blocks until explicitly
resolved or excluded with a recorded reason; **preview writes nothing** (asserted, not assumed);
commit goes through the op-log as one auditable operation and never touches SQLite directly; the
same-name-same-group case is resolvable by a director without a database edit; a linked two-period
choice round-trips from the sheet as **one** choice with two member occurrences.
