---
title: "Setup consistency, grouped events and dialog focus: before and after"
document_type: evidence
status: active
created: 2026-10-12
archive_when: the setup screens, the Fixed/Recurring Events table or the dialog motion change again
---
# Before and after: setup consistency (#985), grouped events (#986), dialogs (#981, #982)

"Before" is build `3ae9fb9` (the copy, clarity and consistency audit's own captures). "After" is main
`5c9d5da1`, packaged, with campB imported and a schedule generated, captured over CDP by the final-audit
driver's app.

| Screen | Before | After | What changed |
|---|---|---|---|
| Groups | `before-groups.png` | `after-groups-week-bar.png` | The one week bar is the first thing on the screen, as on Activities and Locations. |
| Recurring Events | `before-recurring-events.png` | `after-recurring-events-grouped.png` | 37 rows, one per event per day, became one row per event ("CIT Block 1 · Mon–Fri"); single-day events keep a plain row; "+ Add" is the table's last row. |
| Rebuild dialog | `before-rebuild-dialog.png` | `after-rebuild-dialog.png` | Focus is on Cancel when the dialog opens (focus ring); the scrim fades while the card lifts. |

The "after" Recurring Events heading still read "37 recurring events", counting days. It now counts events
("12 recurring events · 37 days").
