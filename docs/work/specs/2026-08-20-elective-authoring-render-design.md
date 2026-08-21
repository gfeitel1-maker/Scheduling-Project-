---
title: "Elective inline authoring + render — design"
document_type: spec
status: draft
created: 2026-08-20
governing_docs: [docs/governance/constitution/CONSTITUTION.md, docs/governance/standards/ARCHITECTURE_STANDARD.md, docs/governance/standards/DESIGN_STANDARD.md]
related_adrs:
  - docs/adr/2026-08-20-electives-authoring.md
  - docs/adr/2026-08-20-in-context-knowledge-and-durability-tiers.md
  - docs/adr/2026-08-12-drag-live-write-serialization.md
  - docs/adr/2026-08-06-schedule-canvas-visual-layer.md
related_tickets: [docs/work/tickets/T105-elective-inline-authoring-and-render.md, docs/work/tickets/T104-elective-cell-atomic-content-and-mutual-exclusion.md, docs/work/tickets/T103-electives-sets-crud-and-durability-marker.md, docs/work/tickets/T109-orphaned-span-tail-reconciliation-guard.md]
archive_when: T105 ships and merges, or is superseded by a ratified ADR
---

# Elective inline authoring + render — design

## Deterministic evidence gathered (current tree, verified by reading, not memory)

- `elective_sets` and `elective_set_activities` are **already registered in `PROJECTIONS`**
  (`electron/ops/projections.js:397-449`), each with an `ensureExists` that seeds the parent row from
  whichever field arrives first. This means writing a brand-new set + members needs **no new IPC
  handler** — the existing generic per-field write path (`repo.writeSlotFields`-shaped calls through
  `window.shoresh.write`) already accepts `elective_sets`/`elective_set_activities` writes exactly the
  way `createActivityFromCell` writes `activities` fields today. Confirmed by reading the registration
  block, not inferred.
- `listDurableElectiveSets(db, campId)` (`electron/ops/durableElectiveSets.js`) already exists (T103) and
  is the single sanctioned read for `is_reusable = 1` rows. It has **zero production callers today** —
  T105 is genuinely its first consumer.
- `MUTUALLY_EXCLUSIVE_FIELDS` and `sanitizeMutuallyExclusiveRow` are **shipped** (`ef51354`, T104) in
  `electron/ops/projections.js:697-`, covering both `applyProjection` and both `bulkReplace` insert sites.
  T105 does not touch this mechanism; it is a dependency, already load-bearing.
- `createActivityFromCell` (`src/screens/schedule/useSlotMutations.js:943`) and `CellInlineEditor`
  (`src/components/schedule/CellInlineEditor.jsx`) are the reuse target. `CellInlineEditor` today is a
  single `<input>` with a live suggestion list; `onPlace(activityId)` / `onCreateNew(name)` are its only
  two commit paths, wired from `SlotCell.jsx:340`.
- `replaceSlot` (`useSlotMutations.js:237-`) already does exactly the multi-cell atomic pattern T105 needs
  for span-head conversion: `collectSpanTails` walks forward from a head cell, and the dispatch fires
  `Promise.all([...])` across target + tails inside one `claimAndRun` keyed lock — the identical shape
  T105 must reuse for "convert a span head to an elective."
  Verified: this is a private (non-exported) `collectSpanTails` closure. **T105 must add its own elective
  variant, not literally call `replaceSlot`** (see §1).
- `useFlagChangeAck` (`src/screens/schedule/useFlagChangeAck.js`) is the concrete render-time-diff
  technique the T104 design doc says `useContentRaceFlag` should mirror: a `useRef` map of
  `cellKey -> signature`, diffed on every `slots` change inside a `useEffect`, reset on route-switch/
  resync-token bump, `useState` for the exposed result. This file is short (≈115 lines) and is the closest
  possible template — `useContentRaceFlag` should be read as "the same shape, different signature
  function," not a novel mechanism.
- `FLAG_COLORS` / `FLAG_SEVERITY` (`src/components/schedule/slotCellConstants.js`) are simple object
  literals with `danger`/`caution`/`info` severities already in use. Adding `CONTENT_RACE` is a
  same-shape entry, no new token.
- `exportToExcel` (`src/utils/exportSchedule.js:1-`) branches per-cell on `slot.is_anchor` →
  `slot.activity_id` → `''`. It has **no `elective_set_id` branch at all today** — an elective cell
  exports as a blank string, confirmed by reading the function.
- No `locations`-based capacity/eligibility fields exist yet on `elective_sets`/`elective_set_activities`
  (checked `v35`/`v36` migration content via the rollback files, which enumerate exactly what those
  migrations added: `elective_sets`, `elective_set_activities`, `template_slots.elective_set_id` in v35;
  `elective_sets.is_reusable` in v36). D3 (capacity/eligibility) is **not yet schema-backed** — flagged as
  an open question below; the ticket's stated scope (T105) does not list D3 as in-scope, only D1/D2/render/
  export, so this design treats D3 as explicitly out of scope for this pass, consistent with the ticket.

## Candidate approaches considered (§1 — inline authoring interaction shape)

Diverged under 4 frames (regulator, speedrunner, logistics, inversion) against the concrete constraint: a
single `<input>` inside a ~100px grid cell must capture "set name" + "N member names (new or existing)"
in one gesture, on both routes, with the legacy single-activity path staying byte-for-byte unchanged for
directors who are not making an elective.

Clusters that emerged:

- **Delimiter-grammar plays** `[N6 V9 F9]` — one input, a punctuation convention distinguishes
  `name: member, member, member` from a plain activity name; legacy path untouched when no delimiter is
  present. Lowest surface area, highest viability — no new interaction model, one parse function.
- **Chained-commit / re-arm plays** `[N7 V7 F8]` — first Enter commits the set name, the identical input
  re-opens primed for member entry, each further Enter appends one member, a blank Enter or Escape closes.
  Higher novelty, comparable viability, but two visually-identical-but-behaviorally-different modes of the
  same input risk directors not realizing they're mid-elective (an inversion-frame trap: "confusing state
  that looks unchanged").
- **Grid-as-input plays** (harvesting mode: click sibling cells to add existing activities as members;
  span-drag-as-member-count) — traps. Reason: repurposes gestures (click-to-navigate, span-drag) that
  already have a different meaning elsewhere in the grid; collides with existing DnD/click semantics
  (`distance: 8` activation constraint, T92 merge/split handles) and would need its own adversarial pass
  against those, disproportionate to the ticket.
- **Deferred/lazy-resolution plays** (JIT member pull on hover; two-phase manifest confirm before write) —
  traps. Writing the set with zero members and back-filling later creates a transient, real, synced row
  that is momentarily an elective with no members — exactly the kind of "not really atomic" state D4/T104
  exists to prevent one layer up. A manifest-confirm step before commit is a soft modal in spirit (a
  blocking review gate before the write fires), which the ADR's "no mandatory setup screen, no
  interrogation" language rules out even at cell scale.
- **NLP/freeform parsing** — trap. No existing parser in the codebase does this; disproportionate new
  surface for a one-ticket feature, and unpredictable failure modes for a director who is not a
  power-user.

**★ Converge (non-obvious-but-viable pick): delimiter grammar with a live inline preview.** Not the literal
first-three-obvious answer (a popup form, a multi-select dropdown, a comma-only list with no set name) —
it keeps the single-input constraint intact by construction, degrades safely to the existing single-
activity path, and borrows the regulator-frame idea of a small live preview strip (chips) rendered
*beneath* the cell during editing only — an edit-time-only visual growth, not a permanent layout change,
matching the schedule-canvas ADR's "ephemeral state via CSS, not new persisted layout" posture.

## Approach

### 1. Inline authoring interaction

**Grammar:** `<set name>: <member 1>, <member 2>, ...` typed into the existing `CellInlineEditor` input.
A colon is the trigger — chosen because activity names in this app are free text and could legitimately
contain a comma (rare, but colon is the character least likely to collide, and the ADR's own example
"Afternoon Chugim" has no punctuation). Detection: on every keystroke, if the current value contains `:`,
switch the editor into elective-authoring render mode; if it does not, the editor behaves **exactly as
today** — this is the load-bearing branch that keeps the legacy `createActivityFromCell` path byte-for-
byte unchanged (T104 design doc's own "smallest responsible" bar applies here too).

**Colon-in-activity-name guard (Red Hat, round 1 revision): exact-match-first, delimiter-second.** A real
activity can legitimately contain a colon (e.g. "Free Time: Cabin Choice"), and the naive rule above would
misfile that single activity as a one-member elective the moment the director typed the colon. The commit
logic (not the live-render mode) must check exact match **before** treating the string as elective grammar:

```
on commit (Enter/blur):
  if value (untrimmed of its colon) exactly matches an existing activity's normalizeName(name)
    (i.e. the WHOLE typed string, colon included, is a real activity name):
      → treat as the single-activity path (existing onPlace/onCreateNew), exactly as if no colon
        grammar existed at all — this is checked FIRST, before any colon-splitting.
  else if value contains ':':
      → elective grammar applies (parse setName/memberNames, onCreateElective)
  else:
      → existing single-activity path, unchanged
```

Live-typing render (the chip preview) may still show provisionally as elective-mode while the string is
being typed — that is harmless, ephemeral UI feedback, not a write — but the **commit-time** check is what
actually decides which path fires, and it always tries the full-string exact activity match first. This
means a director who has (or creates) an activity literally named "Free Time: Cabin Choice" gets that
single activity, not a garbled one-member elective, regardless of typing order. The colon itself remains an
explicit open tuning point (see Open Questions #2) — Designer/Tester should validate it against real camp
activity-name conventions before this ships, not treat it as locked by this doc.

**`CellInlineEditor` changes (additive, not a rewrite):**
- Parse `value` into `{ setName, memberNames[] }` when a `:` is present: everything before the first `:`
  is `setName` (trimmed), everything after, split on `,`, trimmed, empty tokens dropped, is `memberNames`.
- While in elective mode, render a small chip row **below** the input (inside the cell's existing overflow
  container, not a portal/popover) showing each parsed member token, live, with a per-chip marker: exact
  match against `eligibleActivities` (existing name) vs. no match (will be created) — reusing the same
  `normalizeName` substring-match logic `CellInlineEditor` already runs for the single-activity case, not
  a new matcher.
- Enter (or blur, matching the existing `handleBlur`/`committedRef` guard) commits: applies the exact-
  match-first guard above, then either calls `onPlace`/`onCreateNew` (whole string is a real activity name,
  or no colon present) or the new prop `onCreateElective(setName, memberNames, target)` (colon present, no
  whole-string activity match).
- No `:` present → unchanged, existing `onPlace`/`onCreateNew` behavior, unchanged code path.

**Commit path — new `createElectiveFromCell(setName, memberNames, target)` in `useSlotMutations.js`,
sibling to `createActivityFromCell`, reusing it rather than reimplementing member creation:**

```
async function createElectiveFromCell(setName, memberNames, target) {
  const trimmedSet = String(setName ?? '').trim()
  if (!trimmedSet) return
  const targetRow = slots.find(matches target)
  if (!targetRow || targetRow.is_anchor) return

  // Resolve each member name to an activity id, reusing createActivityFromCell's
  // own dedupe-by-normalized-name check rather than a second matcher.
  const memberIds = []
  for (const name of memberNames) {
    const trimmed = name.trim()
    if (!trimmed) continue
    const dupe = activities.find(a => normalizeName(a.name) === normalizeName(trimmed))
    if (dupe) { memberIds.push(dupe.id); continue }
    const newId = crypto.randomUUID()
    await repo.write('activities', newId, { ...same usage-derived defaults as createActivityFromCell })
    // (extract the shared default-fields object so both functions build it once —
    //  see "Reused vs. new" below; this is not a new default policy)
    memberIds.push(newId)
  }
  if (memberIds.length === 0) return // no valid members typed — do not write an empty elective

  const electiveSetId = crypto.randomUUID()
  await repo.write('elective_sets', electiveSetId, { name: trimmedSet, camp_id: campId, is_reusable: false })
  for (const activityId of memberIds) {
    await repo.write('elective_set_activities', crypto.randomUUID(), { elective_set_id: electiveSetId, activity_id: activityId })
  }

  // Cell write: single-row unless target is a span head with tails — see below.
  ...write elective_set_id into the target cell, atomically with tail release if needed...
}
```

**Ordering/atomicity note:** member-activity creation and the `elective_sets`/`elective_set_activities`
writes are **not** one atomic multi-row transaction — they are sequential `repo.write` calls, exactly the
granularity `createActivityFromCell` already accepts today for the single-activity case (one
`writeActivityFields` call, not wrapped in a bigger transaction either). This is a **conscious continuity
of the existing risk posture**, not a new one: if a write fails partway (e.g. member 2 of 3 fails), the
existing `describeWriteFailure`/`setActionError` surfacing applies, and any already-created activity rows
persist (harmless — they are just extra activities, findable/renamable like any hand-typed one).

**Correction (Red Hat, round 1): the final cell write is NOT crash/network-atomic — the earlier framing
overclaimed this.** `claimAndRun`/`runMutation` give same-device **write ordering** (a keyed lock plus a
`Promise.all` dispatch issued together), not a durable transaction: `scheduleRepository`'s
`writeSlotFields` sends each target/tail row as a **separate sequential IPC call**, and `Promise.all` only
means "issued together from the renderer," not "committed together in the main process." A crash, force-
quit, or renderer/main-process disconnect between the head write landing and a tail-release write landing
can still leave an orphaned tail — reopening the exact `8357447` bug class this design otherwise closes by
construction in the non-crash case. **This is not a new exposure electives introduce**: it is the identical
gap the already-shipped, already-reviewed `replaceSlot` (activity→activity span-head replacement) has today
— `createElectiveFromCell` inherits the same residual by using the same mechanism, it does not make the
exposure worse in kind or add a new one. T105 does not attempt to invent a stronger atomicity guarantee than
`replaceSlot` already has (that would be scope creep past this ticket and past what the existing pattern
promises). **The real fix is tracked separately: T109 (orphaned-span-tail reconciliation guard)**, filed as
a pre-existing, whole-app hardening item that protects both `replaceSlot` and this new elective-conversion
path — out of T105's scope, not blocking it. See §3 for the residual restated at the write-site level.

**Both routes:** `createElectiveFromCell` lives in `useSlotMutations`, the same hook `replaceSlot`/
`createActivityFromCell` live in, which is already shared across Manual and Generated
(`ManualBuildView`/`ScheduleGroupView`/`ScheduleDayView` all consume the same hook instance per the
existing architecture). No route-specific branching needed beyond what already exists.

**Undo/redo (Red Hat, round 1 addition — was missing).** Every other forward mutation in this hook
(`replaceSlot`, `expandSlot`, `placeActivityManual`) calls `pushUndo({ description, undo, redo })` after a
successful write, and `createElectiveFromCell` must follow the identical pattern rather than being a silent
exception:

- **Undo:** clears the cell (`elective_set_id: null`, restoring whatever the cell held before —
  `prevTargetActivityId`/`prevTargetFlags`, captured before the write, exactly as `replaceSlot` already
  captures `prevTargetActivityId`/`prevTargetFlags`; if the head had tails, restore them to their pre-
  conversion state the same way `replaceSlot`'s undo closure already does), **and** best-effort cleanup of
  the one-off `elective_sets` row this gesture minted: if `is_reusable` is still `false` at undo time (the
  director never promoted it), call the existing `deleteElectiveSet` cascade (T103,
  `electron/ops/deleteElectiveSet.js`, already wired via IPC) on `electiveSetId`. If the director already
  promoted it to reusable before undoing, **do not delete it** — a promoted set is durable camp knowledge
  the undo should not silently destroy; undo only clears the cell's reference to it, matching how undoing a
  placement of an *existing* activity never deletes the activity.
- **Redo:** re-applies the same cell write (`elective_set_id: electiveSetId`, plus tail release if
  applicable) using the **same** `electiveSetId`/member rows created by the original forward write — redo
  does not re-run member creation or re-mint a new set id, exactly as `replaceSlot`'s redo re-applies the
  same `activityId` rather than re-resolving it. If the set was deleted by an intervening undo (the
  not-yet-promoted case above), redo must re-create it (re-run the set+member writes with fresh ids,
  since the original ids are gone) — this asymmetry (undo-then-redo of a one-off elective is not a pure
  no-op round-trip if the set was deleted) is inherent to cascading the delete on undo and is called out
  here rather than silently assumed away.

This is wired into `useContentRaceFlag`'s own-write tracking too — see §5.

**Durability default:** every inline-created elective set writes `is_reusable: false` (tier a) by
construction — matching D2's "default conservatively." Promotion to reusable (tier b/c) is a single
follow-up write, `repo.write('elective_sets', electiveSetId, { is_reusable: true })`, exposed as a
one-click affordance on the committed cell (a small "keep this for next time" control in the cell's
existing action-button row, alongside the merge/split buttons at `SlotCell.jsx:317-`) — no modal, matches
the promotion gesture the foundational ADR requires. Tier (c) "durable" (surfaced in the Roots Context
inventory) is the **same** `is_reusable: true` write; there is no third schema state per D2 — tier (b) vs
(c) is a scope distinction the foundational ADR explicitly defers ("Until seasons exist, tier (b) scopes
to the current schedule/summer as a single implicit scope") and this ticket does not need to build that
distinction — one boolean promotion covers both for now, consistent with "no seasons work is authorized."

**Reuse-from-existing-sets palette:** typing a name that exact-matches an existing **durable** set name
(via `listDurableElectiveSets`, not the generic list — see §2) places that set directly (`onPlace`-shaped,
analogous to the existing activity exact-match branch), rather than minting a duplicate. This is the same
shape as `CellInlineEditor`'s existing `exact` match logic, applied to a second lookup list.

### 2. Durability read seam — two distinct lists, two distinct names (Red Hat, round 1: was conflated)

T105 needs **two different reads of `elective_sets`, for two different surfaces, and they must not share a
variable name or a fetch path.** Conflating them (loading one list and using it for both render and reuse)
is exactly the kind of silent-drift bug the T103 Red Hat note warned about, just moved one level up from
"forgot to filter" to "used the wrong already-filtered list for the wrong surface."

- **`electiveSetsAll`** — every `elective_sets` row for this camp, `is_reusable` true or false, fetched via
  the existing **generic** `list('elective_sets')` path (the same primitive `activities`/`groups`/etc.
  already use — no new IPC needed for this one). **Consumer: §4 render only** — a committed cell must show
  its set's name and member count *regardless* of whether that set is a one-off, because a one-off elective
  is a real row a director just placed and needs to see rendered correctly, not hidden because it isn't
  durable. Rendering is not a reuse surface; filtering it to durable-only would make a director's own
  freshly-typed one-off elective render as blank/missing, which is a worse bug than the one T103 guards
  against.
- **`durableElectiveSets`** — `is_reusable = 1` rows only, fetched via the `listDurableElectiveSets`-backed
  IPC wrapper (below). **Consumers: §1's exact-match-to-existing-set lookup in `CellInlineEditor`, and any
  future palette/management list.** This is the seam T103's Red Hat note binds — never substitute
  `electiveSetsAll` (even filtered client-side) for this list on a reuse surface.

Concretely:

- `useSlotMutations`/`ScheduleScreen.jsx` loads `durableElectiveSets` via a `window.shoresh.*` IPC call
  that wraps `listDurableElectiveSets` (a thin new IPC handler mirroring `listUsers`'s shape — read-only,
  no new write surface), **not** by filtering a generic `list('elective_sets')` result client-side. Filtering
  client-side after a generic list is exactly the mistake the T103 Red Hat note warns about: it works today
  and silently breaks the day someone reuses the generic `list` call for a different screen and forgets the
  filter. The seam must be server-side and singular.
- `electiveSetsAll` is loaded the same way every other render-lookup list already is (`activities`, `anchors`
  — see §4), through the existing generic `list('elective_sets')` call already available to any screen; no
  new IPC handler needed for this one, only the render code that consumes it.
- **Test (new) — reuse-surface exclusion (the ticket's literal requirement):** a component/integration test
  that seeds one `is_reusable = 0` set and one `is_reusable = 1` set for the same camp, calls whatever
  `CellInlineEditor`-facing hook/prop exposes `durableElectiveSets`, and asserts the `is_reusable = 0` set is
  never present in that list. Location: co-located with the hook that fetches the list (e.g.
  `useSlotMutations.test.js` or a new `useDurableElectiveSets.test.js` if the fetch is extracted as its own
  small hook — Maker's call, either is fine, but the fetch **must** go through the IPC wrapper around
  `listDurableElectiveSets`, verified by asserting the IPC/mock call target, not just the returned shape).
- **Test (new) — render-surface inclusion (the flip side, Red Hat round 1):** a `SlotCell`/render test that
  places a one-off (`is_reusable = 0`) elective in a cell and asserts the cell renders that set's name and
  member count correctly from `electiveSetsAll` — proving the render path is *not* accidentally wired to
  `durableElectiveSets` (which would make every freshly-authored one-off render blank, the exact regression
  this split guards against). These two tests are deliberately symmetric: one proves a one-off never leaks
  into the reuse surface, the other proves it never fails to appear on the render surface.

### 3. Span-head → elective conversion (multi-cell atomic write)

`createElectiveFromCell`'s final cell write must branch exactly like `replaceSlot` already does:

```
const spanTailRows = collectSpanTailsForElective(freshSlots, timeBlocks, target, freshTargetRow)
const tailKeys = spanTailRows.map(cellKey)
const keys = [...new Set([targetKey, ...tailKeys])].sort()

await runMutation({
  keys, claimId,
  dispatch: async () => {
    const writes = [repo.writeSlotFields(targetRow.id, { elective_set_id: electiveSetId, activity_id: null, flags: {} })]
    for (const tail of spanTailRows) {
      writes.push(repo.writeSlotFields(tail.id, { activity_id: null, is_span_head: true, flags: {} }))
    }
    await Promise.all(writes)
  },
  ...
})
```

`collectSpanTailsForElective` is **the same logic as `collectSpanTails`** (walk forward from the head,
same-activity contiguous tails) — it needs a separate name only because `collectSpanTails` is a private,
non-exported function scoped to the module closure over `slots`/`timeBlocks`/`target` captured at
`useSlotMutations` construction time; the pragmatic fix is exporting `collectSpanTails` (or a version
taking the same four arguments) from the hook's internal scope so both `replaceSlot` and
`createElectiveFromCell` call the identical function — **not** a second copy of the walk logic. This keeps
`runMutation`'s `keys`-claiming, `claimAndRun` ordering, and `Promise.all` dispatch shape identical to the
already-reviewed `replaceSlot` pattern, which is the point: T105 does not invent a new multi-cell primitive,
it calls the existing one with an elective-shaped payload instead of an activity-shaped one.

**Multi-device interleave test (new, required by the ticket — this is the test the T104 design doc
explicitly could not write because it is scoped to T105's write path):**

Location: an integration-style test near `electron/ops/operations.test.js` or a new
`electron/ops/electiveConversion.test.js`, following the shape of T104's own multi-device interleave test
(direct `applyProjection`/`applyBulkReplaceProjection` calls against a shared test db, no real transport —
matching this repo's existing test style for this class of race).

```js
test('two devices converting the same span head to an elective concurrently never leave an orphaned tail with a live head', () => {
  const db = /* seed: head row (is_span_head: true, activity_id: 'act-1'), one tail row (is_span_head: false, activity_id: 'act-1') */
  const headId = ..., tailId = ...

  // Device A: converts head to elective, releases the tail — the correct
  // T105 write shape, emitted as the field ops createElectiveFromCell would
  // actually produce (head.elective_set_id=set-A, head.activity_id=null,
  // tail.activity_id=null, tail.is_span_head=true), interleaved at
  // arrival-seq granularity with...
  // Device B: independently also converts the SAME head to a DIFFERENT
  // elective (set-B) via the identical write shape, racing A.
  const interleavedOps = [
    { entity: 'template_slots', entity_id: headId, field: 'activity_id', value: null },        // A seq1
    { entity: 'template_slots', entity_id: tailId, field: 'activity_id', value: null },         // B's tail-release seq2
    { entity: 'template_slots', entity_id: tailId, field: 'is_span_head', value: true },        // B seq3
    { entity: 'template_slots', entity_id: headId, field: 'elective_set_id', value: 'set-B' },  // B seq4
    { entity: 'template_slots', entity_id: tailId, field: 'activity_id', value: null },         // A's tail-release seq5 (redundant, already null)
    { entity: 'template_slots', entity_id: tailId, field: 'is_span_head', value: true },        // A seq6 (redundant, already true)
    { entity: 'template_slots', entity_id: headId, field: 'elective_set_id', value: 'set-A' },  // A seq7
  ]
  for (const op of interleavedOps) applyProjection(db, op)

  const head = getRow(headId), tail = getRow(tailId)
  // Invariant this test protects: the tail is NEVER left owning an activity_id
  // while the head is not an activity head — i.e. no orphaned tail, regardless
  // of which device's elective "wins" the head (T104's MUTUALLY_EXCLUSIVE_FIELDS
  // already guarantees the head itself is single-kind; this test is about the
  // head/tail RELATIONSHIP, which T104 explicitly does not know about).
  expect(tail.activity_id).toBeNull()
  expect(tail.is_span_head).toBe(true)
  expect(head.activity_id).toBeNull()
  expect(head.elective_set_id).toBe('set-A') // higher-seq setter wins, standard LWW
})
```

**Residual, stated plainly (per the T104 design doc's own precedent for documenting rather than
eliminating this class of residual) — two distinct residuals, not one:**

1. **Field-level interleave (what this test covers):** the test above shows that *once both devices' ops
   have landed*, the interleave resolves safely, because both devices' writes independently release the
   same tail to the same terminal state (`activity_id: null, is_span_head: true`) — releasing a span tail
   is idempotent regardless of which device does it or in what order. A **third device concurrently placing
   a different activity directly into the tail cell** while A and B are converting the head is not closed by
   this test and is not a new hazard T105 introduces — it is the same per-cell LWW residual
   `2026-08-12-drag-live-write-serialization` already accepts for any multi-cell operation. No new mechanism
   is owed for that case here, consistent with T104's own resolution of the equivalent question.
2. **Crash/disconnect between the head write and a tail-release write actually landing (not an interleave —
   a partial-completion failure):** as corrected in §1, `runMutation`'s `Promise.all` is same-device write
   *ordering*, not a durable multi-row transaction across IPC calls. If the process crashes or the
   connection drops after the head's `elective_set_id` write is acknowledged but before a tail's release
   write is acknowledged, the tail is left orphaned — carrying a stale `activity_id` with no head that
   claims it, reopening the `8357447` bug class. **This is inherited, not new**: `replaceSlot`
   (activity→activity span-head replacement) has had this exact exposure since it shipped, and
   `createElectiveFromCell` uses the identical write shape, so it does not widen the exposure in kind, only
   in the (already-existing) set of write paths that share it. The fix is **T109 (orphaned-span-tail
   reconciliation guard)**, filed as a separate, whole-app hardening ticket that protects both write paths —
   deliberately out of T105's scope; T105 does not attempt to build a stronger transaction primitive than
   `replaceSlot` already has, per Governor's explicit instruction.

### 4. Render of an elective cell in `SlotCell`

Per the schedule-canvas ADR: a data attribute, no new tokens, no new React state.

- `SlotCell.jsx`: the outer cell `div` already carries data attributes for existing states (`data-unfillable`-
  shaped patterns visible in the flag rendering block). Add `data-elective` (present, no value needed — a
  boolean marker, matching `data-merge-hint`'s existing boolean-attribute style) when `slot.elective_set_id`
  is non-null.
- Cell body: the `cell-name` div's content branches to show the elective's set name, looked up from
  **`electiveSetsAll`** (§2 — the unfiltered list; a one-off must render, never the durable-only list), same
  lookup-map pattern `actLookup`/`anchorLookup` already use, with a small member-count suffix, e.g.
  `Afternoon Chugim (3)` — matching the existing single-line truncation behavior already applied to long
  activity names, no new truncation logic.
- **Dangling-reference fallback (Red Hat, round 1 — was asymmetric with §6's export):** `slot.elective_set_id`
  can point at a set that no longer exists (deleted via the T103 `deleteElectiveSet` cascade from another
  device, or a race with an in-flight delete) or that currently has zero members (all its
  `elective_set_activities` rows were individually removed). The render must handle both explicitly, the
  same way §6's export already does with `set ? ... : ''`:
  ```js
  const set = electiveSetLookup.get(slot.elective_set_id) // from electiveSetsAll
  const memberNames = set ? membersBySet.get(set.id) ?? [] : []
  const label = set ? `${set.name}${memberNames.length ? ` (${memberNames.length})` : ''}` : 'Elective (removed)'
  ```
  A missing set renders a plain, non-alarming placeholder (`'Elective (removed)'`) rather than a blank cell
  or a thrown lookup error — a blank cell here would be indistinguishable from "Unassigned," which is a
  worse failure than an explicit, if terse, label. This is not a new flag/severity — it is ordinary
  defensive rendering, same class as `actLookup.get(...) || ''` already is for activities elsewhere in the
  codebase.
- `scheduleGrid.css`: one new rule keyed on `[data-elective]`, giving the cell a distinct visual treatment
  (e.g. a diagonal-hatch or double-border background-image, chosen to read as "this cell holds a *group* of
  things" without picking a 7th hue that would violate the ACTIVITY_COLORS six-color/greyscale-legible
  constraint `slotCellConstants.test.js` guards) — exact visual treatment is Designer's call per the
  schedule-canvas ADR's own boundary (data-attribute + CSS only, no new persisted layer), noted as an open
  item for Designer in the ticket's own review loop ("Designer if the cell affordance is UI-significant").
- **DESIGN_STANDARD §5/§8 note (UI-significant surface):** the elective cell's committed state and the
  `CONTENT_RACE` badge (§5 below) are both async/consequence-feedback states per §5 — the commit itself
  should get the same quiet post-edit acknowledgement `useFlagChangeAck`'s `data-flag-changed` animation
  already gives ordinary flag changes (no new animation primitive, reuse the existing one by including
  elective-kind changes in `flagSignature`'s diff surface — see §5), and the reduced-motion path is already
  handled by `useFlagChangeAck`'s existing `prefers-reduced-motion` early-return, which the elective case
  inherits for free by reusing the same hook rather than building a parallel one.

### 5. `CONTENT_RACE` flag mechanism (fully specified)

**New hook `useContentRaceFlag(slots, route)` in `src/screens/schedule/useContentRaceFlag.js`, structurally
identical to `useFlagChangeAck.js`** (same `useRef` map / `useEffect` diff / route-reset / local `useState`
shape), with two differences: what it tracks per cell, and what "this device's own recent write" means.

**State tracked, per cell key (`group_id|day_id|time_block_id`):**

```js
// Local-only, never persisted. Populated at the moment THIS device's own
// write call resolves successfully (not optimistically before dispatch) —
// hooked into the same onSuccess callback createElectiveFromCell/replaceSlot
// already call to update `slots` locally, so no new instrumentation point,
// just one more field recorded alongside the existing optimistic setSlots update.
ownWriteRef.current.set(cellKey, {
  kind: slot.elective_set_id ? `elective:${slot.elective_set_id}` : slot.activity_id ? `activity:${slot.activity_id}` : 'empty',
  atWriteToken: currentSlotsVersionCounter, // see below
})
```

**Diffing logic (pseudocode, precise per Red Hat's expected challenge):**

```
on every `slots` change (useEffect, same trigger as useFlagChangeAck):
  newMap = buildContentKindMap(slots)   // cellKey -> 'activity:<id>' | 'elective:<id>' | 'empty'
  for (cellKey, ownRecord) in ownWriteRef.current:
    if ownRecord is older than RECENCY_WINDOW (see below): delete and skip — a race notice about
      a write from 10 minutes ago is noise, not signal.
    currentKind = newMap.get(cellKey)
    if currentKind is undefined: continue  // cell no longer exists (route switch cleared the ref anyway)
    if currentKind !== ownRecord.kind:
      // This device's own last write to this cell no longer matches what the
      // cell now holds, AND this device did not just write that new value
      // itself (see "own-write suppression" below) → mark it.
      markedCells.add(cellKey)
    // Once compared, the own-write record for this cell is consumed (deleted)
    // regardless of outcome — a cell is only ever checked against the write
    // that produced ownWriteRef's entry, not against every subsequent slots
    // change, so a director who edits the same cell twice locally doesn't
    // get a stale comparison against their FIRST edit.
    ownWriteRef.current.delete(cellKey)
```

**Own-write suppression (the precise mechanism, since a naive diff would flag a device's OWN successful
write as a "race" against itself):** `ownWriteRef` is populated at the `onSuccess` callback of **every**
forward-mutation path that can change a cell's `activity_id`/`elective_set_id` (enumerated in the table
below) — the same tick each of those callbacks already calls `setSlots(...)` to apply the optimistic update
locally. The diff effect that compares `newMap` against `ownWriteRef` runs on the *next*
`slots` change after that — for a purely local edit with no concurrent writer, that next change is either
(a) none (nothing else changes `slots` until a real sync event), or (b) the server ack for the same write,
which by construction matches `ownWriteRef`'s recorded kind exactly (same write, now confirmed) — no flag.
A flag only fires when the *next* observed `slots` change for that cell carries a **different** kind than
what this device itself just set — which can only happen if a different device's write landed on the same
cell after this device's own write, i.e. the actual race condition, not an artifact of the device seeing
its own write echo back.

**Enumerated own-write sites (Red Hat, round 1 — was only implicitly "onSuccess," now explicit; must include
undo/redo now that §1 adds them, or a local undo would false-positive its own cell as raced):**

| Write path | Where `onSuccess`/undo/redo fires | `ownWriteRef` entry recorded |
|---|---|---|
| `createElectiveFromCell` forward write | `runMutation`'s `onSuccess` | `kind: 'elective:<newSetId>'` |
| `createElectiveFromCell`'s **undo** closure | the undo closure's own success path (mirrors `replaceSlot`'s undo, which already exists and is unaffected) | `kind` = whatever the cell is restored to (`'activity:<prevId>'`, `'elective:<prevSetId>'`, or `'empty'`) |
| `createElectiveFromCell`'s **redo** closure | the redo closure's own success path | `kind: 'elective:<electiveSetId>'` (same id reused, or a fresh one in the re-create case noted in §1) |
| `replaceSlot` forward write | existing `onSuccess` | `kind: 'activity:<incoming.activityId>'` or `'empty'` |
| `replaceSlot`'s existing undo/redo closures | existing undo/redo success paths | mirrors whatever state each restores |
| `placeActivityManual` | existing `onSuccess` | `kind: 'activity:<activityId>'` |
| `releaseCell` | existing `onSuccess` | `kind: 'empty'` |

This table is the concrete answer to "every write path that touches this cell's `activity_id`/
`elective_set_id` is an own-write": `useContentRaceFlag` does not hook into `createElectiveFromCell` alone,
it hooks into the **same shared `onSuccess`/undo/redo instrumentation point** every one of these mutation
functions already calls through `runMutation`, so one small addition to `runMutation`'s own-success path
(recording into `ownWriteRef` alongside the existing `setSlots` call) covers all of them at once, rather
than requiring a separate hook-in per function. This is why the recording point in the code block above is
described as "hooked into the same `onSuccess` callback ... already call" — concretely, `runMutation` is the
one shared choke point, and `ownWriteRef` recording belongs there, not duplicated per caller.

**Recency window:** reuse `MAX_SINGLE_EDIT_CELLS`-scoped recency the T104 design doc names — concretely, a
`RECENCY_WINDOW_MS` (e.g. 5000ms, Maker/Designer to tune) timestamp check on `ownWriteRef`'s entries, so a
cell this device wrote to an hour ago and is now legitimately different (the director themselves changed it
again from a different tab, or simply forgot) does not resurface a stale race notice. This is a genuinely
new small constant (`useFlagChangeAck` uses a *cell-count* window, not a *time* window, because its
comparison is same-render-cycle; `useContentRaceFlag`'s comparison spans an indeterminate real-world gap
until a sync event arrives, so time is the correct axis here, not cell count) — flagged explicitly as the
one place this hook's mechanism genuinely diverges from `useFlagChangeAck`'s, not silently copied.

**Render:** `CONTENT_RACE` added to `FLAG_SEVERITY` (`caution`, matching `OVERLAP`/`WEEK_CLOSED` — a
concurrent-edit notice, not a hard failure) and `FLAG_COLORS` in `slotCellConstants.js` — reusing an
existing color already in the palette (e.g. the same `var(--secondary)` slate `WEEK_CLOSED` uses, or a
distinct existing token; exact choice is Designer's call, not locked here) rather than adding a new CSS
variable. Rendered as a small dismissible badge in `SlotCell.jsx`'s flag row, dismissal is a **local**
`Set<cellKey>` in `useContentRaceFlag`'s own state (not `slots.flags`, never written, cleared on unmount/
route-switch exactly like the map itself — a route switch already resets `ownWriteRef` too, so there is
nothing to falsely re-flag after a switch).

**Test (new):** a unit test for `useContentRaceFlag` (React Testing Library, matching the existing
`useFlagChangeAck.test.js` if one exists, or `SlotCell.test.jsx`'s style otherwise): (1) local write
followed by a `slots` update carrying the *same* kind → no flag (own-write suppression); (2) local write
followed by a `slots` update carrying a *different* kind → flag fires; (3) flag dismissed locally does not
reappear on the next unrelated `slots` change for the same cell; (4) route switch clears any pending flag
with no re-fire; (5) **(Red Hat, round 1)** a local **undo** of an elective placement, followed by the
server ack for that undo, does not fire `CONTENT_RACE` on the now-cleared cell — proving `ownWriteRef` is
populated from the undo closure's own success path, not only the forward-write path; (6) a local **redo**
likewise does not self-flag.

### 6. Export

`exportToExcel` (`src/utils/exportSchedule.js`) gains one branch, inserted before the existing
`slot.activity_id` check (mirroring the existing `is_anchor` → `activity_id` → `''` ordering):

```js
if (slot.elective_set_id) {
  const set = electiveSetLookup.get(slot.elective_set_id)
  const memberNames = (electiveMembersBySet.get(slot.elective_set_id) || [])
    .map(activityId => actLookup.get(activityId))
    .filter(Boolean)
  row.push(set ? `${set.name} (${memberNames.join(', ')})` : '')
  continue
}
```

Requires `exportToExcel`'s caller to pass `electiveSets`/`electiveSetActivities` alongside the existing
`activities`/`anchors`/`groups`/`days`/`timeBlocks` arrays it already receives — an additive parameter,
same pattern as the existing five. The master flat sheet (further down in the same file, not shown in the
excerpt read) needs the identical branch wherever it currently reads `slot.activity_id` for the "Activity"
column.

## Files/modules affected

- **Modify:** `src/components/schedule/CellInlineEditor.jsx` — colon-delimiter detection, chip preview
  render, new `onCreateElective` prop.
- **Modify:** `src/components/schedule/SlotCell.jsx` — pass `onCreateElective` through to
  `CellInlineEditor`; `data-elective` attribute; elective-cell name/count render; promotion-to-reusable
  action button.
- **Modify:** `src/components/schedule/scheduleGrid.css` — `[data-elective]` rule.
- **Modify:** `src/components/schedule/slotCellConstants.js` — `CONTENT_RACE` entry in `FLAG_SEVERITY`/
  `FLAG_COLORS`; `legendEntriesFor` inclusion if Designer decides it belongs in the legend.
- **Modify:** `src/screens/schedule/useSlotMutations.js` — new `createElectiveFromCell` **with its own
  `pushUndo({ description, undo, redo })` call**, mirroring `replaceSlot`; export/reuse `collectSpanTails`
  (or an equivalent-signature sibling) so both `replaceSlot` and `createElectiveFromCell` call one walk;
  extract the shared usage-derived activity-default-fields object out of `createActivityFromCell` so
  `createElectiveFromCell`'s member-creation loop calls the same object builder, not a duplicate literal;
  `runMutation`'s shared `onSuccess` path gains the `ownWriteRef` recording step consumed by
  `useContentRaceFlag` (§5), covering every caller — `createElectiveFromCell`, `replaceSlot`,
  `placeActivityManual`, `releaseCell`, and both new undo/redo closures — at one choke point.
- **New:** `src/screens/schedule/useContentRaceFlag.js` — the hook specified in §5, reading from the shared
  `ownWriteRef` populated by `runMutation`.
- **New (or modify existing loader):** a thin IPC wrapper + preload entry (`listDurableElectiveSets` ->
  `shoresh:list-durable-elective-sets`) and the renderer-side call site that feeds `durableElectiveSets`
  (§2's reuse-surface list — `CellInlineEditor`'s exact-match-to-existing-set lookup).
  `electron/main.js`/`electron/preload.js` gain one read-only handler each, mirroring `listUsers`'s existing
  shape. `electiveSetsAll` (§2's render-surface list) needs no new handler — it is loaded via the existing
  generic `list('elective_sets')` call already available to any screen.
- **Modify:** `src/utils/exportSchedule.js` — `elective_set_id` branch in both the per-day sheet and the
  master flat sheet; caller (wherever `exportToExcel` is invoked, likely `ScheduleScreen.jsx`) passes the
  two new arrays.
- **No migration.** v35/v36 already ship every column this design writes to
  (`elective_sets.{id,camp_id,name,is_reusable}`, `elective_set_activities.{id,elective_set_id,activity_id}`,
  `template_slots.elective_set_id`). D3 (capacity/eligibility) is out of scope for this pass (see Open
  Questions).
- **Out of scope, tracked separately: T109 (orphaned-span-tail reconciliation guard).** Filed by Governor as
  a pre-existing, whole-app hardening item protecting both `replaceSlot` and `createElectiveFromCell` against
  the crash/disconnect residual documented in §1/§3 (a partial multi-cell write leaving a tail orphaned).
  Not built as part of T105; referenced here so the boundary is explicit rather than silently assumed.

## Reused vs. new

**Reused, not rebuilt:** the generic `PROJECTIONS`-backed write path for `elective_sets`/
`elective_set_activities` (T103); the existing generic `list('elective_sets')` read for `electiveSetsAll`
(§2); `listDurableElectiveSets` (T103, first production callers here) for `durableElectiveSets`;
`MUTUALLY_EXCLUSIVE_FIELDS`/`sanitizeMutuallyExclusiveRow` (T104, untouched dependency); `createActivityFromCell`'s
member-creation logic and defaults, called from the new elective path rather than duplicated;
`collectSpanTails`'s walk logic and `replaceSlot`'s `claimAndRun`/`runMutation`/multi-cell dispatch shape,
**including its same-device-only atomicity ceiling** (not exceeded, per Governor's instruction — see §1/§3
and T109); `replaceSlot`'s `pushUndo` pattern, extended to `createElectiveFromCell`; `deleteElectiveSet`
(T103) as the undo-time cleanup primitive for a not-yet-promoted one-off; `useFlagChangeAck`'s render-time-
diff-against-a-ref technique as the literal template for `useContentRaceFlag`; `FLAG_SEVERITY`/`FLAG_COLORS`'
existing object-literal shape; `CellInlineEditor`'s existing `normalizeName` matcher and exact/fuzzy
branching, applied to a second (elective-name) lookup rather than a new matcher, and to the exact-match-
first colon guard; `exportToExcel`'s existing per-cell branch-and-continue structure and its `set ? ... : ''`
dangling-reference shape, now mirrored in §4's render fallback.

**Genuinely new:** the colon-delimiter grammar, its exact-match-first guard, and its chip-preview render in
`CellInlineEditor`; `createElectiveFromCell` including its undo/redo closures; the `useContentRaceFlag` hook
(new file, though its mechanism is a direct adaptation, not a novel technique) and the shared `ownWriteRef`
recording point added to `runMutation`; the `RECENCY_WINDOW_MS` time-based comparison (the one place this
design's mechanism genuinely diverges from `useFlagChangeAck`'s cell-count-based window — called out
explicitly, not silently copied); the IPC wrapper around `listDurableElectiveSets`; the `[data-elective]`
CSS rule, `CONTENT_RACE` flag entries, and the dangling-`elective_set_id` render fallback; the
`elective_set_id` export branch. **Explicitly not built here:** T109's reconciliation guard — named, scoped,
and deferred, not silently folded in or silently ignored.

## ADR required: no

This is covered by the already-ratified `docs/adr/2026-08-20-electives-authoring.md` (D1's authoring
mechanism and D2's durability mapping) and `docs/adr/2026-08-20-in-context-knowledge-and-durability-tiers.md`
(the generalized create-in-context rule and three-tier durability contract) — T105 is explicitly slices 2/3
of that ADR's plan, not a new architectural decision. Nothing in this design introduces a new persistent
data shape (all writes target already-migrated v35/v36 columns), changes an existing contract another
module depends on (the export function gains an additive branch; `CellInlineEditor`'s existing
`onPlace`/`onCreateNew` contract is unchanged, `onCreateElective` is additive), or makes an irreversible
tradeoff — the delimiter-grammar choice is a UI convention, changeable without a data migration if a later
pass finds a better one. Per the ADR bar in `docs/governance/constitution/CONSTITUTION.md`, this is
implementation design within an already-ratified architecture, not a new ADR-worthy decision.

## Open questions for Governor

1. **D3 (capacity/eligibility) has no schema yet and is not in this design.** The ticket's stated scope
   (inline authoring, durability read seam, span-head conversion, render, `CONTENT_RACE`, export) does not
   list capacity/eligibility fields, and no v35/v36 column exists for them. If Governor wants D3 addressed
   in the same slice rather than a follow-up ticket, that is a schema-affecting scope change requiring its
   own migration and should be called out to Maker explicitly before code starts, not discovered mid-build.
2. **Colon (`:`) as the set/member delimiter is a Designer/Tester-level UX call, not fixed here.** It is the
   design's recommendation (least likely to collide with a real activity name in this camp's existing data,
   confirmed by no colon appearing in any of the example activity names in the codebase's own fixtures/
   tests), and the exact-match-first guard (§1) makes an actual colon-containing activity name safe even if
   this delimiter ships as-is — but the exact character, and whether a `Create "X"` fallback suggestion
   should preview the parsed elective before commit, belongs to the Designer pass this ticket's own review
   loop already calls for ("Designer if the cell affordance is UI-significant"), validated against real camp
   activity-name conventions by Tester before ship — flagging so it isn't silently locked by this
   data/write-path-focused doc.
3. **Promotion-to-reusable affordance placement** (a button in the cell's existing action row vs. a
   secondary surface reached from the management screen) is likewise a Designer call; this design only
   fixes that it must be a single, non-modal write, not where exactly the control lives.
4. **`RECENCY_WINDOW_MS`'s exact value** (proposed 5000ms) is a UX-tuning parameter Red Hat and Tester
   should pressure-test against realistic sync latency on this app's LAN model, not a value this design
   treats as final.
