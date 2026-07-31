---
title: T23-deleting-an-activity-skips-the-confirmation
document_type: ticket
status: open
created: 2026-07-31
governing_docs: [docs/governance/standards/DESIGN_STANDARD.md]
related_adrs: [docs/adr/2026-07-30-deleting-a-record-a-schedule-uses.md]
archive_when: resolved
---

# T23 — Deleting an activity clears cells with no confirmation

**Risk:** Medium. A destructive action happens with no warning and no stated count.
**Found:** 2026-07-30 by Tester, during the T21 run. Not fixed when T21 merged.

---

## What happens

Deleting a **group** shows the confirmation T21 built — the real count, what will be removed,
and where it can be recovered from. Deleting an **activity** does not. It empties every cell
that activity occupied and reports nothing beforehand.

## Why it matters

[The ADR](../../adr/2026-07-30-deleting-a-record-a-schedule-uses.md) §1 does not scope the
confirmation to groups. It says the confirmation names the real number before anything happens,
"because the count is the whole basis on which a director decides." An activity placed in 30
cells across two routes is exactly that decision.

The asymmetry is also its own problem: a director who learns that deleting is confirmed will
reasonably assume it always is. The one time it is not is the time they lose work they did not
expect to lose.

Note the two cases genuinely differ in what happens next — §2 — and the copy must reflect that.
Deleting an activity **empties** cells and keeps them; deleting a group **removes** the week. So
this is not "reuse the group dialog", it is "say the true thing for this entity."

## Where to look

`src/components/DeleteRecordDialog.jsx` and its call sites. `electron/ops/deleteRecord.js`
already distinguishes the entities, so the count is available; confirm whether the renderer
simply does not open the dialog for activities, or opens it and takes an early path.

## Completion evidence

1. Deleting an activity that appears in a schedule shows a confirmation naming the real count
   before anything is cleared.
2. The copy says the cells are emptied and kept — not that a week is removed.
3. Deleting an activity that appears in **no** schedule does not force a confirmation on a
   director for a zero-consequence action.
4. A test asserts the confirmation appears for a placed activity, so it cannot silently regress.
