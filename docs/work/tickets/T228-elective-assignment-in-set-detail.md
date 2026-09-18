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

## RETRACTED FINDING — the default capacity does NOT make the solver degenerate

_This section first claimed that `capacity_mode`'s `'unlimited'` default would make every camper win
their #1 in every period and sit in one activity all week. **That claim was written from reasoning,
not measurement, and it is false.** It is kept here, corrected, rather than deleted, because the
wrong reasoning is the useful part._

Measured on the same 100-camper fixture, changing only capacity:

```
capacity=30         distinct activities/camper  min 9  median 13  max 16   mean rank 6.31
capacity=unlimited  distinct activities/camper  min 9  median 13  max 16   mean rank 6.30
```

Essentially identical. So T196's note — that variety survives without a per-choice cap **because
capacity is scarce** — had the right observation and the **wrong mechanism**, and this ticket then
inherited that wrong mechanism and drew a false conclusion from it.

**The real mechanism is the MENU.** Each period offers only 4 of ~30 activities, so a camper cannot
receive the same first choice in every period because it is not offered in every period. Variety
comes from how the offerings are spread across the week, not from capacity at all.

What follows for the screen:

1. **No unlimited-capacity warning is needed** on the grounds claimed above. Capacity still matters
   for its own reason — an over-subscribed activity — but it is not what protects variety.
2. **The per-choice repeat cap stays declined.** The owner declined it on 2026-09-18 while it was
   hypothetical; the case for reopening it rested on this retracted finding and has gone with it.
3. **The condition actually worth watching is a THIN MENU** — an elective set whose periods all offer
   the same few activities. That is the configuration where a camper could be parked in one activity
   all week, and it is a property of how the director authored the set, not of capacity.

## Export is not bespoke

Owner ruling 2026-09-18: **the export is however someone wants it — Excel or JSON, like every other
export in the app.** ADR D9's "staff consume the export" is not a licence to design a new artifact.
Reuse `src/utils/exportWorkbook.js` and `src/utils/exportScheduleJson.js`; do not add a third export
path.
