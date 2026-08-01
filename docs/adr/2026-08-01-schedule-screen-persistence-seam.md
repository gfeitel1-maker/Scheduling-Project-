---
title: "A persistence seam for the schedule screen"
document_type: adr
authority: normative
status: accepted
date: 2026-08-01
supersedes: []
implementation_state: implemented
affects:
  - src/screens/ScheduleScreen.jsx
  - docs/governance/standards/ARCHITECTURE_STANDARD.md
---

# A persistence seam for the schedule screen

**Status: ACCEPTED — product owner instructed "write the spec and work through it until done"
(2026-08-01).** That explicit human instruction is the highest authority (`CONSTITUTION.md` Art. I)
and satisfies the Art. IV gate that an architecture change be backed by an accepted ADR before
implementation; [T28](../work/tickets/T28-schedule-screen-has-no-persistence-seam.md) is therefore
cleared for dispatch. This is the first of four decoupling steps in the 2026-08-01 program
(`docs/work/specs/2026-08-01-schedule-screen-decoupling-design.md`); **it decides only the
persistence seam.** Grid-geometry extraction (T29), feature hooks (T30), and route-state
encapsulation (T31) are governed by that spec and get their own ADRs only if implementation surfaces
a genuinely new architectural contract.

---

## Context

`src/screens/ScheduleScreen.jsx` is the app's largest file (2,277 lines) and its most complex
screen. It is a god component: it owns the schedule's React state (46 `useState` calls), all of
its orchestration (~50 handlers), and **all of its persistence**. This ADR is about the last of
those three.

### The persistence logic is scattered, duplicated, and untestable — measured

There is no seam between the screen and the data layer. `localClient` is a thin pass-through to
the Electron IPC bridge (`src/localClient.js:1` — "Thin wrapper around window.shoresh"); it is not
a domain repository. So the screen builds raw `entity / field / value` writes inline, in every
handler that touches data. Measured on the current file (`c21266f`):

- **27 direct `localClient.*` calls** across ~20 handlers — no single place data enters or leaves
  the screen.
- **The auth token is re-read from `localStorage` at 6 separate write sites** (`:35`, `:516`,
  `:738`, `:811`, `:853`, `:958`) rather than acquired once behind an interface.
- **The engine-slot → database-row mapping is written three times, with drift.** `generate()`
  (`:511-522`), `placeAnchors()` (`:952-963`), and `restoreSnapshot()` (`:847-857`) each hand-map
  camelCase engine/snapshot objects to snake_case DB rows, mint UUIDs, stamp `template_id`, and
  `JSON.stringify` flags — and they already differ (`generate` writes `is_span_head`; the others
  do not). Seven `crypto.randomUUID()` row-builders exist in the file.
- **Write-failure-to-message translation is duplicated**, including four separate
  `err?.message?.includes('admin role required')` branches.
- The `writeFields` helper (`:34`) is the one shared piece — and its own comment records that it
  is **copy-pasted**, not shared: "mirrors DayOverridesScreen.jsx/ActivitiesScreen.jsx's identical
  helper".

The consequence that matters most: **none of this persistence logic can be unit-tested.** It is
fused into a 2,277-line React component, so `generate`, `restoreSnapshot`, and every slot mutation
can only be exercised by mounting the whole screen. Today the *only* unit-tested module in the
schedule feature is the pure engine (`src/engine/buildSchedule.js`). The persistence code — which
is exactly the "data seam" this project's own defaults say to test first — has no seam to test at.

### Why now

Two forces make this the right moment, not a someday:

1. **This exact class of bug has already cost real time — twice.** `ARCHITECTURE_STANDARD.md` §2
   records that an unregistered-`PROJECTIONS` write "silently never materializes," and that this
   bit `schedule_templates` and `schedule_snapshots`. Both are schedule-screen entities. A single
   place that owns schedule persistence is where that knowledge belongs and where the next such
   bug gets caught once instead of per-caller.
2. **More schedule work is actively landing.** `docs/adr/2026-08-01-ingesting-a-prior-year-schedule.md`
   (today) and the structure-tree spec both add to this feature. Every feature added to the god
   component compounds the cost; a seam added now is paid for by the next feature that writes
   through it instead of around it.

### What is already decoupled — and stays untouched

The assessment found the hard, pure logic is already clean: the engine, and the helper layer
(`computeOverlaps`, `normalizeSlots`, `normalizeActivityEligibility`, `exportSchedule`,
`resolveSelection`, `snapshotRestore`, `snapshotMatchesSchedule`), plus the good leaf components.
This ADR does not touch any of them. It consolidates only the scattered *imperative persistence*
that currently has no home.

## Decision

### 1. Introduce one renderer-side schedule persistence module — a deep seam

Add `src/data/scheduleRepository.js`: a small set of async functions that own every read and write
the schedule screen makes, and hide the mechanics behind them. Its interface is small; its
implementation absorbs what is today smeared across the screen. Indicative surface (final names
settle in T28):

- `loadScheduleData(campId)` → the six setup lists + per-route templates/slots/overlays/snapshots,
  already filtered by `camp_id` and normalized (folding in the `loadAll()` read fan-out at `:324`).
- `saveGeneratedWeek(templateId, engineSlots)` / `saveManualAnchors(templateId, engineSlots)` —
  own the slot→row mapping and the `bulkReplace` (folding `generate`/`placeAnchors`).
- `restoreSnapshotRows(templateId, snapshot)` — owns the snapshot→row mapping and its `bulkReplace`.
- `saveSnapshot`, `deleteSnapshot`, `renameSnapshot`, `writeSlotFields`, `writeOverlay`,
  `removeOverlay`, `ensureTemplateRow` — the field-level writes, each returning plain data or
  throwing a typed persistence error.

The **single slot→row mapper lives here, once**, replacing the three drifting copies.

### 2. The module owns persistence mechanics, and nothing else

In-scope for the module: token acquisition, `list` / `write` / `bulkReplace` / `deleteEntity`
calls, the engine-slot↔DB-row and snapshot↔DB-row mappings, `normalizeSlots` on read, and
translating a non-`applied`/`queued` write result into a typed error the screen can render.

Explicitly **out** of the module, staying in the screen: all React state, all `set…Error` banner
copy and UI reaction, the two-route selection *policy* (which route is on screen), and any engine
call. The module returns data and throws; the screen decides what to show. This keeps it a
persistence seam, not a second god object.

### 3. Dependencies are injected, so the seam is the test surface

The module takes its collaborators as arguments — `localClient` (or a `write`/`list` pair) and a
token source — rather than importing the singleton. This is the whole point of the seam: a test
drives `saveGeneratedWeek` with a fake `localClient` and asserts the exact rows handed to
`bulkReplace`, with no React and no Electron. The screen wires in the real `localClient` at the
call site.

### 4. Boundaries that do not move

- **Still through `localClient`/IPC.** This is a renderer-side module that *calls* `localClient`;
  it holds no DB handle and no SQL (`ARCHITECTURE_STANDARD.md` §1).
- **Still the op-log, no new entity.** Same `write`/`bulkReplace` primitives, same entities, no
  `PROJECTIONS` change (§2).
- **Engine stays pure.** The slot→row mapping is a *persistence* concern and belongs in the
  repository; it does not move into `buildSchedule.js`, which keeps its purity guarantee (§7).

### 5. Behaviour-preserving, and scoped to the schedule screen only

This is a pure refactor: **zero user-visible change.** It is not generalized into an all-screens
repository. `ARCHITECTURE_STANDARD.md` §8 forbids premature abstraction, and there is today
exactly one consumer — a hypothetical seam, not a real one. If a second screen later needs the
same shape, that is when the seam is proven real and can be widened; not before.

### Alternatives considered and rejected

- **Do nothing / keep it inline.** Rejected: the duplication is measured and already drifting
  (§Context), the persistence code is untestable, and the cost compounds with each new schedule
  feature.
- **A React hook (`useScheduleData`) that also owns the state.** Rejected *for this step*: it
  couples persistence to React (re-introducing the untestability we are removing) and conflates
  this decision with the later route-state/feature-hook work. State extraction is a separate,
  later ADR; this one keeps the module React-free on purpose.
- **Push the mapping into the engine.** Rejected: it would make the pure engine know the database
  row shape, violating §7. Mapping is persistence, not scheduling.
- **A generic per-entity repository shared by every screen.** Rejected now under §8 (one consumer
  = premature). Scoped to the schedule screen; revisit when a second consumer exists.

## Consequences

- The schedule screen stops calling `localClient` directly and stops re-reading the token; it
  calls named repository functions. It shrinks toward orchestration, which is what a screen should
  be.
- Schedule persistence gains its first unit tests — the row mappings and write-result handling
  become directly assertable, closing the gap where the only tested schedule module was the engine.
- The three drifting slot→row mappers collapse to one, removing a live correctness hazard
  (`is_span_head` present in one copy, absent in two).
- A future PROJECTIONS/write bug in the schedule feature has one place to be found and fixed
  (locality), rather than up to 20 call sites.
- This is one step. The god component is not "fixed" by it — grid-geometry extraction, feature
  hooks, and route-state encapsulation remain, each its own future ADR. This ADR should not be read
  as claiming otherwise.
- Risk: because it is behaviour-preserving with no visible change, a regression would be silent.
  The mitigation is that the refactor is gated on the new unit tests plus the full existing suite
  staying green — deterministic evidence, not inspection.

## Completion evidence

1. `src/screens/ScheduleScreen.jsx` contains **zero** direct `localClient.*` calls for schedule
   entities and **zero** inline `localStorage.getItem('shoresh-token')` reads — both now behind
   `scheduleRepository`.
2. Exactly one engine-slot→DB-row mapping exists in the codebase; `generate`, `placeAnchors`, and
   `restoreSnapshot` all route through it.
3. `src/data/scheduleRepository.js` has unit tests that drive it with a fake `localClient` and
   assert the rows/fields handed to `write`/`bulkReplace` — with no React render and no Electron.
4. The app behaves identically: every existing `ScheduleScreen` test passes unchanged, and the
   full suite (`npm run test`) is green.
5. `npm run check:governance`, `npm run lint`, and `npm run build` pass.
6. No new entity, no `PROJECTIONS` change, no new IPC channel, no engine change — verified by diff.
