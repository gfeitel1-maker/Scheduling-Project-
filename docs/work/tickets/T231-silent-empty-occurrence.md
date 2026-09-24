---
title: T231-silent-empty-occurrence
document_type: ticket
status: completed
created: 2026-09-18
archive_when: buildElectiveAssignments reports an occurrence with no eligible campers or no offerings, pinned by tests
governing_docs: [docs/governance/standards/TESTING_STANDARD.md]
related_adrs: [docs/adr/2026-09-17-individual-elective-scheduling.md]
related_tickets: [docs/work/tickets/T196-assignment-engine.md, docs/work/tickets/T229-elective-assignment-in-set-detail.md]
---

# T231 — an occurrence nobody can attend vanished without a finding

## Found by a real-data probe, not by a test

After T229 merged, the assignment pipeline was run against a **copy of the real dev database**
(schema v53, migrated to v69 on the copy first — that jump is clean: 89ms, integrity ok, 0 FK
violations, all 675 `template_slots` preserved). An elective set was authored on a real (day,
time_block) cell and solved.

Result: **0 assignments, 0 findings.** No error, no explanation.

The probe's own call was at fault — it passed `buildAttendance`'s `{attendance, unmatchedCount}`
wrapper where the engine expects the bare map, so every camper was ineligible. **The shipped
`AssignmentPanel` destructures correctly (`AssignmentPanel.jsx:187`) and is not affected.**

But the engine's response to that input is the defect:

```js
if (who.length === 0 || here.length === 0) continue
```

An occurrence nobody can attend, or with nothing on offer, was skipped **with no finding** — a clean,
empty, successful-looking result indistinguishable from "no work to do".

## Why this is worth fixing rather than filing as probe error

The realistic version has nothing to do with a malformed call: **a camp whose division names on the
sheet do not match the camp's tier names** gets exactly this. `buildAttendance` matches division to
tier by normalized name, so "Machanayim" vs "Machaneh" yields zero eligible campers per occurrence,
an empty schedule, and no reason for it.

This is the failure class this repo keeps finding: the code is internally consistent, reports
success, and does nothing. Silence is the wrong answer when the input is structurally unusable.

## Change

Two findings replace the silent `continue`:

- `NO_OFFERINGS` — nothing is offered in this period.
- `NO_CAMPERS` — no camper is eligible, with the message naming the likely cause (division names not
  matching the camp's).

The empty-input case (no occurrences at all) stays quiet and is pinned by an existing test, so the
fix cannot make every empty preview shout.
