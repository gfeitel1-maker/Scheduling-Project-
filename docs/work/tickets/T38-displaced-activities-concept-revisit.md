---
title: T38-displaced-activities-concept-revisit
document_type: ticket
status: parked
created: 2026-08-03
governing_docs: [docs/governance/GOVERNANCE_INDEX.md]
related_adrs: []
archive_when: superseded by an approved specification
---

# T38 — Revisit the "Displaced Activities" concept

**Status: parked.** Product owner, 2026-08-03, while testing the generated-schedule blank-cell fix:
*"displaced activities — this is a concept we should come back to after the other things are fixed."*
Recorded so it is not lost. **Not a design — no approach chosen.**

---

## What it is

The generated-schedule grid currently surfaces a **"Displaced Activities"** tray (top-right panel:
*"Drag onto an empty cell or × to dismiss"*), populated when an activity is bumped out of a slot —
e.g. by the T4 "merge a cell down / run into the next period" flow that lands multi-block sessions.
It appeared during the multi-week Slice-1 work.

The product owner wants to reconsider the **concept and its UX**, not fix a specific bug:
- When should an activity go to the tray vs. be dropped/re-placed automatically?
- How is the tray discovered, and what happens to items left in it (persistence, loss on reload)?
- Does it fit the "two candidate schedules, neither canonical" model, and does it apply to Manual
  as well as Generated?

## Why it's parked

Lower priority than the blank-cell fix (done, T-N/A), the post-save refresh flicker (**T37**), and
the flaky schedule tests (**T39**). Revisit once those settle.

## Next step when picked up

Start with brainstorming / a short spec — this needs a product decision on intended behavior before
any implementation. Capture displaced-activity persistence expectations explicitly.

## Related

- The flaky test at `src/screens/ScheduleScreen.test.jsx:~1264` ("T4: merging a cell down > sends
  the displaced activity to the tray") exercises this feature — see **T39**.
