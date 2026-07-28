---
title: T12-schedule-grid-dnd-degraded
document_type: ticket
status: completed
created: 2026-07-28
governing_docs: [docs/governance/standards/ARCHITECTURE_STANDARD.md, docs/governance/standards/TESTING_STANDARD.md]
related_adrs: []
resolved_by: af6a9d8
archive_when: next archive sweep — no code change required
---

> **RESOLVED — no code change required.** Already fixed on `main` by `af6a9d8`.
> The installed app is a stale build that predates the fix. Remedy: rebuild and reinstall.

# T12 — Drag-and-drop on the schedule grid does not work in the installed app

**Risk:** HIGH while it persists — dragging is the primary way a director builds a schedule.
**Found:** 2026-07-28, hand-check of the **installed** app by the product owner.
**Status:** DIAGNOSED. Root cause confirmed in the shipped bundle. Fixed on `main`.

---

## The report

> drag from side bar and expand down do not work. doesn't drop at all, doesn't move
> for either. i was looking at the version installed on my computer

## Root cause

The installed app predates the op-value coercion fix.

| | |
|---|---|
| `/Applications/Shoresh.app` built | **2026-07-27 13:01** |
| `af6a9d8` (the fix) committed | **2026-07-27 21:12** |

Eight hours apart. Confirmed by reading the shipped bundle directly, not inferred from
timestamps: `Contents/Resources/app/electron/ops/operations.js` binds the raw `value` into
the operations INSERT and contains **no `coerceOpValue`** — that function does not exist
in the installed build.

better-sqlite3 binds only numbers, strings, bigints, buffers and null. Other JS types are
not merely rejected, they are misinterpreted — a plain object is read as a named-parameter
bag, and booleans throw outright.

Every slot placement writes an object:

```js
await writeFields('template_slots', slot.id, { activity_id: nextActivityId, flags: {} })
```

`flags: {}` reaches the bind, `appendOp` throws before the row is ever touched, and the
op-log write, the projection, the renderer's optimistic update, and its undo-point push are
all skipped together. Nothing moves, nothing persists, no partial state is left behind —
which is exactly why it reads as "doesn't drop at all, doesn't move either", identically in
every view. It is not view-specific because it is not a view bug; it is the write path.

`af6a9d8`'s own commit message names this symptom: *"This is what surfaced as 'Failed to
place activity' and blocked drag-and-drop end to end."*

## Same root cause as T8

The dead snapshots in T8 were this bug wearing a different hat: `saveSnapshot` wrote the
boolean `is_auto`, which threw at the same bind, so every field after it in key order —
`created_at`, `slots`, `overlays` — was never written. One defect, two symptoms, eight
months of apparent unrelatedness. Worth remembering next time two unrelated-looking
features fail at once.

## Remedy

Rebuild and reinstall:

```bash
npm run electron:build
```

No code change. `main` already contains the fix, plus `2b69ec7` (register `template_slots`
in `PROJECTIONS`), which the installed build also predates and which would have caused
silent non-persistence even after the bind was fixed.

## What this cost, and the cheap guard

The report was initially ambiguous between three candidate builds — `main`, the
`ui/state-primitives` worktree, and the installed app — and the suspects differed for each.
That ambiguity is precisely what ADR 2026-07-28 addressed for dev-versus-packaged, and the
DEV badge now distinguishes them at a glance.

It does not yet distinguish a **stale** packaged build from a current one. The app reports
`CFBundleShortVersionString 0.0.0`, so there is nothing in the UI or the bundle to date it.
Stamping the build with its commit and date, and surfacing it in the sidebar beside the
database name, would have turned this diagnosis into a five-second read.

**Follow-up filed as T13.**
