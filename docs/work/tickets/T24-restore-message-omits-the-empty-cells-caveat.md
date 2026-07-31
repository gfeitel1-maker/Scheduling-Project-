---
title: T24-restore-message-omits-the-empty-cells-caveat
document_type: ticket
status: completed
created: 2026-07-31
governing_docs: [docs/governance/standards/DESIGN_STANDARD.md]
related_adrs: [docs/adr/2026-07-30-deleting-a-record-a-schedule-uses.md, docs/adr/2026-07-30-restore-deleted-records-from-the-op-log.md]
archive_when: resolved
---

# T24 — Restoring from Trash does not repeat that the cleared cells stay empty

**Risk:** Medium. It lets a director believe their schedule came back when it did not.
**Found:** 2026-07-30 by Tester, during the T21 run. Not fixed when T21 merged.

---

## What happens

Restoring a record from Trash confirms the record is back. It does not say what did **not** come
back. For an activity, the cells it was cleared from stay empty; for a group, the week is gone
and only a Version can return it.

## Why it matters

[The ADR](../../adr/2026-07-30-deleting-a-record-a-schedule-uses.md) §3 is explicit that this
must be said, and says why: "a director may reasonably expect otherwise." The expectation that
undo restores everything is the default assumption, not an unusual one.

The delete confirmation does say it. The restore does not — and restore is the moment the
director is actually checking whether their work survived. Saying it once, minutes or months
earlier, is not saying it at the point of use.

This is the same failure shape as T19 and the foreign-key message T21 fixed: the app knows the
true state and reports a friendlier one.

## Where to look

The Trash screen's restore path and whatever success message it renders. Cross-check against
`src/components/DeleteRecordDialog.jsx`, which already has correct wording for the delete side
and is the natural source of the phrasing.

The restore ADR §3 (restore the requested record only) is the authority on what actually comes
back — read it before writing the copy, so the message describes the real behaviour rather than
the assumed one.

## Resolution — 2026-07-31

Confirmed real: `TrashScreen.restore()` reported `` `${name} is back.` `` and nothing more.

`restoreCaveat(entity)` in `src/screens/TrashScreen.jsx` now appends what did **not** come back,
worded per entity. Two constraints shaped it:

- **A trash row carries no slot count.** `listDeleted` returns entity, id, name and who/when —
  no placement figures. So the caveat has to read true whether or not the record was ever
  placed: "any cells it was cleared from", not "the 30 cells".
- **It belongs on every path a restore can take.** Applied to the immediate success, to the
  queued path (where the restore has not happened yet and the director is even less able to
  check), and to the batch child-restore — deduped there, so ten groups say it once.

Entities with nothing else to lose (a user, for example) say nothing extra. A caveat on every
restore would train directors to skip it.

## Completion evidence

1. Restoring an activity states that the cells it was removed from are still empty — **met**:
   "It is not back on the schedule, though — any cells it was cleared from are still empty."
2. Restoring a group states that its week did not come back, and points to Versions by name —
   **met**: "Its week did not come back with it, though. You can bring that back from Versions
   on the Schedule screen."
3. The wording is a director's, not a developer's — **met**: no "snapshot", "op", "slot",
   "template" or "route" appears in any of the three strings.
4. A test asserts the caveat is present on both restore paths — **met**, and on three:
   immediate, queued, and batch. `TrashScreen.test.jsx` also asserts the group wording does not
   appear for an activity, and that a record with nothing else to lose stays quiet.
