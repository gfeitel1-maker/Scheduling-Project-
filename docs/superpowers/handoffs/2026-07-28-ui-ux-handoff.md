# UI/UX Handoff — 2026-07-28

**Audience:** a fresh agent session with zero memory of this work.
**Scope of this handoff:** UI/UX only. Electron packaging and the sync/op-log layer belong to a
different, concurrently-running session. Do not touch them.

Read this whole file before doing anything. Every path, SHA, and line reference below was verified
against live code on 2026-07-28. If something here contradicts the code you are looking at, **the
code wins** — the Constitution says live code outranks agent memory. Fix this document when that
happens.

---

## 1. Where you are

### Working directory

```
/Users/gregfeitel/dev/shoresh-ui        branch: ui/state-primitives   ← YOU WORK HERE
```

This is a **git worktree**, not a clone.

```
/Users/gregfeitel/dev/shoresh           branch: governance/promote-and-archive
```

That is a **separate worktree** owned by a **concurrent session** doing sync / op-log / Electron
work. The two worktrees share a single `.git` directory.

> Note: an earlier framing of this handoff described the other worktree as being on `main`. As of
> this writing `git worktree list` reports it at `b7a1900 [governance/promote-and-archive]`. It
> moves. Do not assume its branch; just stay out of it.

**Never** read, write, commit, `cd` into, or run commands against `/Users/gregfeitel/dev/shoresh`.
Because the `.git` is shared, a careless git operation there — or a branch checkout from here — can
corrupt the other session's in-flight work.

### Absolute prohibitions

- **Never run `git stash`** anywhere in this project. A prior agent run destroyed its own work
  doing exactly this. There is no acceptable use of it here. If you need a clean tree, commit.
- **Never push.** Nothing is pushed. The user holds all pushes and grants permission explicitly,
  per push. Do not offer to push as a default next step.
- **Never `git checkout` a branch in this worktree** that the other worktree has checked out.
- **Do not touch anything under `~/Desktop/Camp App System .../Schedule Project`.** That path is
  dead. The repo was moved off iCloud after iCloud eviction corrupted the old checkout beyond
  repair. If you find a reference to that path anywhere, it is stale.

---

## 2. Current state, and how to verify it

Branch `ui/state-primitives` is **3 commits ahead of `main`**. Working tree is clean.

| SHA | What it did |
|---|---|
| `e1238e6` | `refactor(ui): centralize empty/loading state styling into shared primitives` — empty/loading state primitives added to `src/styles/shared.js`, applied across 11 screens |
| `1d01192` | `refactor(schedule): make grid marks truthful and reserve colour for problems` — schedule grid truthful marks + de-colorization + `FindingsRail`. Has an ADR. |
| `821ed42` | `fix(schedule): count a spanned activity once when recomputing findings` — `computeFindings` was counting span tails; now counts the head only |

`1d01192` carries the design record:

- ADR: `/Users/gregfeitel/dev/shoresh-ui/docs/adr/2026-07-28-schedule-flag-findings-reshape.md`
- Specs: `/Users/gregfeitel/dev/shoresh-ui/docs/superpowers/specs/2026-07-28-schedule-flag-findings-reshape-design.md`
  and `.../2026-07-28-schedule-grid-decolorization-design.md`
- Prototype: `/Users/gregfeitel/dev/shoresh-ui/docs/superpowers/specs/prototypes/2026-07-28-schedule-grid-decolorization-prototype.html`

### Gates at HEAD (run by the previous governor, re-run them yourself before trusting them)

```bash
cd /Users/gregfeitel/dev/shoresh-ui
npm run lint            # 0 errors, 11 warnings (all pre-existing react-hooks/exhaustive-deps)
npx vitest run src/     # 146 passed
npm run build           # succeeds
```

**`npm run test` (the full suite, including `electron/`) has pre-existing failures.** Those belong
to the other session's layer. **Do not "fix" them.** Scope your verification to `npx vitest run
src/`. If you believe a UI change broke an `electron/` test, say so and stop — do not edit
`electron/`.

Also note: `better-sqlite3` is a native module whose ABI drifts between Node (Vitest) and Electron.
If you hit native-module load errors, see `CLAUDE.md`. For pure UI work in the browser dev server
you should never need to rebuild it.

---

## 3. Standing constraints — these bind every ticket below

These are project law, not preferences. Bake them into any Maker brief you write.

**Styling**
- **All styles are inline React style objects.** No CSS files, no CSS modules, no `className` used
  for styling.
- Shared tokens and primitives live in `src/styles/shared.js`, imported as
  `import { S } from '../styles/shared'`. Component-specific styles are `const` objects at the
  bottom of the component file.
- CSS custom properties live in `src/index.css` and are referenced as `var(--token)`.

**Architecture**
- Screens reach Electron **only** through `src/localClient.js`. The renderer never touches SQLite.
- **No router.** `src/App.jsx`'s `AppShell` holds a `screen` string in `useState`, looks it up in
  the `SCREENS` map, and threads `campId` + `onNavigate` as props. Do not introduce routing.
- Drag and drop is `@dnd-kit/core` with `PointerSensor` and a **`distance: 8` activation
  constraint**. That constraint exists so drag can coexist with click handlers on the same cells.
  Any change near the grid must keep both working.
- **No new dependencies** without an explicit written justification and user approval.

**Design personality** — professional, grounded, warm, quiet, precise. **Never playful.**
**Colour means meaning, not decoration.** This is the thesis `1d01192` implemented; do not
regress it by re-introducing decorative colour.

**Process** — every ticket below runs through the **GOVERNOR loop**
(`.claude/agents/governor.md`), not a generic superpowers flow: clarify → classify → (Designer /
Architect if warranted) → Maker → parallel review (Tester, Security, Red Hat, Code Reviewer) →
Verifier → Grader → decide. All sub-agent dispatches must be **foreground/synchronous**; this loop
has stalled for hours in the past when a governor backgrounded a child dispatch.

---

## 4. Dev environment recipes (copy-pasteable)

### 4.1 Start the dev server

The preview/launch tooling (`preview_start` by config name, `.claude/launch.json`) is anchored to
`/Users/gregfeitel/dev/shoresh`, **not** this worktree. It will not start the right server from
here. Start it with a background shell command and open the URL directly.

Port **5200 belongs to the other session.** Use 5201.

```bash
cd /Users/gregfeitel/dev/shoresh-ui
npm run dev -- --port 5201 --strictPort
```

Then open `http://localhost:5201`.

`npm run dev` is the **browser renderer against a dev mock** (`src/localClient.mock.js`) — not the
real stack. It is the right tool for UI/UX work. Anything involving persistence, auth, or sync must
be verified under `npm run electron:dev`, which is out of scope here.

### 4.2 THE TRAP: the browser dev mock stores booleans as strings

**Read this before you conclude the schedule grid is broken.**

`src/localClient.mock.js` persists all state to `localStorage` under the key `shoresh-mock-state`.
Its `write({ entity, entity_id, field, value })` path stores `value` as it arrives — which for
slot boolean fields is the **string** `"1"`, not the number `1`.

`src/utils/normalizeSlots.js` normalizes those fields through `toSlotBool`
(`src/utils/normalizeSlots.js:27`):

```js
function toSlotBool(value) {
  if (value === null || value === undefined) return value
  return value === 1 || value === true
}
```

Strict equality. `"1"` is neither `1` nor `true`, so it becomes `false`. `is_span_head: false`
means "this slot is a merged span **tail**" — so **every** slot reads as a tail and
**the grid renders completely empty.**

This is a **mock-only** bug. Real SQLite columns have INTEGER affinity, so the value comes back as
a number and Electron is unaffected. `toSlotBool`'s strictness is also deliberate: it preserves
`null` (meaning "never written") rather than coercing it to `false`, which would mark every
pre-migration slot as a merged tail. **Do not loosen `toSlotBool` to fix a mock problem.**

Fix it in the mock's stored state instead. Paste in the browser console, then reload:

```js
// Coerce slot booleans back to numbers in the browser dev mock's localStorage.
const KEY = 'shoresh-mock-state'
const state = JSON.parse(localStorage.getItem(KEY))
const BOOL_FIELDS = ['is_anchor', 'is_span_head', 'is_released']
for (const row of (state.template_slots || [])) {
  for (const f of BOOL_FIELDS) {
    if (row[f] === '1' || row[f] === 1 || row[f] === true) row[f] = 1
    else if (row[f] === '0' || row[f] === 0 || row[f] === false) row[f] = 0
    // leave null/undefined alone — null means "never written"
  }
}
localStorage.setItem(KEY, JSON.stringify(state))
location.reload()
```

> Verify the collection name against `src/localClient.mock.js` before running — the mock's internal
> state shape is not a stable contract and the key holding slots may differ from
> `template_slots`. Log `Object.keys(JSON.parse(localStorage.getItem('shoresh-mock-state')))`
> first.

### 4.3 Get a realistic camp in front of your eyes, fast

Clicking through setup for a 16-group camp takes far too long. Bootstrap the shell by hand, then
seed the data directly.

1. Open `http://localhost:5201`.
2. Choose **Host** mode, create a camp, create a user, sign in. (This part must be clicked — it
   establishes the mock's camp and session.)
3. In the console, seed `shoresh-mock-state` with a realistic dataset: **4 units × 4 groups = 16
   groups, 22 activities, 6 time blocks, 5 days.**

```js
// Seed a realistic camp into the browser dev mock.
// Read the existing state first so camp/user/session survive.
const KEY = 'shoresh-mock-state'
const s = JSON.parse(localStorage.getItem(KEY))
const campId = s.camp.id
const id = p => p + '-' + Math.random().toString(36).slice(2, 9)

s.tiers = Array.from({ length: 4 }, (_, i) => ({
  id: id('tier'), camp_id: campId, name: `Unit ${i + 1}`, sort_order: i,
}))

s.groups = s.tiers.flatMap((t, ti) =>
  Array.from({ length: 4 }, (_, gi) => ({
    id: id('grp'), camp_id: campId, tier_id: t.id,
    name: `${t.name} · Group ${gi + 1}`, sort_order: ti * 4 + gi,
  })))

s.days = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday'].map((name, i) => ({
  id: id('day'), camp_id: campId, name, sort_order: i,
}))

s.time_blocks = Array.from({ length: 6 }, (_, i) => ({
  id: id('blk'), camp_id: campId, name: `Block ${i + 1}`,
  start_time: `${8 + i}:00`, end_time: `${9 + i}:00`, sort_order: i,
}))

const ACT_NAMES = [
  'Swimming', 'Drama', 'Archery', 'Ceramics', 'Basketball', 'Soccer',
  'Woodworking', 'Nature Walk', 'Canoeing', 'Photography', 'Cooking',
  'Rock Climbing', 'Music', 'Dance', 'Gaga', 'Tennis', 'Painting',
  'Robotics', 'Gardening', 'Ultimate', 'Yoga', 'Campfire',
]
s.activities = ACT_NAMES.map((name, i) => ({
  id: id('act'), camp_id: campId, name,
  location: `Location ${(i % 8) + 1}`,
  max_groups_per_slot: (i % 3) + 1,
  priority: i < 8 ? 'high' : 'low',
  eligibility: null,
  sort_order: i,
}))

localStorage.setItem(KEY, JSON.stringify(s))
location.reload()
```

4. Navigate to **Schedule** and click **Generate Schedule**.
5. If the grid renders empty, you hit §4.2. Run the boolean-coercion snippet.

> The exact field names above were written from the domain vocabulary in `buildSchedule.js` and the
> setup screens. **Verify them against `src/localClient.mock.js` and the relevant screens before
> trusting the snippet wholesale** — this is a convenience recipe, not a tested fixture. If it
> drifts, the fastest repair is to create one row of each kind through the UI, inspect the shape in
> localStorage, and adjust.

### 4.4 Force an UNFILLABLE cell (to exercise the problem path)

After generating a schedule, pick one slot, null its `activity_id`, and stamp the flag:

```js
const KEY = 'shoresh-mock-state'
const s = JSON.parse(localStorage.getItem(KEY))
const slot = s.template_slots.find(r => r.activity_id)   // any filled slot
slot.activity_id = null
slot.flags = JSON.stringify({
  UNFILLABLE: true,
  UNFILLABLE_reason: 'No eligible activity has capacity in this block.',
})
localStorage.setItem(KEY, JSON.stringify(s))
location.reload()
```

`flags` crosses the LAN op-log boundary as JSON, so it may be stored as a JSON **string** or as an
object depending on path — check how neighbouring rows store it and match them.

---

## 5. The four open tickets

Each ticket below is self-contained. All four are also filed as background-task chips; this
document is the authoritative version.

---

### Ticket 1 — Day view shows only 5 of 16 groups

**File:** `/Users/gregfeitel/dev/shoresh-ui/src/components/schedule/ScheduleDayView.jsx`

**Evidence (measured, not estimated).** In a live browser at a 1280px viewport with 16 groups,
**5 group columns are visible.** An earlier estimate of "8 of 16", derived by reading the CSS
rather than measuring, was **wrong**. Trust the measurement; re-measure before and after any change.

**The mechanics.** `ScheduleDayView.jsx:59`:

```js
<table style={{ borderCollapse: 'collapse', tableLayout: 'fixed', width: '100%',
                minWidth: 140 + groups.length * 130, ... }}>
```

`ScheduleDayView.jsx:62` — the Block header cell is `width: 140`, `position: 'sticky'`, `top: 0`,
`left: 0`, `zIndex: 3`. `:63` — group headers are sticky-top. `:76` — the row's Block cell is
sticky-left. So: a fixed-layout table, a 140px frozen first column, 130px per group, horizontally
scrolled inside its container. 16 groups → 2220px of table in a ~1280px window.

**Approaches already tried and REJECTED — do not re-propose them:**

| Rejected | Why |
|---|---|
| Fisheye / focus+context column widths | Fights `tableLayout: fixed`. Column widths are resolved once from the first row; per-column dynamic widths force layout thrash and break the `rowSpan` merged-span cells. |
| Foveal dimming (dim off-focus columns) | Same `rowSpan` problem, plus it directly contradicts "colour/contrast means meaning, not decoration" — dimming a column would read as a *state*, which it isn't. |
| Batch-wave pagination (show groups N at a time) | **Destabilizes position during a drag.** A drag in progress across a paging boundary loses its drop target. This is the strongest objection: it breaks the `distance: 8` DnD contract. |

Any new proposal must survive all three of those failure modes: `tableLayout: fixed`, `rowSpan`
span cells, and an in-flight drag.

**Constraints:** inline styles only; the sticky Block column must stay frozen; `@dnd-kit` drag must
keep working across whatever you do; no new dependencies.

**Success predicate (a non-engineer can judge this):** *"With 16 groups on screen at my normal
window size, I can see which groups I am looking at and get to any group's column without losing my
place, and I can still drag an activity from one cell to another anywhere in the day."*

**Governor note:** this is UI-significant. Dispatch **Designer** before Maker. It is also the
ticket most likely to need Red Hat's input on the drag-interaction risk.

---

### Ticket 2 — Escape does not close the Assign Activity modal

**File:** `/Users/gregfeitel/dev/shoresh-ui/src/components/schedule/EditModal.jsx`

**Evidence.** Confirmed in a live browser: Escape pressed twice with the modal open, DOM checked
afterward — the modal is still mounted. Grepping `EditModal.jsx` for `Escape` / `keydown` /
`onKeyDown` returns **nothing**. The modal has no keyboard handler at all.

**Why this is an inconsistency, not a gap.** `ScheduleScreen.jsx` already has a keyboard layer —
see `src/screens/ScheduleScreen.jsx:114` (`// T3 — keyboard shortcuts: Ctrl+C (copy), Ctrl+A
(select all), Escape`), with the Escape branch at `:118` and a platform-aware meta/ctrl check at
`:165`. So the app's own standard is that Escape works; the modal is the outlier.

**The specific hazard: double-fire.** `ScheduleScreen`'s Escape handler is a document-level
listener. If you add another document-level Escape listener in `EditModal`, one keypress will run
both — closing the modal *and* clearing the screen's selection, or worse. Options: stop propagation
from the modal's handler; or have `ScheduleScreen`'s handler early-return while a modal is open;
or lift modal-open state so the screen handler routes Escape to the modal first. Whichever you
choose, **test that a single Escape produces exactly one effect**, and that Escape with no modal
open still does what it did before.

**Constraints:** inline styles only; no new dependencies (no focus-trap library without
justification); do not disturb Cmd+C / Cmd+A / undo/redo.

**Success predicate:** *"When the Assign Activity dialog is open, pressing Escape once closes it
and changes nothing else. Pressing Escape with no dialog open behaves exactly as it did before."*

**Uncertainty to flag:** it has **never been verified** whether other modals in the app
(`FlagDetailModal.jsx`, and any modals on setup screens) have the same problem. Check them as part
of this ticket, and be explicit in your report about which ones you actually tested versus which
you only read.

---

### Ticket 3 — All 12 sidebar nav buttons have no accessible name

**Directory:** `/Users/gregfeitel/dev/shoresh-ui/src/components/layout/`
(`Sidebar.jsx`, `Shell.jsx`, `TopBar.jsx`)

**Evidence.** Reading the **live accessibility tree** in the browser, all 12 sidebar nav buttons
resolve with no accessible name. Sibling buttons elsewhere — e.g. "Export to Excel" — resolve fine,
so the a11y tooling is working; this is real.

**The count of 12 is confirmed** in `Sidebar.jsx`: `setup`, `cohorts` (Programs), `tiers` (Units),
`groups`, `days`, `timeblocks`, `activities`, `anchors` (Fixed Events), `dayoverrides`, `schedule`,
`conflicts`, `devices`.

**DIAGNOSE BEFORE YOU FIX.** Do not reflexively add `aria-label`. The buttons **do** render visible
text — `Sidebar.jsx:106-136` renders `<button>` → `<span>` → `{item.label}`. A button containing
visible text should already compute an accessible name from its contents. That it doesn't means
something else is wrong, and slapping `aria-label` on top would paper over the real cause and leave
the same class of bug everywhere else. Candidate causes worth ruling out: the nested
`<span style={{ display: 'inline-flex' }}>` wrapper affecting name computation; an ancestor with
`aria-hidden` or a role that prunes the subtree; or an artifact of how the a11y tree was read.
Confirm the root cause in the live tree before writing any code.

**Also in scope:**
- **Selected state.** Currently the active item is conveyed only visually
  (`fontWeight: 600`, `color: var(--primary)`, a 3px `borderLeft`). There is no
  `aria-current="page"` — a screen-reader user cannot tell which screen they are on.
- **Icon-only buttons** on `ScheduleScreen` and the activity palettes share the missing-name
  problem. Enumerate them; fix the ones with the same root cause.

**Constraints:** inline styles only — the visual design must not change unless Designer says so;
no `className` for styling; no new dependencies.

**Success predicate:** *"With a screen reader on, every button in the left sidebar announces its
name, and the one for the screen I'm currently on announces that it's the current one. Nothing
looks different on screen."*

**Governor note:** low visual risk, so Designer is probably not needed — but if the fix changes any
markup structure, have Tester confirm the sidebar still looks identical.

---

### Ticket 4 — Activity colours repeat past six activities

**File:** `/Users/gregfeitel/dev/shoresh-ui/src/components/schedule/slotCellConstants.js`

**Evidence.** Verified with 22 activities: Swimming and Drama both render bronze. The cause is
plain — the palette has exactly six entries:

```js
export const ACTIVITY_COLORS = ['#3F6690','#3C8C86','#5F8A5A','#8C6F26','#B26B47','#7C5E86']
```

`activityColor()` hashes an identity into that array (DJB2, duplicated verbatim from
`buildSchedule.js` on purpose — there's a comment explaining that coupling the pure engine to a UI
constants file is the wrong direction). Consumers: `SlotCell.jsx`, `EditModal.jsx`,
`ActivityPalette.jsx`, `DisplacedPalette.jsx`, `ScheduleActivityView.jsx`.

**Read this before scoping work.** The severe half of this problem is **already fixed**:

- `1d01192` made colour a **stable hash of activity identity**, so an activity's colour no longer
  changes when the activity list is reordered. The old thrashing behaviour is gone.
- The same commit **de-colorized the grid**. The activity colour is now a small dot — a weak
  accent, not the primary carrier of meaning.
- The user **confirmed they do NOT rely on colour to read "balance of the day."** That was a
  previously-held *untested assumption* that turned out to be false.

**Therefore: "accept the collision and correct the design-system doc" is a legitimate and
possibly correct outcome for this ticket.** Do not assume the work is to expand the palette.
Expanding to 22 distinct, accessible, on-personality hues (professional/grounded/warm/quiet) would
almost certainly produce colours that read as *decorative* — which violates "colour means meaning,
not decoration," the exact principle `1d01192` established. Weigh that seriously.

The design-system doc to correct, if that is the outcome:
`/Users/gregfeitel/dev/shoresh-ui/docs/superpowers/specs/design-system.md`

**Success predicate (whichever branch you take):** *"Either two different activities never share a
colour, or the documentation now honestly says colour is a weak repeating accent that carries no
meaning — and either way, nothing on the schedule screen competes for attention with a real
problem."*

**Governor note:** this is a **decision** ticket before it is an implementation ticket. Clarify with
the user first. If the answer is "accept it," the deliverable is a doc change and this closes fast.

---

## 6. Verified product truths — do not re-litigate these

These were established by live observation, not by reading a spec. Re-opening them wastes a session.

1. **The de-colorization thesis is CONFIRMED.** Observed live at 16 groups × 22 activities: an
   injected unfillable cell was the **only saturated element on screen** and was identifiable in
   **under a second**, in both group view and day view, **with no hover**. This is the evidence base
   for "colour means meaning." Protect it.

2. **The findings rail is correct as built.** `FindingsRail` lists each finding **once**, scoped to
   group + activity, with UNFILLABLE sorted to the top. `821ed42` fixed the last known bug here
   (`computeFindings` was double-counting spanned activities by counting tails; it now counts the
   head only).

3. **Resource lanes are DEFERRED, not rejected.** A utilization view per activity/location is the
   **largest known unbuilt capability**. The engine already enforces the underlying constraints —
   `src/engine/buildSchedule.js:176` builds a `locationUsage` map keyed
   `"location|dayId|blockId"`, and `:214`–`:223` enforce `max_groups_per_slot` — but **no view
   surfaces any of it.** The user confirmed that **most activities have location and capacity set**,
   which makes this a full utilization view rather than a niche board. The user wants to **see a
   prototype before deciding** whether it becomes a fifth view or folds into the activity
   drilldown. Do not build it into the app without that prototype step.

4. **Still open from the original 2026-07-26 handoff**
   (`/Users/gregfeitel/dev/shoresh-ui/docs/superpowers/plans/2026-07-26-ui-ux-handoff.md`),
   **not yet done:**
   - Validating `ConflictsScreen` against **real conflicting data**. Blocked: needs two real
     devices. Cannot be done in the browser mock.
   - **Keyboard coverage on setup screens.** The UX principles claim "Keyboard First"; in reality
     **only `ScheduleScreen` delivers.** Ticket 2 is a small piece of this larger gap. The rest is
     unscoped.

---

## 7. Do NOT do this

- Do not run `git stash`. Ever.
- Do not push, or offer pushing as a next step. The user pushes.
- Do not read, write, or `cd` into `/Users/gregfeitel/dev/shoresh`. Shared `.git`.
- Do not touch `electron/**` or the sync layer. Different session, different scope.
- Do not "fix" the pre-existing `npm run test` failures in `electron/`.
- Do not give `--warning` a new meaning. `src/index.css:12` documents it in-line:
  `--warning: #B44E48; /* legacy alias of --danger — existing errorBanner/btnDanger reference this;
  do not give it a new meaning */`. `S.errorBanner` and `btnDanger` depend on it, and so does the
  sidebar badge.
- **Do not "clean up" `DeviceManagerScreen`'s error banner.** It deliberately keeps its own solid-red
  banner (`src/screens/DeviceManagerScreen.jsx:225`, comment: *"Deliberately NOT S.errorBanner…"*)
  instead of the shared `S.errorBanner`. The user made this call explicitly after Red Hat argued
  that a faint tint on a device-authorization screen could hide a failed revoke. This is a
  considered exception, not an inconsistency.
- Do not loosen `toSlotBool` in `src/utils/normalizeSlots.js` to work around the browser mock. Its
  strictness — including preserving `null` — is load-bearing for real data. Fix the mock's stored
  state instead (§4.2).
- Do not re-introduce decorative colour into the schedule grid.
- Do not add a router, a CSS file, or a `className`-based style.
- Do not background sub-agent dispatches in the governor loop.

---

## 8. Recommended order of work, and why

**1 — Ticket 4 (colour collisions), first.** It is a *clarify-first* ticket and may resolve to a
documentation change in a single round. Clearing it removes a standing question mark from the design
system before anyone designs on top of it. Cheapest, and it de-risks Ticket 1 (any day-view redesign
would otherwise inherit an unresolved colour question).

**2 — Ticket 3 (sidebar accessible names).** Small blast radius, no visual change, and the
diagnosis is likely to reveal a *pattern* that also explains the icon-only buttons on
`ScheduleScreen` and the palettes. Doing it early means Ticket 1's new day-view controls get built
accessibly the first time rather than being retrofitted.

**3 — Ticket 2 (Escape in the modal).** Genuinely small, but it touches `ScheduleScreen`'s keyboard
layer — the same file Ticket 1 will churn. Land it *before* Ticket 1 so you are not resolving
conflicts in a keyboard handler while also restructuring a grid. It also produces the first honest
inventory of which modals handle Escape, which feeds the broader "Keyboard First" gap.

**4 — Ticket 1 (day view at 16 groups), last.** Largest, riskiest, needs Designer, has three
already-rejected approaches, and interacts with both DnD and `rowSpan`. It deserves a full governor
loop with an unhurried context and no other tickets in flight. Doing it last also means it inherits
the accessibility and keyboard fixes rather than needing them bolted on.

**Then, separately:** the **resource-lanes prototype** (§6.3) — the highest-value *unbuilt* thing,
and explicitly gated on showing the user a prototype first. Treat it as its own governed effort, not
as a fifth ticket.

---

## 9. Honest statement of uncertainty

Things asserted here that are **verified** — worktree layout, branch, the three SHAs and their
messages, ahead-by-3, clean tree, the ADR path, `ScheduleDayView.jsx:59` sizing, `tableLayout:
fixed` + sticky columns, `EditModal.jsx` having zero Escape handling, `ScheduleScreen.jsx:114-165`
having it, the 12 sidebar items, sidebar buttons rendering visible text labels, the 6-entry
`ACTIVITY_COLORS`, `toSlotBool`'s strictness at `normalizeSlots.js:27`, the `--warning` comment at
`index.css:12`, the `DeviceManagerScreen` comment at `:225`, `locationUsage` /
`max_groups_per_slot` at `buildSchedule.js:176-223`.

Things that are **reported but not re-verified in this session** — the gate results in §2 (re-run
them), the "5 of 16 groups at 1280px" measurement, the live a11y-tree reading, the Swimming/Drama
bronze collision, and the under-a-second unfillable-detection observation. These came from live
browser sessions and are probably right; they are not free of transcription risk. Re-measure
anything you are about to make a decision on.

Things that are **guesses**, clearly marked as such — the §4.3 seed snippet's exact field and
collection names. Verify against `src/localClient.mock.js` before use.

Things **never verified at all** — whether modals other than `EditModal` handle Escape; the true
root cause of the missing accessible names (only the symptom is confirmed); whether the browser mock
faithfully reproduces Electron behaviour for anything beyond the boolean issue in §4.2; and
anything about `ConflictsScreen` under real conflicting data.
