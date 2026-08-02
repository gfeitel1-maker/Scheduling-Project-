---
title: T28-schedule-screen-has-no-persistence-seam
document_type: ticket
status: completed
created: 2026-08-01
governing_docs: [docs/governance/standards/ARCHITECTURE_STANDARD.md, docs/governance/standards/TESTING_STANDARD.md, docs/governance/constitution/CONSTITUTION.md]
related_adrs: [docs/adr/2026-08-01-schedule-screen-persistence-seam.md]
related_runs: [docs/work/runs/2026-08-01-t28-schedule-persistence-seam-run.md]
resolved_by: [src/data/scheduleRepository.js]
archive_when: resolved
---

# T28 — The schedule screen has no persistence seam; data logic is scattered, duplicated, and untestable

**Risk:** Low to ship (behaviour-preserving refactor), but the *status quo* carries a live
correctness hazard (three drifting row-mappers) and blocks testing of all schedule persistence.
**Found:** 2026-08-01 sprawl assessment of `ScheduleScreen.jsx`.
**Blocked on:** acceptance of [ADR 2026-08-01](../../adr/2026-08-01-schedule-screen-persistence-seam.md).
This ticket does not get dispatched until that ADR is `accepted` (`CONSTITUTION.md` Art. IV).

---

## What is wrong

`src/screens/ScheduleScreen.jsx` (2,277 lines) talks to the data layer directly, everywhere. There
is no module between it and `localClient` (itself a thin IPC pass-through, `src/localClient.js:1`).
So persistence is smeared across ~20 handlers with no place to enter, leave, or test.

**Measured, not inferred** (current `main`, `c21266f`):

- **27** direct `localClient.*` calls across ~20 handlers.
- The auth token is re-read from `localStorage` at **6** write sites: `:35`, `:516`, `:738`,
  `:811`, `:853`, `:958`.
- The engine-slot → DB-row mapping is hand-written **3 times and already drifts**: `generate()`
  `:511-522`, `placeAnchors()` `:952-963`, `restoreSnapshot()` `:847-857`. `generate` emits
  `is_span_head`; the other two do not. (7 `crypto.randomUUID()` row-builders total.)
- Write-failure→message copy is duplicated, including **4** `includes('admin role required')`
  branches.
- `writeFields` (`:34`) is the one shared helper, and its own comment admits it is copy-pasted
  from `DayOverridesScreen.jsx`/`ActivitiesScreen.jsx`, not shared.

## Why it matters

- **Untestable persistence.** `generate`, `restoreSnapshot`, and every slot mutation can only be
  exercised by mounting the whole 2,277-line screen. The only unit-tested schedule module today is
  the pure engine — the *data seam*, which this project's defaults say to test first, has no seam
  to test at.
- **A live drift hazard.** Three copies of the same mapping guarantee they keep diverging;
  `is_span_head` already differs between them.
- **A known, repeat bug class with nowhere to live.** `ARCHITECTURE_STANDARD.md` §2 records that an
  unregistered-`PROJECTIONS` write silently never materializes, and that it bit `schedule_templates`
  and `schedule_snapshots` — both schedule entities. A persistence module is where that knowledge
  belongs and where the next such bug is caught once.
- **It compounds.** Prior-year ingestion (ADR, today) and the structure-tree spec add more schedule
  writes; each one added around the god component instead of through a seam makes the next harder.

## Scope

**In scope** — introduce `src/data/scheduleRepository.js` per the ADR: a React-free module of async
functions that own token acquisition, all schedule `list`/`write`/`bulkReplace`/`deleteEntity`
calls, the single engine-slot↔DB-row and snapshot↔DB-row mappings, `normalizeSlots` on read, and
write-result→typed-error translation. Dependencies (`localClient`, token source) are injected so the
module is unit-testable without React or Electron. Rewire every schedule handler
(`loadAll`, `ensureTemplateRow`, `generate`, `placeAnchors`, `editSlotSave`, `swapSlots`,
`releaseCell`, `addOverlay`/`removeOverlay`/`updateOverlayRange`, `saveSnapshot`/`deleteSnapshot`/
`restoreSnapshot`/`renameSnapshot`, `placeActivityManual`, `expandSlot`, `splitSlot`,
`dismissFlag`, `lockActivity`) to call it.

**Out of scope** (each its own later ticket/ADR, per the assessment's four targets):

- Grid-geometry / cell-decision extraction (the ~29-prop views).
- Feature hooks (undo/redo, clipboard/selection, snapshots, generation).
- Route-state (`byRoute`) encapsulation.
- Any change to the pure engine, to `PROJECTIONS`, to the IPC surface, or to the sibling screens'
  copy-pasted `writeFields` (their consolidation, if wanted, is a separate follow-up — do not widen
  this refactor to them under §8).

**Non-negotiable boundaries** (`ARCHITECTURE_STANDARD.md`): stays behind `localClient`/IPC (§1),
same op-log primitives and entities (§2), engine stays pure — mapping does not move into it (§7),
inline styling untouched (§6, N/A here). Zero user-visible behaviour change.

## Completion evidence

1. `ScheduleScreen.jsx` has **zero** direct `localClient.*` calls for schedule entities and
   **zero** inline `localStorage.getItem('shoresh-token')` reads — grep-verified.
2. Exactly **one** engine-slot→DB-row mapper exists; `generate`, `placeAnchors`, and
   `restoreSnapshot` all use it (the `is_span_head` drift is gone).
3. `src/data/scheduleRepository.js` has unit tests that drive it with a fake `localClient` and
   assert the exact rows/fields passed to `write`/`bulkReplace`, with no React render and no
   Electron.
4. Every existing `ScheduleScreen.test.jsx` case passes **unchanged**; full `npm run test` is green.
5. `npm run check:governance`, `npm run lint`, `npm run build` all pass.
6. Diff confirms: no new entity, no `PROJECTIONS` change, no new IPC channel, no engine change.
