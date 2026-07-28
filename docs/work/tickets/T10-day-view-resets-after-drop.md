---
title: T10-day-view-resets-after-drop
document_type: ticket
status: open
created: 2026-07-26
governing_docs: [docs/governance/standards/ARCHITECTURE_STANDARD.md]
related_adrs: []
archive_when: fix merged and Verifier PASS recorded
---

# T10 — Day View jumps back to Monday after every drop

**Risk:** Low — cosmetic, but it lands on the most repetitive action in the app.
**Found:** 2026-07-27, verifying drag-and-drop in the real app.
**Status:** CONFIRMED by observation.

---

## The defect

In Day View, select Tuesday and drop an activity onto a slot. The write succeeds and persists correctly — but the day tab snaps back to **Monday**, and the user is looking at a different day than the one they just edited.

Almost certainly `loadAll()`, invoked by the `op-applied` event (`ScheduleScreen.jsx:113-117`), re-running:

```js
if (d.length > 0) setSelectedDay(d[0].id)
```

at `ScheduleScreen.jsx:207`. That line is right on first load and wrong on every reload.

## Why it matters

Building a week means placing many activities on the same day in a row. Getting thrown back to Monday after each one, with no explanation, is the kind of friction that makes staff stop trusting the tool — and it is most likely to bite exactly when someone is doing bulk edits under time pressure.

## Observable completion evidence

1. Select Tuesday in Day View, drop an activity: the view is still on Tuesday afterward.
2. Same for the group selector in Group View — check whether `setSelectedGroup(sortedG[0].id)` at `:206` has the identical problem.
3. On genuine first load, the default day and group are still selected.
4. If the selected day is deleted while selected, the selection falls back sensibly rather than going blank.

## Files expected to change

- `src/screens/ScheduleScreen.jsx:206-207` — only default the selection when nothing valid is currently selected, rather than on every load.
