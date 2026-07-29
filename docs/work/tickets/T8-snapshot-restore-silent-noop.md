---
title: T8-snapshot-restore-silent-noop
document_type: ticket
status: completed
created: 2026-07-26
governing_docs: [docs/governance/standards/ARCHITECTURE_STANDARD.md]
related_adrs: []
archive_when: next archive sweep — resolved
---

> **RESOLVED.** Fixed in the T8 work (`snapshotRestore.js` — a snapshot with no payload is
> now identified and labelled rather than silently no-opping). **Visually confirmed 2026-07-29**
> under `npm run electron:dev`: a snapshot whose `slots` payload is NULL renders a greyed,
> disabled **Empty** in the Versions dropdown instead of an active Restore, with the delete
> affordance retained. Newly saved snapshots were also confirmed to write a real payload
> (2816 bytes), so the `af6a9d8` write bug is genuinely closed.
>
> Note the condition cannot occur naturally in a fresh camp — only legacy pre-`af6a9d8` rows
> have a NULL payload — so verification required staging that state in the dev database.

# T8 — Restore snapshot silently does nothing, and existing snapshots are empty shells

**Risk:** Moderate — no corruption, but a safety feature the director is relying on has never worked.
**Found:** 2026-07-27, Red Hat review.
**Status:** CONFIRMED against the production DB.

---

## The defect

`saveSnapshot` (`src/screens/ScheduleScreen.jsx:544-551`) writes fields in key order: `template_id`, `name`, `is_auto`, `created_at`, `slots`, `overlays`. Before `af6a9d8`, the boolean `is_auto` threw at the better-sqlite3 bind — so `created_at`, `slots` and `overlays` were **never written**.

All three `schedule_snapshots` rows in the production DB match this exactly: ops exist only for `template_id` and `name`; `slots` and `overlays` are NULL.

`restoreSnapshot` (`:564`) then does:

```js
if (!fullSnap?.slots) return
```

A bare return. No error, no toast, no log. The user clicks Restore and nothing happens — and nothing ever will, for those rows.

This also explains the "Could not save undo point" reports: the same throw propagated and cancelled the regeneration that triggered it (`:566-571`, `:640-646`).

`af6a9d8` fixes snapshots written from now on. It does not repair the three dead rows.

## Observable completion evidence

1. Save a snapshot, change the schedule, restore it: the schedule returns to the snapshot state.
2. Attempting to restore a snapshot with no `slots` shows a **visible error** naming what went wrong. Never a silent return.
3. The three corrupt rows are gone, so they no longer appear in the Versions dropdown as restorable.
4. A test asserting that a snapshot round-trips: save → mutate → restore → original state, with the payload written and read in DB shape.

## Files expected to change

- `src/screens/ScheduleScreen.jsx:564` — replace the silent `return` with a surfaced error via the existing `setActionError` path.
- A one-time cleanup for the three rows. Deleting them is reasonable; they contain nothing.

## Note

Worth auditing the other `if (!x) return` guards in this file while you are here. This bug was invisible for as long as it was precisely because the failure path was indistinguishable from a no-op, and that pattern is used in several places.
