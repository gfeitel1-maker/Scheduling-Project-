---
title: "Architecture restructure proposal — schedule layer deepening (C1, C2, C4, C5, C6)"
document_type: spec
status: proposed
created: 2026-08-03
task_class: architecture
governing_docs: [docs/governance/standards/ARCHITECTURE_STANDARD.md, docs/governance/standards/TESTING_STANDARD.md, docs/governance/constitution/CONSTITUTION.md]
related_reports: [docs/work/architecture-reports/2026-08-03-architecture-audit.html]
archive_when: C1, C2, C4, C5 and C6 are all landed or explicitly abandoned
---

# Architecture restructure proposal

Source: the 2026-08-03 architecture audit (`docs/work/architecture-reports/2026-08-03-architecture-audit.html`, on branch `work/architecture-audit`). This document is the design layer between that audit and the Maker loop. **No code is changed by this document.**

Inputs: the audit, an Architect design pass, and an adversarial Red Hat risk pass, plus Governor verification of the specific claims where those two disagreed.

## Status of the audit's own findings

- **C3 (`is_locked` projection gap) is already fixed** on `main` (`electron/ops/projections.js:128`). Excluded from this proposal.
- **Line numbers in the audit have drifted ~10 lines.** Current `main`: `loadAll` at `ScheduleScreen.jsx:264`, `handleGroupDragStart` `:506`, `handleGroupDragEnd` `:510`, `handleDayDragStart` `:555`, `handleDayDragEnd` `:559`, `recalcStats` `:462`, `ensureTemplateRow` `:477`, the two `DndContext` wrappers `:1312` and `:1325`.
- **Two of the audit's own proposals were verified wrong and are corrected here**: C5's claim that the raw by-route setters are unused outside `loadAll`, and C4's proposed SQL shape. Both corrections are load-bearing — see the respective sections.

## Non-goals

This proposal deliberately does **not**:

- Change any persisted data shape, migration, op-log record, projection, or replay behavior. Every candidate here is renderer-side or read-side. If a Maker finds themselves editing `PROJECTIONS`, `appendOp`, or a migration, the change has left this spec's scope.
- Change any director-visible behavior, **with one recorded exception**: C2 ships an intentional, product-owner-approved behavior change — group view **gains** slot-swap (`allowSwap: true` at both call sites). See "C2 — Product decision (resolved 2026-08-04)" below. This line previously asserted the opposite and was stale; the resolved decision governs. No other candidate in this proposal changes director-visible behavior.
- Designate either the Manual or the Generated route as canonical, active, or default (CONSTITUTION Art. V; `docs/adr/2026-07-28-plural-candidate-schedules-per-camp.md`).
- Split `useScheduleData` into multiple hooks. The four concerns share one load-on-mount / reload-on-op lifecycle and a data dependency (step 4 consumes step 1's lists); splitting doubles round-trips and adds a stale-closure seam between them.
- Restructure `useGeneration` / `useSnapshots` to consume `setRouteData`. They write single fields to a **non-current** route; the bulk shape does not fit them.
- Extend `listByScope` to entities beyond those already in `PARENT_SCOPED_ENTITIES`.
- Touch `getSnapshot`, `loadTemplateData`, styling, naming, or test coverage generally.
- Fix the pre-existing `loadAll` re-entrancy race as a *separate* piece of work — it is folded into C1 (see C1-R1), because C1 is what makes it cheap to fix and test.

## Sequencing

```
C4  ──►  C5  ──►  C1
C2  (independent, any time)
C6  (docs only, any time)
```

- **C4 first, standalone.** Touches `electron/main.js`, `electron/preload.js`, `electron/ops/campScopedEntities.js`, `src/data/scheduleRepository.js`, `src/localClient.mock.js`, `electron/db/schema.sql`. None of these are touched by C1/C2/C5. Landing it first means `useScheduleData` is written once, against final repository signatures, rather than twice.
- **C5 second.** `setRouteData`'s signature must exist before C1's call site can be written against it. C5 depends on nothing.
- **C1 third.** The C1↔C5 coupling is at the *call site*, not inside the hook: `useScheduleData` never imports or touches `useRouteState`. `ScheduleScreen` takes the hook's `templateData` return and pushes it through `setRouteData(route, …)` once per route. Doing C1 before C5 means writing 12 individual `set*ByRoute` calls that C5 then immediately replaces.
- **C2 is fully independent** — no shared state with any other candidate. Parallel-safe.
- **C6 is a comment.** Parallel-safe.

Each candidate should be its own ticket and its own commit. C4 and C1 each warrant their own Verifier gate run.

---

## C1 — Extract `loadAll` into `useScheduleData`

**Problem.** `loadAll` (`ScheduleScreen.jsx:264–417`) is a ~150-line async closure crossing **22 state setters** across four independent concerns: setup catalog, weeks + `liveWeekId` resolution, week exclusions, template data. None of the four can be tested without mounting the whole screen.

### Seam

New module `src/screens/schedule/useScheduleData.js`.

```js
useScheduleData({ campId, weekId: preferredWeekId, repo, routes }) => {
  setupLists: { groups, days, timeBlocks, activities, anchors, tiers, cohorts },
  weeks,                 // schedule_weeks rows, active + archived, name-filtered
  weekId,                // the LIVE resolved id — the hook owns this
  weekDeletedBanner,     // string | null
  exclusions: { activityExclusions, groupExclusions },
  templateData: {
    existingTemplates, templateIdByRoute,
    slotsByRoute, overlaysByRoute, snapshotsByRoute, statsByRoute, findingsByRoute,
  },
  loading, loadError, templateError,
  reload,                // () => Promise<void>
}
```

Plus two **pure** functions exported from the same module (not hook members):

```js
recalcStats(slotList, ctx) => statsObject      // returns a value; no setState
recalcFindings(slotList, ctx) => findingsArray // returns a value; no setState
```

### Ownership decisions

**`weekId` is owned by the hook; `preferredWeekId` is a one-way input.** `loadAll` already computes `liveWeekId` synchronously rather than via a functional setState — the existing inline comment states why ("a functional setState updater runs asynchronously… which would leave `liveWeekId` null on first load"). Splitting week-id ownership between hook and screen recreates exactly that bug. The screen keeps a `weekId` `useState` solely so the week-switcher `<select>` has a binding and so `[campId, weekId]` remains the effect dep array, and syncs it from the hook's returned `weekId` with a one-line effect. This is resolve-and-propose, not a shared mutable cell.

**`recalcStats` / `recalcFindings` move, and become pure.** Today they close over `setStats`/`setFindings` — route-scoped state the hook does not own. As pure functions of a slot list they test with zero mocking, and the screen decides whether to push the result through `setRouteData` or a single-field setter.

**`ensureTemplateRow` does NOT move.** It is a write path (`repo.createScheduleTemplate`) that mutates `existingTemplates`/`templateIdByRoute`, which live in `useRouteState`. Putting a lazy write inside a read hook reintroduces the exact "hook does two things" problem C1 exists to remove. It stays in `ScheduleScreen`.

**Route data flows out, never in.** `useScheduleData` has no knowledge of `useRouteState`. `ScheduleScreen` wires them. This matches the existing dependency direction — `useGeneration`/`useSnapshots` take setters as *injected* dependencies rather than importing the state hook.

### Moves / stays / deletes

- **Moves:** `loadAll`'s body, `recalcStats`, `recalcFindings`, the `weekId` resolution + lazy-week-creation block, `weekDeletedBanner` state, `loading`/`loadError`/`templateError`.
- **Stays:** `ensureTemplateRow`, all view-level UI state (`view`, `railView`, `editSlot`, `generating`, route selection), all route-scoped state (`useRouteState`).
- **Deletes:** the 22 inline `useState` declarations for loaded data, and `loadAll` itself.

### Deletion test

Passes. Delete `useScheduleData` and four data-fetch concerns plus the week-resolution rules disperse back into the screen. The interface is one hook call purchasing ~150 lines of sequenced, error-partitioned loading.

### Test surface

`renderHook` with an injected fake `repo` (implementing `loadSetupLists`, `loadWeeks`, `createWeek`, `loadWeekExclusions`, `loadTemplateData`). No DOM render, no `DndContext`, no modal wiring. Assertions the current code cannot make cheaply:

- a week deleted on a peer produces `weekDeletedBanner` and a resolved fallback `weekId`;
- `repo.loadTemplateData` throwing sets `templateError` while leaving `setupLists` populated from the earlier successful block;
- **idempotency**: calling `reload()` twice against unchanged DB state produces no further `weekId` change (guards the feedback loop, C1-R2);
- **ordering**: an older in-flight load resolving after a newer one does not overwrite the newer data (guards C1-R1).

`recalcStats` / `recalcFindings` get plain input/output unit tests with no hook at all.

### Red Hat findings

**C1-R1 (MEDIUM, confirmed) — `loadAll` re-entrancy has no in-flight guard, and extraction alone does not fix it.** `loadAll()` is invoked from the mount effect (`:427`) and unconditionally from the `onOpApplied` listener (`:446–453`) on every foreign op. There is no `AbortController`, no generation counter, no latest-load check before any of the 22 setters fire. On a Host absorbing a burst from a syncing Client — a peer's `generate()` produces a bulk-replace op — multiple `loadAll()` calls are concurrently in flight, and an older one can stamp stale slots/stats over fresher data.

*Addressed.* This is a **pre-existing** bug, not introduced by C1, and C1 as a pure lift-and-shift would neither fix nor worsen it. But shipping the extraction and calling it hardening while leaving the race in place is the failure mode to avoid. **A load-generation guard (a `useRef` counter compared before each setter group) is in scope for C1**, with the ordering test above. It is cheap precisely because the hook is now unit-testable — the audit's own leverage argument, applied.

**C1-R2 (MEDIUM structural / LOW likelihood, confirmed) — `weekId` effect-dependency feedback loop.** `useEffect(() => { loadAll() }, [campId, weekId])` calls a function that itself calls `setWeekId(liveWeekId)` (`:345`). Today this terminates: the second pass resolves the same id and React bails on the identical value. It becomes a real oscillation only if week resolution is non-deterministic across calls (e.g. an unstable sort in the first-active-week fallback while two devices race).

*Addressed.* Preserve the existing explanatory comment verbatim next to the `setWeekId` call inside the hook, and add the idempotency test above. The risk of moving it is that the footgun becomes less visible inside a hook boundary than it is inline beside its comment — the comment travelling with the code is the mitigation.

**C1-R3 (LOW, confirmed) — lazy `schedule_weeks` creation racing a peer is NOT a risk.** `:324–328` mints `schedule-week:${campId}:1` — a deterministic id, so two devices racing converge rather than fork, consistent with `duplicateWeek`'s `INSERT OR IGNORE` pattern. *Accepted as a non-issue.* Recorded so no mitigation effort is spent here.

**C1-R4 (LOW, confirmed) — unmount-after-await setState.** No mounted-check before the setters. Under React 18 this is silently no-oped, not a crash or a warning. *Accepted as known risk.* The C1-R1 generation guard incidentally covers most of it.

### Open question

Should `weekDeletedBanner`'s **dismiss** action live in the hook (beside the state that produces it) or stay in the screen (it is UI-transient)? Either is defensible; a one-line placement choice that does not block a Maker.

---

## C2 — Merge the duplicate DnD handlers

**Problem.** `handleGroupDragEnd` (`:510–550`) and `handleDayDragEnd` (`:559–611`) are near-identical. Verified character-by-character: the `expandDrag` branch (`:517–537` vs `:566–586`) and the `paletteActivity` branch (`:540–549` vs `:589–598`) are **byte-for-byte identical**. The audit's central claim holds. The only divergence is a third branch — slot-swap, `:601–611` — present in the day handler and entirely absent (not even a no-op guard) from the group handler. No other divergence exists: variable capture over `slots`/`timeBlocks`/`actMap`/`days` reads the same enclosing scope in both.

### Seam

New module `src/screens/schedule/dragHandlers.js` — a factory, deps injected, no React import.

```js
makeDragHandlers({
  timeBlocks, days, slots, actMap,          // read-only data
  getSlot,                                   // pure lookup
  expandSlot, placeActivityManual, swapSlots, // from useSlotMutations
  setExpandDragActive,                       // this view's own setter
  allowSwap,                                 // boolean capability flag
}) => { handleDragStart, handleDragEnd }
```

Branch order inside `handleDragEnd({ active, over })` is unchanged from today:

1. `if (expandDrag) { … return }` — unconditional, **not** gated by `allowSwap`.
2. `if (paletteActivity) { … return }` — unconditional, **not** gated by `allowSwap`.
3. otherwise: `if (!allowSwap) return` then the slot-swap body.

Call sites:

```js
const groupHandlers = makeDragHandlers({ ...deps, setExpandDragActive: setIsGroupExpandDragActive, allowSwap: false })
const dayHandlers   = makeDragHandlers({ ...deps, setExpandDragActive: setIsDayExpandDragActive,   allowSwap: true  })
```

### Moves / stays / deletes

- **Moves:** the bodies of all four handlers, into one factory.
- **Stays:** both `DndContext` wrappers (`:1312`, `:1325`) — correct DnD-scope isolation; both `PointerSensor` configs with `distance: 8` — untouched and orthogonal; **both** `isGroupExpandDragActive` / `isDayExpandDragActive` state atoms — expand-drag-in-progress is legitimately view-scoped UI state.
- **Deletes:** `handleGroupDragStart`, `handleGroupDragEnd`, `handleDayDragStart`, `handleDayDragEnd`.

### Deletion test

Passes weakly but correctly: deleting the module disperses the single implementation back to two call sites — the same complexity, but restored to a form where the same bug can exist in one copy and not the other. The win is locality, not depth.

### Test surface

`makeDragHandlers` returns plain functions. Call `handleDragEnd({ active, over })` with a hand-built dnd-kit event shape and fakes for `expandSlot` / `swapSlots` / `placeActivityManual`; assert which fired with what arguments. No render, no `DndContext`, no screen.

### Red Hat findings

**C2-R1 (MEDIUM, confirmed) — a careless merge silently enables slot-swap in group view.** Today, group view's inability to swap is guaranteed *textually* — there is no swap code in that function, and a reviewer can eyeball it. After the merge that guarantee is runtime-only, resting on one boolean in a prop-wiring block. Copy-pasting the day `DndContext`'s wiring turns it on with no visible diff signal.

*Addressed.* `allowSwap: false` must be explicit (never defaulted) at the group call site, **and** a regression test is required: drag one filled cell onto another in group view, assert `swapSlots` is not called. This test is a hard requirement of C2, not a nice-to-have — it is the only thing replacing the textual guarantee being removed.

**C2-R2 (LOW, HYPOTHESIS on trigger, real as a naming trap) — collapsing the two expand-drag flags.** The audit's `context = { setIsExpandDragActive, … }` naming invites collapsing two distinct state atoms into one shared setter, which would cross-highlight expand state between views if both `DndContext`s are ever mounted simultaneously. Red Hat could not confirm simultaneous mounting either way from the render tree.

*Addressed by design:* the two setters stay distinct and are passed per call site, as specified above. No shared flag exists to collide.

**C2-R3 — handler referential stability.** `makeDragHandlers` is called once per render. `@dnd-kit` does not require referentially stable `onDragEnd`/`onDragStart`. A `useCallback` wrapper keyed on the injection list is an optional optimization, explicitly **not** a correctness requirement, and should not be added speculatively.

### Product decision (resolved 2026-08-04)

Group view **will** support slot-swap. The same drag-onto-filled-cell action that swaps slots in day view should work identically in group view and record the change correctly in both routes. C2 therefore ships with `allowSwap: true` at **both** call sites. The regression test still applies — it now asserts that swapSlots *is* called in group view (not that it isn't).

---

## C4 — Scope-filtered IPC reads

**Problem.** `scheduleRepository.reloadSlots` / `reloadOverlays` / `loadWeekExclusions` call `localClient.list(entity)` — every row for the camp — and filter in the renderer. `reloadSlots` runs after every slot mutation, so every drag-and-drop loads all slots for all routes and all weeks and discards most of them. The filtering concern is resolved on the wrong side of the IPC seam.

> This is the highest-risk candidate in the proposal, and the audit's proposed shape is **rejected**. Two corrections follow.

### Correction 1 — no caller-supplied column name

The audit proposes `listByScope(entity, scopeColumn, scopeId)`. A column name is a SQL *identifier*: it cannot be bound as a `?` parameter and must be string-interpolated. That directly violates this codebase's own stated read-path discipline (`electron/main.js:48–57`): *entity is validated by exact key lookup, "never regex/prefix match, never string-built into a query."*

The Architect proposed closing this with a new hand-maintained `SCOPE_COLUMNS` map. **That map is unnecessary** — the information already exists. `PARENT_SCOPED_ENTITIES` in `electron/ops/campScopedEntities.js` already records `{ table, parentTable, parentKey }` for exactly the five entities C4 targets, and `parentKey` *is* the scope column (`template_id` for slots/overlays/snapshots, `week_id` for both exclusion tables).

**Adopted signature — the column is never supplied by the caller at all:**

```js
listByScope(entity, scopeId)
```

The injection surface is removed by construction rather than by allowlist, and there is no second registry to drift from the first.

### Correction 2 — keep the camp JOIN

`template_slots` has **no `camp_id` column** (`campScopedEntities.js` comment; confirmed against `schema.sql`). Today `list()` scopes it via `JOIN schedule_templates p ON p.id = t.template_id WHERE p.camp_id = ?`. A flat `SELECT * FROM template_slots WHERE template_id = ?` silently deletes that layer. It is redundant *today* under one-camp-per-device-db — which is precisely why `list()` keeps it anyway: defense in depth against an invariant that is out of this change's scope to guarantee forever.

`listByScope` therefore uses the **same JOIN shape as `list()`, with an additional predicate**, not a replacement for it.

### Interface

Channel: `shoresh:list-by-scope`. Registered in `HANDLER_CHANNELS` (`main.js:909`) and `registerHandlers`, identically to `shoresh:list`.

Preload (`electron/preload.js`):
```js
listByScope: (token, entity, scopeId) =>
  ipcRenderer.invoke('shoresh:list-by-scope', { token, entity, scopeId }),
```

Handler (`electron/main.js`, co-located with `list`):
```js
function listByScope(token, entity, scopeId) {
  if (typeof entity !== 'string' || entity.length === 0) throw new Error('Invalid entity')
  const scope = PARENT_SCOPED_ENTITIES[entity]
  if (!scope) throw new Error(`Unrecognized scoped entity: ${entity}`)
  if (!isNonEmptyString(token)) throw new Error('token is required')
  requireAuthorized(db, { token, action: `${entity}.read` })   // identical to list()

  const camp = db.prepare('SELECT id FROM camps LIMIT 1').get()
  if (!camp) return []

  const { table, parentTable, parentKey } = scope
  return db.prepare(
    `SELECT t.* FROM ${table} t JOIN ${parentTable} p ON p.id = t.${parentKey}
      WHERE p.camp_id = ? AND t.${parentKey} = ?`
  ).all(camp.id, scopeId ?? null)
}
```
Every interpolated identifier (`table`, `parentTable`, `parentKey`) comes from the static registry, reached only by exact-key lookup. No caller string reaches the query text. Authorization is the same `${entity}.read` action as `list()` — no new permission concept.

Repository (`src/data/scheduleRepository.js`):
```js
async reloadSlots(templateId) {
  return normalizeSlots(await localClient.listByScope('template_slots', templateId))
},
async reloadOverlays(templateId) {
  return await localClient.listByScope('template_overlays', templateId)
},
async loadWeekExclusions(weekId) {
  const [activityExclusions, groupExclusions] = await Promise.all([
    localClient.listByScope('week_activity_exclusions', weekId),
    localClient.listByScope('week_group_exclusions', weekId),
  ])
  return { activityExclusions: activityExclusions || [], groupExclusions: groupExclusions || [] }
},
```

Mock (`src/localClient.mock.js`) — must mirror the real predicate, including the parent-camp join semantics, and derive the key from the same registry rather than hardcoding it:
```js
async listByScope(_token, entity, scopeId) {
  const { parentKey } = PARENT_SCOPED_ENTITIES[entity]
  const state = loadState()
  return (state[entity] || []).filter(row => row[parentKey] === scopeId)
},
```

Schema (`electron/db/schema.sql`) — required, not a follow-up:
```sql
CREATE INDEX IF NOT EXISTS idx_template_slots_template_id     ON template_slots(template_id);
CREATE INDEX IF NOT EXISTS idx_template_overlays_template_id  ON template_overlays(template_id);
CREATE INDEX IF NOT EXISTS idx_schedule_snapshots_template_id ON schedule_snapshots(template_id);
```
Confirmed: the schema currently declares only three indexes (`operations`, `conflicts`, `audit_events`) and **none** on `template_id`. These are safe to declare in `schema.sql` (which re-executes on every open) because `template_id` is `NOT NULL` from each table's creation — unlike `schedule_templates.kind`, whose index had to move to a migration for exactly that re-execution reason (see the note at `schema.sql:387–394`).

### Explicitly out of scope for C4

- **`getSnapshot(snapshotId)`** is a by-**id** fetch, not a scope filter. Under the registry-derived signature there is no column to supply, and adding a by-id primitive for one caller is premature generalization. It stays as-is.
- **`loadTemplateData`'s multi-list aggregation** stays on `list()`. It legitimately needs all templates/slots/overlays/snapshots for the camp on initial load, across both routes; there is no single scope id at that call site. C4's whole payoff is the post-mutation reload path, which is where the audit's evidence points.

### Deletion test

Passes for the *seam* — filtering disperses back into the renderer. Note honestly that the underlying filter was never complex: this is seam relocation and an authorization/row-volume improvement, not a depth argument.

### Test surface

Handler-level: hand-built `db`, assert rejection for an entity absent from `PARENT_SCOPED_ENTITIES`, assert correct rows for a valid one, assert the camp predicate is applied. Repository-level: fake `localClient.listByScope` spy, assert exact args. **Plus a mock/real parity test** (see C4-R3).

### Red Hat findings

**C4-R1 (HIGH, confirmed) — SQL injection via `scopeColumn`.** *Addressed by Correction 1: the parameter no longer exists.*

**C4-R2 (MEDIUM, confirmed) — dropping the camp JOIN silently deletes a defense-in-depth layer.** *Addressed by Correction 2: the JOIN is retained and the scope predicate is additive.*

**C4-R3 (MEDIUM, confirmed) — mock/real divergence.** `src/localClient.mock.js` backs the browser dev renderer (`npm run dev`); the real path only runs under `npm run electron:dev`. Today all five read call sites route through `list()` uniformly, so no asymmetry is possible. C4 introduces the first place where the two implementations can silently disagree, and the disagreement is invisible until someone compares the two run modes.

*Addressed.* A shared parity test is a **required** part of C4: the same fixture data fed to the mock's `listByScope` and to the real handler must produce identical output. Deriving the mock's filter key from `PARENT_SCOPED_ENTITIES` (as specified above) rather than hardcoding it removes the most likely drift vector.

**C4-R4 (MEDIUM, confirmed mechanism) — `scopeId` of `undefined` on an unminted template.** Today `reloadSlots(templateId)` with a derived-but-never-written id returns `[]` harmlessly from the renderer-side filter. `better-sqlite3` rejects `undefined` bind parameters (it requires `null`). Every route starts unminted, so this is the single most common state, not an edge case.

*Addressed.* `scopeId ?? null` at the bind site (already in the handler above), plus an explicit test for the unminted-template case.

**C4-R5 (LOW, confirmed-absent) — tombstone resurrection does not apply.** There is no `deleted_at`/soft-delete column anywhere in `schema.sql`; `deleteRecord.js` performs a real `DELETE` through the op-log. There is nothing to resurrect. Recorded as CONFIRMED-ABSENT so it is not re-litigated.

**C4-R6 (LOW) — does any caller rely on getting all rows?** Only `loadTemplateData`, which is explicitly excluded above. `reloadSlots`/`reloadOverlays` already discard everything outside the template, and `loadWeekExclusions` everything outside the week. *Accepted: no caller loses data.*

### Open question

`schedule_snapshots` gets an index under C4 but no call site converted (`getSnapshot` stays on `list()`). Should the index still land now, or wait for a caller? Recommendation: land it — it also serves `loadTemplateData`'s existing scan, and splitting the schema change across two tickets is worse than one unused index.

---

## C5 — Deepen `useRouteState`

**Problem.** 90 lines, 16 exports, 8 state atoms — interface width ≈ implementation width. `loadAll` performs 6 separate `set*ByRoute` calls per route (12 total) to bulk-load, with no atomicity guarantee beyond React 18's automatic batching.

### The audit's premise is partly false, and the honest scope is smaller

The audit states the raw by-route setters *"are only used by `loadAll` and the bulk-init in `EMPTY_BY_ROUTE`, not by the mutation hooks,"* and can therefore be made internal. **This was independently verified false by both the Architect and Red Hat:**

- `src/screens/schedule/useGeneration.js:43–47, 60–64, 141–145` destructures `setSlotsByRoute`, `setFindingsByRoute`, `setDismissedByRoute`, `setOverlaysByRoute`, `setStatsByRoute` and wraps each with `routeSetter(setXByRoute, 'generated' | 'manual')`.
- `src/screens/schedule/useSnapshots.js:32, 46` does the same with `setSnapshotsByRoute`.

Both use **route-explicit**, not current-route, setters — deliberately, because `generate()` / `placeAnchors()` can fire before a route switch has committed to React state. The audit's own "What is clean" section praises this exact pattern three sections after proposing to remove the mechanism it depends on.

Concrete failure mode had it shipped as written: a director on the Manual route clicks Generate; `useGeneration` targets `'generated'` regardless of what is on screen; with only `setRouteData` (all six fields at once) and current-route setters available, it either cannot write at all, or a lazy substitution of `setSlots` for `setSlotsByRoute` writes the generated schedule **into the visible Manual route**, corrupting the director's hand-built schedule.

**Decision: the raw by-route setters stay exported.** `setRouteData` is added alongside them.

### Interface

```js
setRouteData(route, { slots, stats, findings, dismissed, overlays, snapshots,
                      existingTemplate, templateId })
```

- The six route-scoped data keys are **required**; the method throws if any is omitted. **Semantics are REPLACE, not merge** — a partial call fails loudly rather than silently leaving a stale field. Today's only caller sets all six unconditionally, so this costs nothing and forecloses the ambiguity permanently.
- `existingTemplate` and `templateId` are **optional** (`!== undefined` guard). They belong in the payload because `loadAll` sets them in the same per-route loop; making them optional keeps the door open for callers that legitimately do not touch template existence.
- `dismissed` is assigned **wholesale** per route. It holds a `Set`; there must be no merge of dismissed keys across a `setRouteData` call — dismissal state resets when findings recompute (`useRouteState.js:41–43`, `ScheduleScreen.jsx:412`). Existing `routeSetter` semantics already replace wholesale; preserve that.

### Moves / stays / deletes

- **Moves:** nothing.
- **Stays:** all 16 current exports, including every raw by-route setter, `routeSetter`, `templateIdFor`, and all current-route setters.
- **Deletes:** 12 individual `set*ByRoute` calls at the `loadAll` call site, replaced by 2 `setRouteData` calls.

### Deletion test and honest accounting

**The interface does not get narrower: 16 exports → 17.** Say this plainly rather than claiming the audit's "hide 8 setters" win, which the code does not permit. The deletion-test verdict on `useRouteState` is unchanged — shallow-ish, with `routeSetter` as its one piece of genuine depth. The real gains are narrow but real: one caller's 12 scattered calls become 2, and that caller can no longer partially update a route.

### Test surface

`renderHook(useRouteState)`; assert `setRouteData('generated', {…})` updates all six atoms for `generated` and leaves `manual` untouched; assert a partial payload throws; assert `dismissed` is replaced rather than merged; assert the raw route-explicit setters still work (regression guard for the `useGeneration`/`useSnapshots` path).

### Red Hat findings

**C5-R1 (HIGH, confirmed) — hiding the raw setters breaks `useGeneration` and `useSnapshots`.** *Addressed: the design is corrected above; the setters stay exported. This was a blocking defect in the audit's proposal, not a risk to monitor.*

**C5-R2 (MEDIUM) — merge-vs-replace ambiguity.** *Addressed: replace semantics, required keys, throw on partial.*

**C5-R3 (LOW) — `dismissedByRoute` Set spread hazard.** *Addressed: wholesale replacement is specified and matches existing behavior. Flagged so an implementer does not "improve" it into a merge.*

### Open question

Given the premise changed — no narrowing, +1 export — is C5 still worth doing? **Recommendation: yes, but it is now the lowest-value item in this proposal.** The atomicity guarantee and the 12→2 call-site reduction are real and low-risk. If sequencing pressure forces a cut, C5 is the one to drop, and C1 falls back to writing the 12 calls itself. Confidence: moderate.

---

## C6 — Document the raw-SQL pre-insert in `duplicateWeek.js`

Docs only. No code change. Replace the partial comment at `electron/ops/duplicateWeek.js:68–74`:

```js
// DELIBERATE op-log invariant deviation, not an oversight: schedule_templates.week_id
// carries a NOT NULL FK to schedule_weeks, so the new week's row must exist inside
// THIS transaction before any template op below can be appended and applied. A raw
// INSERT OR IGNORE (placeholder name='', sort_order=0) is safe because:
//   1. It is inside the same db.transaction() as every op below — a rollback here
//      rolls back the raw insert too, so no partial state is ever visible.
//   2. The ops appended later in this same transaction (the week-row ops near the
//      end of this function) UPDATE this row with the real name/sort_order via
//      applyProjection, so the creating device's final state is correct.
//   3. On a peer device this raw insert is never replicated — only the ops are.
//      The peer's own schedule_weeks ensureExists (op replay path) performs the
//      equivalent INSERT OR IGNORE from op data, so convergence holds.
// Cost: the week's row-creation event itself has no op-log entry — an observer
// reading the op log sees the first `name` write as if it were the creation. This
// is a known, accepted auditability gap, not a correctness gap.
```

**Open question:** none. If the op log is ever required to be auditability-complete, that is a separate ticket with a real code change (an explicit creation op), not this one.

---

## Where this proposal overrides the audit

Recorded so the audit is not re-read as authoritative on these points:

| Point | Audit said | This proposal says | Basis |
|---|---|---|---|
| C4 signature | `listByScope(entity, scopeColumn, scopeId)` | `listByScope(entity, scopeId)`; column derived from `PARENT_SCOPED_ENTITIES.parentKey` | Caller-supplied identifier is an injection surface and violates `main.js:48–57` |
| C4 SQL | flat `SELECT … WHERE col = ?` | JOIN through parent + `camp_id` predicate, plus the scope predicate | `template_slots` has no `camp_id`; `list()` keeps the JOIN deliberately |
| C4 indexes | not mentioned | required in the same change | No index on any `template_id` column exists today |
| C5 raw setters | can be made internal | must stay exported | `useGeneration` and `useSnapshots` write route-explicitly to the non-current route |
| C5 interface | narrows | widens 16→17 | Counted |
| C1 race | not addressed | generation guard in scope | No in-flight guard exists; `onOpApplied` calls `loadAll` unconditionally |

## What a Maker must not conclude from this document

- That C1 fixes the `loadAll` race **by extraction**. It does not. The guard is a separate, explicit requirement inside C1.
- That C2 is a pure refactor **once merged**. The group-view no-swap guarantee changes from textual to runtime; the regression test is what carries it.
- That C4 is a performance ticket. It is a seam and authorization ticket; the row-volume improvement is a consequence, and no performance claim here rests on a measured baseline.
