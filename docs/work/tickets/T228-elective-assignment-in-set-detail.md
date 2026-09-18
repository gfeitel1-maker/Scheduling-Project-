---
title: T228-elective-assignment-in-set-detail
document_type: ticket
status: open
created: 2026-09-18
archive_when: a director can import camper selections, generate assignments and export them from ElectiveSetDetail
governing_docs: [docs/governance/standards/ARCHITECTURE_STANDARD.md, docs/governance/standards/DESIGN_STANDARD.md]
related_adrs: [docs/adr/2026-09-17-individual-elective-scheduling.md]
related_tickets: [docs/work/tickets/T227-elective-run-ipc-seam.md, docs/work/tickets/T196-assignment-engine.md]
---

# T228 — camper assignment inside the elective set builder

## There is no new screen, and there was no open question

An earlier draft of this work asked the owner how a director would arrive at assignment — which
elective set, which week. **That question was already answered by the existing UI** (owner,
2026-09-18: "look at the current UI and screen for electives"):

- `src/screens/ScheduleElectivesScreen.jsx` lists every authored elective set (a picker, not a route).
- `src/screens/elective/ElectiveSetDetail.jsx` builds one set, and **already has an
  "Import from a file" flow** (`populateElectiveSet`, T195) for the OFFERINGS half.

Camper assignment belongs in that same builder, next to the import it already has. Adding a screen
would have created a second way to reach the same set.

## The solver's inputs already exist in the schema

No new tables, and no data a director has to re-enter:

| solver input | existing source |
|---|---|
| occurrence | `elective_sets` — `day_id`, `time_block_id`, group scope, `schedule_week_id` |
| offering | `elective_set_activities.activity_id`, filtered to `status = 'confirmed'` |
| capacity | `elective_set_activities.capacity_mode` / `capacity_limit` (T194) |

## FINDING — the default capacity makes the solver degenerate

**`capacity_mode` defaults to `'unlimited'`** (`electron/db/schema.sql`).

T196's measurements reported that variety held without a per-choice cap — median 13 distinct
activities per camper over 30 periods — and attributed that to capacity being scarce. **That
attribution was measured against a fixture with a hardcoded capacity of 30.** With the shipped
default, every offering is unlimited, every camper wins their #1 in every period, and a camper sits
in one activity all week.

The condition T196 flagged as "worth watching" is therefore **the default**, not an unusual
configuration. This is a real behaviour change to design for, not a tuning note:

1. An unlimited offering must be surfaced to the director before generation, not after — a director
   who has not set capacities is about to get a degenerate week and should be told, in the flag
   vocabulary this repo already uses rather than a banner.
2. The per-choice repeat cap the owner declined on 2026-09-18 was declined **while hypothetical**.
   It is no longer hypothetical, and should be put back to them with this measurement attached.

Neither is decided here. Both are recorded so the screen is not built as though the fixture's
numbers were the real ones.

## Export is not bespoke

Owner ruling 2026-09-18: **the export is however someone wants it — Excel or JSON, like every other
export in the app.** ADR D9's "staff consume the export" is not a licence to design a new artifact.
Reuse `src/utils/exportWorkbook.js` and `src/utils/exportScheduleJson.js`; do not add a third export
path.
