---
title: Architecture audit 2026-08-03
document_type: architecture-report
authority: descriptive
status: active
date: 2026-08-03
---

Top deepening candidates, ranked by leverage. Full analysis in `2026-08-03-architecture-audit.html`.

- **C1 · Extract `loadAll` into `useScheduleData` hook** — `loadAll` is a 150-line async closure in `ScheduleScreen.jsx` that crosses 22 state setters across four independent data-fetch concerns (setup lists, weeks, exclusions, template data); extracting it as a hook creates a testable seam without a full screen render.
- **C2 · Merge `handleGroupDragEnd` / `handleDayDragEnd`** — two 90-line near-identical DnD handlers in `ScheduleScreen.jsx` handle the same three cases (expand-drag, palette drop, slot swap) with byte-for-byte duplicated expand-drag and palette-drop branches; merging them into a single parametrised handler eliminates a locality failure where the same bug can exist in one copy only.
- **C3 · Add `is_locked` to `PROJECTIONS.activities.fields`** — the field is excluded by a comment citing the retired Supabase era; the current write path (`lockActivity` → `repo.writeActivityFields` → `appendOp`) throws `"field not allowed for entity"` on every call, making Lock Activity silently broken in production (`electron/ops/projections.js` lines 122–145).
- **C4 · Add scope-filtered reads to the IPC layer** — `scheduleRepository.reloadSlots`, `reloadOverlays`, and `getSnapshot` each call `localClient.list(entity)` and filter in the renderer; moving filtering to a `listByScope(entity, scopeColumn, scopeId)` IPC primitive places the concern on the correct side of the seam and avoids loading all-weeks rows on every slot mutation.
- **C5 · Deepen `useRouteState` with a `setRouteData` bulk-update method** — the hook's interface exports 16 values matching almost exactly its 8 state atoms; adding a single `setRouteData(route, {...})` method would let `loadAll` update all six route-scoped atoms atomically and allow the raw by-route setters to become internal.
