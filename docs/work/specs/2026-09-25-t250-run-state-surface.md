---
title: "T250 — Run-state surface for the elective run's Draft and Final screens"
document_type: spec
authority: proposed
status: draft
created: 2026-09-25
governing_docs: [docs/governance/standards/DESIGN_STANDARD.md]
related_adrs: [docs/adr/2026-09-23-elective-run-lifecycle-and-remaining-slices.md, docs/adr/2026-09-17-individual-elective-scheduling.md]
related_tickets: [docs/work/tickets/T250-draft-and-final-director-ui.md]
archive_when: T250 ships Maker's implementation of this run-state area and Governor confirms it against this spec
---

# T250 — Run-state surface (Draft and Final)

This is a design spec, not code. It covers exactly one thing: the **run-state area** — the part of
the Draft and Final screens that tells a director what state their elective run is in and what, if
anything, needs their attention. It does not redesign `AssignmentPanel`, the offerings table, the
preference-import flow, or anything upstream of a solved run.

## Grounding in the real screen

`src/screens/elective/assignment/AssignmentPanel.jsx` today is a single-run phase machine (`empty →
parsing → mapping → parsed → solving → preview → committing → committed`) mounted inline under
`ElectiveSetDetail`'s offerings table. There is no persisted-run list, no read-only Final view, and
no re-render of a run after `committed` — closing and reopening the screen loses the on-screen
state entirely (the run itself persists via `commitElectiveRun`, but nothing re-displays it).
`EncryptionDisclosure` (lines 113-136) is the one existing precedent in this file for a permanent,
non-dismissible, state-driven inline row using `S.cautionBanner` — this spec's stale-generation and
over-capacity rows follow the same construction pattern, not the schedule-findings pattern.

T250's Draft and Final screens are new UI built on top of the existing `commit` → `committedInfo`
data and the new T244/T245/T246 IPC surface (`finalizeElectiveRun`, `setElectiveAssignment`,
`listElectiveRuns`, `getElectiveRun`). This spec assumes the run list and the Draft/Final screen
shells exist (Maker's job, per T250's own scope) and specifies only the run-state area inside them.

## Layout

### Where it sits

In both Draft and Final, the run-state area is a fixed block **directly under the screen's own
identity line** (the line that already states the run's name/source file and Draft-vs-Final
status), **above** everything else on the screen (move/lock table in Draft; export/start-a-revision
controls in Final — though see below, the stale-generation row sits with that action specifically).
It is not a floating popover, not a modal, and not anchored to any other control — it is simply the
next block in the screen's own vertical flow, exactly where `EncryptionDisclosure` sits relative to
`AssignmentPanel`'s phases: unconditionally mounted, never toggled by a click.

### Draft run-state area

Order, top to bottom:

1. **Identity line** (already exists / Maker-owned, not this spec): run name, route/week/division,
   Draft status word.
2. **Satisfaction summary** (already in ticket scope, not detailed further here — T250 owns its
   exact copy; this spec does not redesign it). Placed above the findings block because it is the
   normal-case, good-news line a director reads first.
3. **Run-state findings block** — this spec's subject. Contains, in this fixed order when present:
   - Over-capacity rows (one per affected occurrence)
   - Dangling-manual-assignment rows (one per affected camper)
4. Below the run-state area: the existing findings vocabulary for per-camper "unassigned reasons"
   (unchanged, out of scope here), then the move/lock table.

**Empty/clean state — the common case.** When neither over-capacity nor dangling-manual-assignment
findings exist, **render nothing at all for the findings block** — no empty-state card, no "All
clear" line, no collapsed accordion header. The satisfaction summary alone occupies that vertical
position. This is the same restraint principle already governing `FindingsRail`'s stat-badge
popover (which does show "No issues found." there, because it is opened on demand) — but this block
is *always mounted*, not opened on demand, so an always-visible "all clear" card would read as a
permanent dashboard tile on a screen whose personality is quiet and precise. A director scanning a
healthy run should see the satisfaction summary and the move/lock table with nothing between them.

**When findings exist**, the block is a plain vertical list of rows, no card chrome, no header
label reading something like "Findings" or "Issues" (no new named vocabulary — see Q5 below). Each
row uses the same visual grammar as `S.cautionBanner` (bronze accent, not red/danger — these are
not the encryption gate's hard refusal, they are conditions a director can act on) but rendered as
individual rows, not one collapsed banner, because each names a different occurrence or camper and
the director may act on some and not others independently.

Row shape (both finding kinds), inline React style object equivalent to `S.cautionBanner` but as a
row rather than a block (no bottom margin between adjacent rows; a single 1px `--border` divider
between rows instead, so a run of five rows reads as a list, not five stacked cards):

```
[ bronze-tinted row ]
  <message copy>                                    [ action button, right-aligned ]
```

- **Over-capacity row**: no action button. There is nothing to click that fixes it from this row —
  the remedy is the move/lock table below, where the director drags a camper off the
  over-full occurrence. The row is a pointer, not a control.
- **Dangling-manual-assignment row**: one action button, per the ticket's own language — "the
  action that resolves it (re-place or release the lock)". Resolve this as a single button reading
  **"Release lock"** (see Q5 below for why "release" over "unlock"), which drops `is_locked` on that
  assignment and returns the camper to the ordinary re-placement flow already used elsewhere on this
  screen. This spec does not design a "re-place" control distinct from what the move/lock table
  already does once the lock is released — the ticket names two remedies, but releasing the lock is
  the one action this row needs; re-placement then happens through the table, not a second button
  here.

**Live update.** Both rows appear and disappear as soon as their underlying condition changes
(a regenerate that resolves an over-capacity occurrence removes that row on the next render; the
"Release lock" click removes that dangling row and the affected camper becomes an ordinary
unplaced/placeable row in the table below). No confirmation dialog on "Release lock" — it does not
delete data, it converts a locked, now-invalid assignment back into an editable one, which is
strictly less destructive than the state it's replacing.

### Final run-state area

Order, top to bottom:

1. **Identity line** (Maker-owned): source file, route/week/division, `finalized_at`,
   `finalized_by`.
2. **Run-state area** — this spec's subject, containing, when present:
   - The stale-generation row, **directly above** the "Start a revision" action (see below — this
     pairing is a hard constraint, not a placement preference).
   - Over-capacity rows (same row shape as Draft, no action button — Final has no move/lock table,
     so there is genuinely nothing to click here; see below).
3. **Actions row**: Export, Start a revision.

**Empty/clean state.** When `finalizedAgainstStaleGeneration` is false and
`overCapacityOccurrences` is empty, render nothing in the run-state area — the screen goes straight
from the identity line to the actions row. This is the ordinary case for a run finalized once and
never touched again; it must read as a plain, calm confirmation screen, not a dashboard.

**Stale-generation row.** Renders as a single bronze row (same `cautionBanner`-derived treatment as
Draft's rows), containing:
- The copy (verbatim, see below).
- Immediately below or beside it, the existing "Start a revision" button — same button, not a
  duplicate. If "Start a revision" is already going to appear in the actions row regardless (it is
  always available on a Final screen), this row sits **directly above** that button so the two read
  as one visual unit: state, then its remedy, with no other row between them. Do not render a second
  copy of the button inside the bronze row itself — one control, positioned so the stale-generation
  row and the button are adjacent in the DOM and visually grouped (e.g., no divider between them,
  shared left edge, the row's bottom margin removed so the button appears to sit "inside" the same
  visual block).

**Over-capacity rows in Final.** Same message and row shape as Draft, no action button — there is
no move/lock table on a Final screen to act through, and Q1/Q2 already rule finalized runs
immutable. The row exists purely so the director is told (per the ADR's standing "detect and
surface, never silently succeed" posture) that the run they're looking at has a real, uncorrected
problem, and their only remedy is "Start a revision." Do not add a second "Start a revision" pointer
under each over-capacity row — one instance of that action per screen is enough; multiplying the
button per finding would read as multiple different actions when there is only one.

**If both stale-generation and over-capacity findings are present simultaneously**, order is
stale-generation first (it's a broader, run-level correctness question — "this whole run predates a
change"), then the over-capacity rows. Both still sit above the actions row; "Start a revision"
remains a single button, not duplicated per finding.

## Visual style

- Row background/border/text: `color-mix(in srgb, var(--accent) 12%, var(--surface))` /
  `1px solid color-mix(in srgb, var(--accent) 45%, var(--border))` /
  `color-mix(in srgb, var(--accent) 65%, var(--text))` — i.e., reuse `S.cautionBanner`'s exact
  color formula, do not invent a new token or a new named severity color. This keeps the bronze
  "advisory, act on it" meaning consistent with the one other place in this codebase that already
  uses it for a non-dismissible, always-rendered, state-driven condition.
- Row padding: `10px 14px`, matching `S.cautionBanner`.
- Row typography: `fontSize: 13`, matching `S.cautionBanner`'s body text; no bold, no caps label.
- Divider between stacked rows: `1px solid var(--border)` (not the accent color — the divider is
  structural, not another instance of the warning color).
- Action button inside a row ("Release lock"): `S.btnSecondary` at row scale — reuse the button
  style already used everywhere else on this screen (`className="press-97"`, `style={S.btnSecondary}`),
  right-aligned in the row via flex (`display: flex; justifyContent: space-between; alignItems:
  center`).
- No icon glyphs on these rows. `FindingsRail` uses a severity dot; this surface does not adopt that
  vocabulary (per the ADR's explicit instruction not to reuse the findings vocabulary's visual
  language, only its "detect and surface" posture). Plain text rows are consistent with
  `EncryptionDisclosure`'s own precedent, which also carries no icon.

## States

- **Draft, no findings**: satisfaction summary only; findings block occupies zero vertical space.
- **Draft, over-capacity present**: one row per over-full occurrence, no button.
- **Draft, dangling-manual-assignment present**: one row per affected camper, "Release lock" button.
- **Draft, both present**: over-capacity rows first, then dangling-manual-assignment rows (a
  director fixes structural capacity problems before chasing individual locked-seat drift, since a
  regenerate to fix capacity may itself change which assignments are dangling).
- **Final, clean**: nothing between identity line and actions row.
- **Final, stale-generation only**: bronze row + adjacent "Start a revision" button.
- **Final, over-capacity only**: bronze row(s), no button, "Start a revision" still present in the
  actions row as it always is on Final (unconditional action, not conditional on findings).
- **Final, both**: stale-generation row (paired with the button) first, then over-capacity rows,
  all above the actions row.
- **Loading** (run-state data not yet returned from `getElectiveRun`): render nothing in the
  findings position rather than a spinner or skeleton — the identity line's own load state (Maker's
  concern) governs the visible "is this screen ready" signal; this block should not introduce a
  second, contradictory loading indicator for one section of the same screen.
- **Error** (the `getElectiveRun` call itself fails): out of scope for this spec — Maker follows the
  repo's standing `describeWriteFailure` convention for the surrounding screen; this run-state block
  simply does not render if the underlying findings data isn't available, same as "loading."

## Interactions

- **"Release lock" click** (Draft, dangling-manual-assignment row): calls the existing lock-release
  path already used by the move/lock table (this spec does not invent a new IPC call — T245's
  `shoresh:set-elective-assignment` already carries an `is_locked` flag per the ticket's own scope;
  Maker wires this button to the same call with `is_locked: false`). On success, the row disappears
  (see Animation below) and the camper's row in the table below re-renders as unplaced/placeable. No
  confirmation dialog.
- **"Start a revision" click** (Final, present regardless of findings): unchanged from the rest of
  T250's scope — this spec does not redesign that control's own behavior, only its adjacency to the
  stale-generation row.
- Over-capacity rows have no click target of their own. They are read-only text.

## Animation

Personality reminder: professional, grounded, quiet, precise — never playful. Every transition here
is a state changing, not a decoration.

- **Row appearing** (a finding becomes non-empty on this render — e.g., a regenerate introduces a
  new over-capacity occurrence, or T244's finalize returns `finalizedAgainstStaleGeneration: true`):
  use the same `liftFade` enter transition already defined in `src/styles/shared.js`
  (`useEnterTransition('liftFade')` — translateY(8px)→0 + opacity 0→1, `var(--motion-base)` /
  220ms, `var(--ease-out)`). This is the same transition `AssignmentPanel` already uses for its own
  phase-entry content, so a new row entering this screen moves the same way everything else on it
  does — no new easing curve, no new duration token.
- **Row disappearing** ("Release lock" resolves the finding, or a regenerate clears an over-capacity
  occurrence): fade and collapse together — `opacity` to 0 over `var(--motion-fast)` (140ms)
  `var(--ease-out)`, with `max-height`/`margin`/`padding` transitioning to 0 over `var(--motion-settle)`
  (340ms) `var(--ease-out)` on the same property list `src/styles/shared.js:772` already uses for
  its own collapse pattern (`max-height, opacity, margin, padding, border-color`, all
  `var(--motion-settle)` `var(--ease-out)`) — reuse that existing collapse block rather than
  authoring a new one. This avoids the row's removal reading as an abrupt layout jump when the list
  above the move/lock table shrinks by one row.
- **Reduced motion**: every transition above must check `prefersReducedMotion()` (already imported
  and used in this file) and skip straight to the end state — this is the same guard
  `EncryptionDisclosure`'s `disclosureStyles.neutral` and `Busy`'s spinner already apply; do not add
  motion here that bypasses it.
- No entrance animation on first mount of a screen already showing findings (e.g., navigating
  straight to a Final run that already has a stale-generation flag) — only a **transition into** a
  new state during an active session animates. A findings block that is simply present on initial
  render should render at rest, matching the existing convention that `liftFade`/`settle` are for
  a phase *changing*, not for every mount.

## Prototype

Not produced. The ticket's scope is narrow enough (a handful of text rows and one button, reusing
four existing primitives verbatim — `S.cautionBanner`'s color formula, `S.btnSecondary`,
`useEnterTransition('liftFade')`, and the `scheduleGrid.css`-adjacent collapse transition already in
`shared.js:772`) that a throwaway HTML mockup would not surface anything this written spec doesn't
already pin. Maker should build directly against this document and the cited line numbers.

## Implementation notes for Maker

- Reuse `S.cautionBanner`'s color formula for the row background/border/text; do not add a new
  token or a new named severity to `src/index.css`.
- Reuse the collapse-transition property list at `src/styles/shared.js:772` for a row's removal;
  reuse `useEnterTransition('liftFade')` for a row's appearance. Do not author new keyframes or a
  new easing curve for this surface.
- The "Release lock" button must call the same T245 write path the move/lock table uses
  (`is_locked: false`), not a bespoke handler — this keeps lock semantics in one place.
- Both the Draft and Final run-state areas are **admin-only surfaces by inheritance**: they render
  inside the same screens T250 is already gating to admin per the ticket's own scope
  ("Both states admin-only, verified not reachable from staff navigation
  (`src/components/layout/navSections.js`)"). This spec does not add a second gate — it assumes
  Maker's screen-level admin gate already covers this block, and Maker's own test for "not reachable
  from staff navigation" should exercise a screen that includes this block in a findings-present
  state, not only the clean state, since the clean state renders nothing and would pass a
  reachability test vacuously.
- Do not add a stylesheet. Everything specified here is inline React style objects reusing
  `src/styles/shared.js` constants, per the repo's styling convention; the one CSS-file exception
  (`src/components/schedule/scheduleGrid.css`) is scoped to `src/components/schedule/` and this
  surface is outside that boundary.
- The over-capacity row's message must name the occurrence (not just an id) and the over-count —
  see copy below for the exact template; Maker resolves "name the occurrence" against whatever
  human-readable occurrence label (activity + day + time block, or however `overCapacityOccurrences`
  is already shaped by T244) the IPC payload actually returns, and should not invent a new label
  format if one already exists elsewhere in this screen's data.

## Verbatim copy

All copy below is final, not a placeholder. `{n}` denotes a computed value; `{occurrence}` denotes
whatever human-readable occurrence label T244's payload provides (e.g. "Pottery — Tuesday, Period
3"); `{camperName}` is the camper's display name already used elsewhere on this screen.

**Draft — over-capacity row:**
> {occurrence} has {filled} campers assigned against a capacity of {capacity}.

(Plural-safe: "1 camper" vs "N campers" — Maker applies the repo's existing pluralization
convention used elsewhere in this file, e.g. `AssignmentPanel.jsx`'s own `"{n} campers assigned
across {n} occurrences."`.)

**Draft — dangling-manual-assignment row:**
> {camperName}'s locked placement no longer matches this run — regenerating removed the occurrence
> it pointed to.

Button: **Release lock**

**Final — stale-generation row:**
> This run was finalized before a later change on another device synced in. It is out of date.

Button (existing, adjacent, unchanged): **Start a revision**

**Final — over-capacity row:**
> {occurrence} has {filled} campers assigned against a capacity of {capacity}.

(Same template as Draft — one wording for one fact, regardless of which screen shows it.)

## Q5 — director-facing terminology, resolved

The ADR deferred five concepts to this pass. One recommendation each, reasoning included. Per the
NO-HELP rule, none of these are explainer text — they are the plain nouns/verbs the screen itself
uses.

1. **"Draft"** — keep as-is. **No owner sign-off needed.** It is already the word T199's own
   director-flow table uses, it is a word directors already know from every other software they've
   touched (a document that isn't final yet), and it requires no domain translation — "draft" means
   exactly what a camp director thinks it means here.

2. **"Final"** — keep as-is, same reasoning as Draft. **No owner sign-off needed.**

3. **"Start a revision"** — recommend changing the button label to **"Start a new version"**.
   Reasoning: "revision" is a document-editing term that implies *editing the same thing*, which is
   the opposite of what Q1/Q2 actually ruled (immutable, no reopen, a fresh run). "New version" more
   honestly signals "this creates a separate thing," matching what actually happens on click,
   without requiring the director to already understand the immutability rule to predict the
   button's effect. **Flag for owner sign-off** — this is exactly the kind of naming decision Q5
   named as his question, and "revision" vs "version" changes what a director expects to happen
   when they click it, which is a real behavioral expectation, not cosmetic wording.

4. **The stale-generation state** — no new noun needed; it is not a named concept on screen, only a
   sentence (see copy above: "finalized before a later change... it is out of date"). Recommend
   against inventing a label like "Stale" or "Outdated Run" as a badge/chip — a single-sentence
   explanation of what happened is more honest to a non-technical reader than a jargon chip that
   itself would need a tooltip to explain (which the NO-HELP rule forbids). **No owner sign-off
   needed** — this follows directly from the ticket's own instruction to "name what actually
   happened," and there is no competing short-label alternative worth choosing between.

5. **The over-capacity state** — no new noun needed either; same reasoning — a sentence naming the
   occurrence and the numbers is more legible than a label like "Overbooked" that still requires the
   same sentence underneath it to be actionable. **No owner sign-off needed.**

**Summary for owner sign-off:** only item 3, "Start a new version" (replacing "Start a revision"),
needs the owner's explicit yes — it is the one place where the word choice changes what a director
expects the button to do.

## What this spec does NOT specify

- The satisfaction summary's exact copy or layout (T250's own scope, not a run-state finding).
- The move/lock table's drag/drop mechanics, row layout, or the "unassigned reasons" findings block
  below it (existing findings vocabulary, unchanged).
- The run-list screen (which run a director is looking at, how they navigate between runs).
- The identity line's exact layout (source file, route/week/division, `finalized_at`/`finalized_by`)
  — Maker-owned per the ticket.
- The export action's UI or `exportChildSchedule` wiring (T248's surface).
- Any IPC contract shape — `overCapacityOccurrences`, `finalizedAgainstStaleGeneration`, and
  `DANGLING_MANUAL_ASSIGNMENT` are assumed to arrive from `getElectiveRun`/T244/T246 exactly as the
  ADR already specifies (`overCapacityOccurrences: [{occurrenceId, capacity, filled}]` per the ADR's
  line 465); this spec only says how to render what those payloads already contain.
- The admin-only navigation gate mechanism itself (`navSections.js`) — this spec assumes it exists
  and covers the screens this block is mounted in; verifying that is Maker's/Verifier's job per the
  ticket.
- Whether "Start a new version" carries locked seats forward from the old run — the ADR explicitly
  says this is "not designed here" (Q1's Option A note); this spec does not design it either.
