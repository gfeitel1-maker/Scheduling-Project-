---
title: "T320 (item 3) — Re-place picker for a DANGLING_MANUAL_ASSIGNMENT run-state row"
document_type: spec
authority: proposed
status: draft
created: 2026-09-30
governing_docs: [docs/governance/standards/DESIGN_STANDARD.md, docs/work/specs/2026-09-25-t250-run-state-surface.md]
related_adrs: [docs/adr/2026-09-23-elective-run-lifecycle-and-remaining-slices.md]
related_tickets: [docs/work/tickets/T320-elective-run-durability.md]
archive_when: T320 item 3 ships Maker's implementation of this picker and Governor confirms it against this spec
---

# T320 (item 3) — the dangling row's remedy is a re-place picker, not "Release lock" alone

Owner ruling, 2026-09-29, verbatim: **"put the picker in to move a camper."**

This spec covers exactly one row: the `DANGLING_MANUAL_ASSIGNMENT` run-state row on
`src/screens/elective/run/DraftRunView.jsx`'s Draft screen. It extends
`docs/work/specs/2026-09-25-t250-run-state-surface.md` ("Layout" / "Row shape" / row vocabulary) —
it does not redesign the run-state area, the satisfaction summary, the move/lock table, or any
other finding kind (over-capacity, `PREFERENCE_EDIT_HELD`, `BUNDLE_TIER_NOT_COVERED`).

## Why "Release lock" alone is the wrong remedy (read before the "what" below)

`DraftRunView.jsx:268-284` states the mechanism precisely: `setElectiveAssignment` writes
`source:'manual'` on **every** write through that path, and `commitElectiveRun` derives
`DANGLING_MANUAL_ASSIGNMENT` from `source='manual'` rows whose `occurrence_id` sits outside the
derived occurrence set — keyed on `source`, never on `is_locked`. Releasing the lock is real (the
row genuinely unlocks) but does not touch `occurrence_id`, so the row is unchanged and correctly
stays. The comment names the actual remedy: move the placement onto an occurrence this run still
has. That is what this spec adds.

## Domain grounding (verified against the tree, not assumed)

- An **occurrence** is a `(day_id, time_block_id, tier_id)` cell (`deriveOccurrences.js`) — it does
  **not** carry an `activity_id`. `elective_assignments` carries `occurrence_id` and `activity_id`
  as two independent columns. An elective set can offer more than one member activity
  (`elective_set_activities`), so in principle a placement is an (occurrence, activity) pair.
- In practice, the **only existing "move" control in this codebase** — the move/lock table's
  `<select>` at `DraftRunView.jsx:570-586` — never changes activity. It iterates
  `templateOccurrences` and labels every option with the row's own fixed `activity_id`
  (`labelForTemplateOccurrence({ occurrenceId: o.id, activityId: r.activity_id })`), and its
  `onChange` writes `{ occurrenceId, activityId: r.activity_id, locked: true }` — occurrence
  changes, activity does not.
- `setElectiveAssignment` (`electron/ops/setElectiveAssignment.js:34`) hard-refuses any
  `occurrenceId` that does not resolve to a real `elective_occurrences` row belonging to this run
  (`{ ok: false, error: 'occurrence not found' }`). **There is no write path that clears a
  placement to "no occurrence"** — no `removeElectiveAssignment` op exists, and passing a null/
  missing occurrence is refused, not accepted as "unplaced."
- `getElectiveRun` does not return, for a cold-opened run, any live "which activities are offered
  at this occurrence" data (`elective_choices`/`elective_choice_offerings` are scoped to linked
  bundles only, T301, and are not read by this handler for general offerings). The only place that
  data momentarily exists is `templateOccurrences` (AssignmentPanel React state from a fresh solve
  or regenerate) — same set the table's own dropdown already depends on, and same set that is
  **empty** for a cold-opened run with no `onRegenerate` (T318's own comment on this file,
  `DraftRunView.jsx:179-182`).

These three facts settle two of the brief's open questions before any taste-level decision gets
made: **one-step, occurrence-only** (below), and **no "remove the placement" control** (below).

## What replaces "Release lock"

**ASSUMPTION 1 (recommend, needs owner awareness — see list at bottom):** the picker is a **native
`<select>` inline in the row's action slot**, replacing the "Release lock" button whenever this run
has at least one live occurrence to move into. When it has none, the row falls back to the existing
"Release lock" button, unchanged. The two are **mutually exclusive per row render**, never shown
together — there is no case where showing both would help the director, and showing a picker with
zero real options is exactly the dead-control case the brief forbids.

```
templateOccurrences.length > 0   →  [ select: "Move to…" ]
templateOccurrences.length === 0 →  [ button: "Release lock" ]   (today's control, unchanged)
```

Reasoning against the alternative ("keep both, always"): once a live occurrence exists, moving the
camper there is the action that actually closes the condition (see mechanism above) — releasing the
lock next to it would be a second control that looks like an alternative remedy and is not one
(released-but-not-moved is still dangling). Offering it as a decoy invites a director to click the
thing that doesn't work. When no live occurrence exists, "Release lock" is the only real, working
action left (it genuinely unlocks, even though the condition persists) — this is exactly T250's own
original reasoning for shipping it ("strictly less destructive... does not delete data"), now scoped
to the one case where it is honestly the best available action rather than presented as the row's
general-purpose remedy.

**ASSUMPTION 2 (recommend, needs owner awareness):** one step, occurrence-only. The select offers
occurrences to move **to**; the activity stays the row's existing `activity_id`, exactly matching
the move/lock table's own established behavior (cited above). The brief is correct that the
underlying write takes both `occurrenceId` and `activityId` — the picker still supplies both, it
just never asks the director to change the second one, because (a) the only sibling control in this
codebase never offers that choice either, and (b) there is no data available to this screen, for a
cold-opened run, that names which activities are validly offered at a candidate occurrence — adding
an activity step here would either invent that missing catalog or silently offer activities that
are wrong for the occurrence. A two-step, activity-aware picker is a real, larger feature (it needs
an IPC surface this ticket does not have) and is out of this spec's scope; flagged in the assumptions
list.

**ASSUMPTION 3 (recommend, needs owner awareness): no "remove the placement" control.** The brief
asks for one; the write path to represent "this camper has no placement" does not exist
(`setElectiveAssignment` requires a resolvable occurrence, full stop — see domain grounding above).
Specifying a "Remove placement" button here would be specifying a call to an IPC surface that does
not exist, which is the same failure mode as a disabled dead control, just discovered at
implementation time instead of at render time. This is a real gap, not a design choice — flagged
for Governor as a likely follow-up ticket (a `removeElectiveAssignment` op, or an `occurrenceId:
null` mode on `setElectiveAssignment`) if the owner still wants that affordance after seeing this.

## Layout — inline `<select>`, not a popover, not a dialog

**ASSUMPTION 4 (recommend, needs owner awareness):** the picker is the `<select>` itself, mounted
directly in the row's existing action slot (`RunStateRow`'s `action` prop) — no trigger button that
reveals it, no popover, no modal. It behaves exactly like the move/lock table's own `<select>`:
one control, writes on `onChange`, no separate "confirm" step.

Reasoning, against the two precedents already in this codebase:
- **`DeleteRunDialog.jsx`** is the wrong shape here. That dialog exists because deleting a run is
  irreversible data loss with a real cross-device cost (`DELETE_RUN_COST_COPY`). Moving a camper to
  a different occurrence is the opposite: reversible (the director can move again, or move back,
  through this same control or the table below), and T250 already ruled the analogous action
  ("Release lock") needs **no confirmation dialog** because "it does not delete data... strictly
  less destructive than the state it's replacing." A move is equally non-destructive and equally
  undoable. Wrapping it in a modal would overweight a low-stakes, single-field edit and contradict
  the "quiet, precise" personality (`DESIGN_STANDARD.md` §1) by making the director clear an extra
  screen for something the table two inches below does with zero ceremony.
- **`assignmentStyles.js`'s `residuePicker`/`residueSelect`** (T247, the residue-mapping row) is the
  closer precedent, and its own comment states the reasoning this spec reuses verbatim: "A native
  `<select>` deliberately: the camp's activity list is an open set of arbitrary length, the
  platform's own control handles a long one better than anything built here would, and there is no
  existing combobox in this codebase to extend — inventing one... would be the drift `design-system`
  exists to prevent." The same argument applies to an occurrence list.

No expand/collapse state, no second click to "open" the picker — this also means Maker adds no new
`useState` for this control; the write itself is the only side effect.

## Visual style

New style object in `DraftRunView.jsx`'s local `styles` (does not touch `RunStateRows.jsx` or
`runStateCopy.js`'s row-level styling, which stays exactly as T250 shipped it):

```js
danglingMoveSelect: {
  fontFamily: 'inherit',
  fontSize: 13,              // matches S.cautionBanner's row text size, not residueSelect's 12px —
                              // this select lives inside a cautionBanner-derived row, not the table
  padding: '5px 8px',
  borderRadius: 6,
  border: '1px solid color-mix(in srgb, var(--accent) 45%, var(--border))',
                              // same hairline formula as the row itself (S.cautionBanner border),
                              // so the control reads as PART of the bronze row, not a foreign inset
  background: 'var(--surface)',
  color: 'var(--text)',
  maxWidth: 280,
  cursor: 'pointer',
},
```

No new token, no new color. The border reuses the row's own `color-mix(in srgb, var(--accent) 45%,
var(--border))` formula (already defined in `RunStateRows.jsx`'s `rowBase`) so the select reads as
an extension of the bronze row's own chrome, the same way `S.btnSecondary` already sits inside it
today. Background stays plain `var(--surface)` (not bronze-tinted) so the select is legible as an
interactive control against the tinted row, exactly the same figure/ground logic `residueSelect`
uses against its own row.

Placeholder option, always first, disabled, selected whenever nothing has been chosen yet:

```jsx
<option value="" disabled>Move to…</option>
```

This is not explainer text — "Move to…" is the control's own label for what selecting an option
does, the same register as a form field's placeholder, not a description of the system.

## States

- **Live occurrences available, nothing selected yet (default):** select shows the "Move to…"
  placeholder. No occurrence is pre-selected — there is no "current" occurrence to default to,
  because the whole point of this row is that the placement's occurrence no longer exists in the
  live set.
- **Live occurrences available, director opens the select:** native OS/browser picker UI, one
  option per `templateOccurrences` entry, labeled via `labelForTemplateOccurrence({ occurrenceId:
  o.id, activityId: row.activity_id })` — same label function, same format the table already uses
  ("Pottery — Tuesday, Period 3").
- **Director picks an option (in-flight):** the select becomes `disabled` immediately on `onChange`
  (before the write resolves), preventing a second selection landing mid-write — same synchronous-
  guard posture `finalizingRef` already uses elsewhere in this file, scaled down to a per-row
  boolean rather than a ref (see Implementation notes). No spinner glyph is introduced; the row's
  message and the disabled select together are sufficient in-flight signal, consistent with this
  screen not having its own toast/spinner vocabulary (see "Success" below).
- **Write succeeds:** the row is removed from the run-state area, animated via the existing
  collapse transition (see Animation). The camper's row in the move/lock table below re-renders
  with the new occurrence and `is_locked: 1` on its next read of `state.rows` (already true today —
  `applyRow` is not used here; see Implementation notes on why this write reloads instead).
- **Write fails** (`OCCURRENCE_FULL`, `CAMPER_INELIGIBLE`, `RUN_NOT_DRAFT`, or a thrown exception):
  the select re-enables and reverts to the "Move to…" placeholder (nothing was written, so nothing
  should appear chosen). The failure surfaces through the existing `RunError`/`describeWriteFailure`
  path at the top of the screen (`error` state, `run-view-error` testid) — this reuses
  `writeAssignment` verbatim (see Implementation notes), including its existing behavior of
  surfacing the raw `error` code string (e.g. `OCCURRENCE_FULL`) rather than a humanized sentence.
  That is a pre-existing gap in `writeAssignment` shared by the table's own occurrence `<select>`
  today — not introduced or fixed by this spec, and out of scope here.
- **No live occurrences (`templateOccurrences.length === 0`):** no select renders at all. The row's
  action slot shows the existing "Release lock" button, unchanged from today's behavior
  (`releaseLock`, `RELEASE_LOCK_LABEL`, `released` state array).
- **"Release lock" already clicked this session, in the no-live-occurrences branch:** action slot
  is empty, exactly as today (`released.includes(f.assignment_id) ? null : <button>...`).

## Success — no toast

This screen has no toast/snackbar vocabulary anywhere (`DraftRunView.jsx`, `RunStateRows.jsx`,
`runStateCopy.js` — none define one, and neither does `shared.js`'s `S` for this surface). The
"it worked" signal is **the row disappearing** — the same convention T250 already established for
"Release lock" clearing an over-capacity row's underlying cause, and for a regenerate clearing a
stale-generation row. No toast is introduced here; doing so would be new vocabulary this spec has no
mandate to invent and would duplicate the signal the row's own removal already gives.

## Interactions

- **Select `onChange`:** reads the picked `occurrenceId`, calls the same `writeAssignment` function
  this file already defines (`camperId: finding.camper_id, occurrenceId, activityId: row.activity_id,
  locked: true`), where `row` is `rows.find(r => r.id === finding.assignment_id)` — the identical
  lookup `releaseLock` already performs. **`locked: true`, not `false`** — this mirrors the table's
  own manual-move convention ("a move made by hand is a manual, locked placement — the next
  regenerate must not undo the director," `DraftRunView.jsx:577`). Do not reuse `releaseLock`'s
  `locked: false` for this call; that would immediately re-open the seat the director just chose by
  hand to the next regenerate.
- On success: the assignment id is added to the same kind of session-local resolved-set this file
  already uses for "Release lock" (see Implementation notes — do not wait on the "durable derivation
  rebuild" mentioned elsewhere in T320; this row's own disappearance is a local, immediate UI
  concern, and `danglingFindings` is documented as session-scoped already, so this is not a new kind
  of staleness).
- On failure: `writeAssignment`'s own `setError` call already surfaces it; the select is the only
  local state this interaction adds (see below), and it reverts.
- **No keyboard shortcut, no distinct focus trap** — it is a plain `<select>`, fully native keyboard
  behavior (arrow keys, typeahead, Enter/Escape) with no custom interception.

## Keyboard and focus

- The select participates in normal document tab order — no `tabIndex` override, matching every
  other interactive control on this screen.
- `aria-label={"Move " + (camperName) + "'s placement"}` — same naming convention the table's own
  controls use (`aria-label={`Placement for ${r.camper_name ?? r.camper_id}`}`), scoped to "move"
  so a screen-reader director hears what this control specifically does, distinct from the table's
  identically-shaped select below it.
- **Focus continuity on row removal.** When the row is removed after a successful move, a director
  who was keyboard-focused on that row's select loses their focus target entirely (the node is
  gone). `RunStateRow` already has exactly one precedent for imperative focus management — its
  `alert`-row `ref.current?.focus()` effect. Reuse that shape symmetrically: `DraftRunView` adds a
  `ref` + `tabIndex={-1}` to the `run-satisfaction-summary` div (a one-line, low-risk addition to an
  existing element) and calls `.focus()` on it in the same effect/callback that removes the row from
  the session-local resolved-set. This gives a keyboard user a stable, predictable landing spot
  (the top of the screen's own content) rather than losing focus to `<body>`. If, per a later reader
  of this spec, `RunStateArea` itself still has at least one remaining row after this removal,
  focus may instead move to that next row's own element — either is acceptable; the requirement is
  that focus never silently falls off the document.

## Reduced motion

The select itself never animates (a native form control swapping in place is not a transition this
spec adds motion to — same posture as the table's own select, which has none). The **row's
removal** on success uses T250's existing collapse block verbatim
(`src/styles/shared.js:772`'s `max-height, opacity, margin, padding, border-color`, all
`var(--motion-settle)` `var(--ease-out)`), gated by `prefersReducedMotion()` exactly as
`RunStateRows.jsx`'s header already mandates for this whole surface. Under reduced motion, the row
is removed at its end state immediately (no collapse animation), matching `useEnterTransition`'s
existing reduced-motion branch (opacity-only crossfade, no transform) used elsewhere in this file.

## Verbatim copy

**`danglingMessage` — unchanged.** No new copy is introduced for this row's message. The existing
sentence already states the condition accurately without naming a specific remedy by name, so it
remains correct regardless of which control (picker or fallback button) the action slot shows:

> {camperName}'s locked placement no longer matches this run — regenerating removed the occurrence
> it pointed to.

**New: the select's placeholder option**, exported alongside `RELEASE_LOCK_LABEL` in
`runStateCopy.js`:

```js
export const DANGLING_MOVE_PLACEHOLDER = 'Move to…'
```

**`RELEASE_LOCK_LABEL` — unchanged.** Stays exactly `'Release lock'`, used only in the
no-live-occurrences fallback branch.

No other new strings. No confirmation copy is needed (no confirmation dialog — see Layout above).

## Implementation notes for Maker

- Add `DANGLING_MOVE_PLACEHOLDER` to `runStateCopy.js` beside `RELEASE_LOCK_LABEL`; both are
  imported into `DraftRunView.jsx`'s existing import block at line 25-28.
- The select's options are `templateOccurrences.map(o => ({ id: o.id, label:
  labelForTemplateOccurrence({ occurrenceId: o.id, activityId: row.activity_id }) }))` — reuse
  `labelForTemplateOccurrence`, already defined at `DraftRunView.jsx:184`. Do not derive a second
  label function.
- `row` for a given finding is `rows.find(r => r.id === finding.assignment_id)` — reuse exactly, it
  is already computed this way inside `releaseLock` (`DraftRunView.jsx:286`). Guard the same way
  `releaseLock` implicitly does today: if `row` is somehow not found, `row?.activity_id` degrades to
  `null`, which `setElectiveAssignment` will refuse — that refusal surfaces through the normal error
  path, not a new one.
- The write call is `writeAssignment({ camperId: finding.camper_id, occurrenceId, activityId:
  row?.activity_id ?? null, locked: true })` — same function signature `releaseLock` already calls,
  different `locked` value. Do not add a second write function.
- **Session-local resolved tracking.** Extend the existing `released` `useState([])` array's
  *pattern* rather than its *name and meaning* — introduce a second array (e.g. `movedAway`) for
  assignment ids resolved via the picker, so "Release lock was clicked" and "this row was
  successfully moved" stay distinguishable in state (they have different downstream implications if
  T320's broader durable-derivation work later needs to reconcile session state against a real
  reload). `danglingRows` filters out ids present in *either* array before rendering. Do not
  overload `released` to mean both things — a reader of `released.includes(id)` today reasonably
  expects "the lock was released," and silently also meaning "or the camper was moved" is exactly
  the kind of claim-narrowing this repo's standing rules warn against.
- Each row needs its own local in-flight boolean for the select's `disabled` state during the write
  (e.g. `const [movingId, setMovingId] = useState(null)`, compared against `finding.assignment_id`)
  — a single shared boolean would incorrectly disable every dangling row's select while any one of
  them is mid-write, which is unnecessary given each write is independent and keyed to a different
  assignment id.
- Test coverage this spec breaks and what replaces it, in
  `src/screens/elective/run/ElectiveRunViews.test.jsx`:
  - **Breaks:** every test that asserts a "Release lock" button exists on `run-state-dangling-a3`
    while `catalogs()`'s default `templateOccurrences: OCCURRENCES` (non-empty) is in effect —
    specifically the three tests at lines 359, 388, and 424, plus the Round 2 test at line 1052-1068.
    All four currently render with live occurrences present, so under this spec the row now shows
    the select, not the button.
  - **Fix:** those four tests should render with the select present instead
    (`screen.getByLabelText(/Move Testcamper Charlie's placement/)` or an equivalent testid —
    recommend `data-testid={`run-state-dangling-move-${f.assignment_id}`}` on the `<select>`
    itself, i.e. `run-state-dangling-move-a3` for the existing fixture), and simulate the choice via
    `fireEvent.change(select, { target: { value: 'occ-1' } })`, then assert
    `localClient.setElectiveAssignment` was called with `{ runId: 'run-1', camperId: 'camper-3',
    occurrenceId: 'occ-1', activityId: 'act-2', locked: true }` (note `activityId: 'act-2'`, the
    fixture row `a3`'s own activity, carried over unchanged — see the a3 fixture at line 88).
  - **New test needed:** the no-live-occurrences fallback (render with `templateOccurrences={[]}`
    and `danglingFindings={dangling}`) still shows the "Release lock" button and behaves exactly as
    today's Round 2 test (line 1052) already asserts — that specific test can be kept as-is if its
    render call is updated to pass `templateOccurrences={[]}` explicitly, since its current pass
    depends on `catalogs()`'s non-empty default only because the select does not exist yet.
  - **New test needed:** a failed move (`localClient.setElectiveAssignment.mockResolvedValue({ ok:
    false, error: 'OCCURRENCE_FULL', capacity: 1, filled: 1 })`) leaves the row present, the error
    banner showing `OCCURRENCE_FULL`, and the select re-enabled at the placeholder — mirrors the
    existing "surfaces a failed Release lock write" test (line 388) structurally.
- Do not touch `RunStateRows.jsx` or the over-capacity / `PREFERENCE_EDIT_HELD` /
  `BUNDLE_TIER_NOT_COVERED` rendering paths — this spec is scoped to the
  `DANGLING_MANUAL_ASSIGNMENT` row only.
- No stylesheet. The one new style object (`danglingMoveSelect`) is an inline React style constant
  added to `DraftRunView.jsx`'s existing local `styles` object, per the repo's styling convention;
  `src/components/schedule/scheduleGrid.css`'s exception does not extend here.

## What this spec does NOT specify

- A "remove the placement" control — no write path exists for it today (see domain grounding and
  Assumption 3). Flagged as a likely follow-up ticket, not designed here.
- A two-step activity-aware picker — no catalog of valid (occurrence, activity) pairs is available
  to this screen for a cold-opened run today (see domain grounding and Assumption 2). If the owner
  wants cross-activity re-placement, that needs new IPC first.
- Any change to the over-capacity row, `PREFERENCE_EDIT_HELD`, `BUNDLE_TIER_NOT_COVERED`, the
  stale-generation row, or the Final screen — untouched by this spec.
- The "durable derivation" work referenced in the brief (making `DANGLING_MANUAL_ASSIGNMENT`
  detection survive a cold reopen) — that is data-layer work elsewhere in T320, not a UI concern
  this spec owns. This spec's local `movedAway` session-state is a UI-only mitigation consistent
  with `danglingFindings` already being documented as session-scoped.
