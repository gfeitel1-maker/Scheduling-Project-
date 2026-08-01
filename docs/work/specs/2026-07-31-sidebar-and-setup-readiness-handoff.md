---
title: "Sidebar sections, setup readiness, and the tuck-away offer — handoff spec"
document_type: spec
status: active
created: 2026-07-31
audience: a fresh agent session with zero memory of this work ("features 2")
governing_docs: [docs/governance/standards/DESIGN_STANDARD.md]
related_adrs: [docs/adr/2026-07-28-plural-candidate-schedules-per-camp.md]
# The two documents this supersedes live on the unmerged
# docs/ux-specs-from-oss-research branch, so they cannot be listed as paths
# here without dangling. See §10 and §16.
supersedes: []
archive_when: phase 1 and phase 2 are merged and Verifier PASS recorded
implementation_state: implemented
---

# Sidebar sections, setup readiness, and the tuck-away offer

**Read this whole file before writing code.** Every path, line number and branch
below was verified against live code on 2026-07-31. If something here
contradicts the code you are looking at, **the code wins** — fix this document
when that happens.

This consolidates four prototypes and two review specs into one buildable
design. It replaces the sidebar sections of two earlier specs; see §10.

---

## 1. Where everything is

### Branches

| Branch | Contains | State |
|---|---|---|
| `main` | the app | `4890cb3`. **Trash/record-history has merged** — `Sidebar.jsx:37` already has a `trash` nav item. |
| `work/flag-system-review` | this spec, both review specs, all prototypes | unmerged |
| `docs/ux-specs-from-oss-research` | earlier sidebar specs, OSS reference, ownership note | unmerged |

Work in a worktree under `.claude/worktrees/` (gitignored). **Several other
sessions are active in this repo** — `git worktree list` showed six at time of
writing. Never run git operations in another worktree's checkout, never
`git add -A` in a shared one, and never bare `git stash` (the stash stack is
shared). See `docs/superpowers/handoffs/2026-07-30-stream-ownership.md` on the
`docs/ux-specs-from-oss-research` branch.

### Documents you need

On `work/flag-system-review`:
- `docs/work/specs/2026-07-31-camp-setup-flow-recommendations.md` — **read this
  first.** The correctness analysis behind §4 of this spec.
- `docs/work/specs/2026-07-31-flag-system-review-recommendations.md` — separate
  concern (schedule flags), but §7 lists bugs worth fixing while you are in
  these files.
- `docs/work/specs/prototypes/` — the four prototypes, §14.

On `docs/ux-specs-from-oss-research`:
- `docs/work/specs/2026-07-30-sidebar-oss-reference.md` — source-verified sidebar
  mechanics from NocoDB, Baserow, OpenProject and Twenty. Consult when a
  question here is under-specified; it records what four shipping products
  actually do.

### The starting point on `main`

`src/components/layout/Sidebar.jsx`, 221 lines + the trash addition. Fixed
200px, no collapse, no resize, no icons, no per-item state. Two hardcoded
sections in `NAV_SECTIONS`:

- **Setup** (9): Camp Setup, Programs, Units, Groups, Days, Time Blocks,
  Activities, Fixed Events, Day Overrides
- **Operations** (4 + admin): Generated Schedule, Manual Schedule, Conflicts,
  Trash, + Device Manager

Active state is `--primary` + weight 600 + a 3px left border. An optional
numeric badge per item exists (`badges` prop) and is currently supplied only for
`conflicts` (`src/App.jsx:94`). Navigation is a plain string in `useState` in
`AppShell` (`src/App.jsx:60`), looked up in `SCREENS`. **No router, no URL, no
history.**

---

## 2. What you are building, in one paragraph

The sidebar becomes three named, collapsible sections — **Camp Set Up**,
**Schedule**, **System**. Every Camp Set Up row carries a checkmark and a count,
using the tick vocabulary directors already understand from the Camp Setup
screen. The marks are derived from **one shared readiness function that the
schedule screen also uses**, so the two can never disagree again. Section
headers roll up their contents' state so collapsing never hides a problem. When
setup becomes complete, the sidebar **asks once** whether to tuck the section
away, and remembers the answer either way.

---

## 3. Section structure

```
CAMP SET UP                    ! 4 / 6
  ✓  Programs                       1
  ✓  Units                          4
  ✓  Groups                        14
  !  Days                      needed
  ✓  Time Blocks                    6
  !  Activities                needed
  ·  Fixed Events            optional
  ·  Day Overrides           optional

SCHEDULE                            2
  ·  Generated Schedule
  ·  Manual Build

SYSTEM                            [2]
  ✓  LAN                         host
  ·  Conflicts                    [2]
  ·  Trash
  ·  Devices
```

**Changes from `main`'s `NAV_SECTIONS`:**

- `Setup` → **Camp Set Up**, and the `{ key: 'setup', label: 'Camp Setup' }`
  *item* is removed. The **section header** navigates to that screen instead
  (§3.1).
- `Operations` splits. Schedule-building goes to **Schedule**; everything else
  to **System**.
- `Manual Schedule` → **Manual Build**. `Generated Schedule` unchanged. See §11
  for why this is safe.
- `Device Manager` → **Devices** (still admin-only).
- **LAN** is a new row in System. Whether it opens a new screen or the existing
  device/pairing surface is an open question — §13.

**Conflicts stays in System, deliberately.** It is sync conflict resolution —
LAN collisions and post-reconnection upserts — not schedule conflicts. Product
owner confirmed 2026-07-31.

### 3.1 The Camp Set Up header is also a link

Clicking the header **toggles** the section. A separate affordance — the header
label itself, or a small chevron-free hit area — must still reach
`CampSetup.jsx`, because that screen holds the plain-language `desc` strings
explaining what a "unit" or "fixed event" *is* (`CampSetup.jsx:13, 20, 27, 34,
41`). A 216px sidebar cannot hold two explanatory lines per item, and a
first-run director needs them.

**If you cannot make toggle-and-navigate coexist cleanly on one row, toggling
wins** and Camp Setup returns as a first item. Do not drop the descriptions.

---

## 4. The required set — get this right or the whole design lies

The Camp Set Up marks are only worth having if they are correct. **They are not
correct today.** `CampSetup.jsx` tracks five things; the schedule screen checks
four different ones; the sidebar lists nine; two more surfaces imply two more
sets. Full analysis in `2026-07-31-camp-setup-flow-recommendations.md`.

Derived mechanically from `src/engine/buildSchedule.js`:

| Area | Table | Gate? | Evidence |
|---|---|---|---|
| Groups | `groups` | **required** | `:147` outer loop |
| Days | `days_of_operation` | **required** | `:148` middle loop |
| Time Blocks | `time_blocks` | **required** | `:149` inner loop |
| Activities | `activities` | **required** | `:165`, `:336-339` — builds without, every cell `UNFILLABLE` |
| Units | `tiers` | **required** | *table never read* (`:70`, `tiers: _tiers`) but eligibility reads `group.tier_id` (`:94`, `:110`, `:220`) |
| Programs | `cohorts` | **required** | not read by engine; three setup screens gate data entry on `activeCohort` |
| Fixed Events | `anchor_activities` | **optional** | `:106`, defaults `[]` |
| Day Overrides | `day_override_templates` | **optional** | absent from the engine |

**Six gate. Two do not.** Units and Programs are in the six because without them
the schedule builds and is useless — not because the engine dereferences their
tables.

### 4.1 One function, three consumers

Create `src/engine/readiness.js`:

```js
// Returns [] when the camp can build a week.
export function getSetupGaps({ cohorts, tiers, groups, days, timeBlocks, activities })
// -> [{ key, screen, label, message }]
```

Consumed by:
1. **`Sidebar.jsx`** — drives the `!` marks and the header roll-up.
2. **`ScheduleScreen.jsx:1646`** — replaces its inline `setupIncomplete` boolean.
3. **`CampSetup.jsx`** — replaces the progress bar and the gated CTA with one
   sentence built from the same array.

**Verifiable success criterion.** A fixture with every table populated and
**zero rows in `days_of_operation`**: `getSetupGaps` returns exactly one gap
naming Days, and all three surfaces say the same thing. Second assertion:
`grep` finds no other hardcoded required-set literal in `src/`.

`message` strings live in one module and are the same strings the destination
screens show in their own empty states. `src/screens/recordLabels.js` (merged
with the trash work) already holds entity and field labels in camp language —
extend it or add a sibling; **do not create a second vocabulary**.

### 4.2 What happens to `CampSetup.jsx`

Delete: the progress bar (`:214-233`), `doneCount`/`allDone` (`:130-131`), the
`prevAllDone` sequential gating (`:240-241` — it is decorative; it only sets
`boxShadow`/`outline` and every row always navigates), the gated
**"Generate Schedule →"** CTA (`:320-338`), and the header sentence at `:168`
which is factually false.

Keep: the camp-name field, the step rows with their `desc` strings, and live
counts. Add Days as a row. Replace the bar with one line from `getSetupGaps` —
*"Two things still needed before you can build a week: Days, Time Blocks"* or
*"Ready to build a week."*

**Delete the CTA rather than rename it.** `App.jsx:39-50`'s neutral `schedule`
entry already asks which week to open; a CTA here makes the director answer
twice, and whichever button sits left reads as the default.

---

## 5. Item anatomy and the marks

```
[ mark 13px ][ gap 8px ][ label — flex ][ meta / badge ]
```

The mark column is **fixed width whether or not a mark is present**, so labels
stay aligned as ticks appear. Rows without a mark render a spacer, not a
collapsed column.

| Mark | Meaning | Colour | Applies to |
|---|---|---|---|
| `✓` | has data | `--success`, weight 700 | any row |
| `!` | blocks building a week | `--danger`, weight 700 | **only the six in §4** |
| `·` | nothing yet / not applicable | `--text-secondary`, opacity .5 | any row |

**Only the six can ever show `!`.** Fixed Events and Day Overrides render `·`
with the meta word `optional` and **never turn red** — a camp with no day
overrides is not unfinished, and marking it so trains directors to ignore red.

Meta column: `--font-mono`, 10px, `--text-secondary`. A count (`14`), a state
word (`needed`, `optional`, `host`), or nothing.

**Colour is never the only carrier.** `!` is a distinct glyph and carries the
word `needed`; `✓` carries a count. This is required by
`docs/work/specs/2026-07-28-schedule-grid-decolorization-design.md`'s intent —
do not undo it.

---

## 6. Collapse

Every section header is a `<button>` carrying `aria-expanded`. The **whole
header row** is the hit target, not just the chevron — 216px is an easy click,
a 12px glyph is not.

- **Chevron** `▶` at the left, 12px column, rotates 0°→90° on open, transition
  `transform var(--motion-base) var(--ease-out)`, `transition: none` under
  `prefers-reduced-motion: reduce`.
- **Always visible**, low contrast (`--text-secondary`, opacity .75). Twenty
  hides its chevron until hover; that is wrong for this audience — a director
  who does not know sections collapse will never hover to find out.
- Header hover: `background: var(--bg)`.
- Keyboard: real button, so Enter/Space work and focus is visible
  (`outline: 2px solid var(--accent)`).

### 6.1 Roll-up — the rule that makes collapsing safe

**A collapsed header must say what its contents would have said.** Without this,
collapsing is a way to lose alerts.

| Section | Collapsed header shows |
|---|---|
| Camp Set Up | `! 4 / 6` in `--danger`, or `✓ 6 / 6` in `--success` |
| Schedule | count of started weeks, or nothing |
| System | the conflicts badge, rolled up |

A director who tidied their sidebar in June must still see a sync problem in
August. Both OpenProject and Twenty do this; it is not an invention.

---

## 7. The tuck-away offer

**Setup never folds itself silently.** Product owner decision, 2026-07-31.

**Trigger:** the transition from short to complete — the render where
`getSetupGaps()` first returns `[]`. Never on load. Never while gaps remain.
Fires at most once per device.

**Presentation:** an inline panel between the Camp Set Up header and its items.
Not a modal, not a toast. `--secondary` 3px left border on
`--surface-elevated`.

> **Setup looks complete.** Tuck this away?
> [ Tuck away ] [ Keep open ]

**Both answers are final.** Both write `setupFoldOffered: true`; only the fold
state differs. "Keep open" is remembered as firmly as "Tuck away" — a director
who said no must not be asked again next week. That is the same silent
imposition in slower motion.

**The header still toggles afterwards, always.** A remembered answer sets the
starting state; it never removes the control.

**If setup breaks again on a folded sidebar, nothing moves.** The header goes to
`! 5 / 6` in place and stays folded. Re-expanding would be layout shifting under
the director, which is what the ask exists to avoid, and §6.1's roll-up already
carries the alert. *This is the rule I am least sure about — see §13.*

Entrance uses `var(--motion-settle) var(--ease-out)`; no animation under
`prefers-reduced-motion`.

---

## 8. Persistence

`localStorage`, per device, **never synced**. How one director likes their
sidebar is not camp data and must not change what a counsellor sees on another
laptop. Precedent: OpenProject and Twenty both persist sidebar state in
`localStorage`.

| Key | Type | Default |
|---|---|---|
| `shoresh-sidebar-section-open` | `{ setup: bool, schedule: bool, system: bool }` | all `true` |
| `shoresh-sidebar-fold-offered` | `bool` | `false` |

Unknown or malformed persisted state is discarded and defaults applied — never
thrown on. A section key that no longer exists is ignored.

**Nothing here goes in the op log.** No schema change, no migration, no
`PROJECTIONS` entry, nothing on the LAN.

---

## 9. What goes in `src/styles/shared.js`

All styling is **inline React style objects**. No CSS files, modules, Tailwind,
or styled-components.

Add to `S`: `sidebarSectionHeader`, `sidebarChevron`, `sidebarItem`,
`sidebarMark`, `sidebarMeta`, `sidebarRollup`, `sidebarOffer`,
`sidebarOfferButton`.

Existing tokens only — `--surface`, `--border`, `--primary`, `--secondary`,
`--success`, `--danger`, `--accent`, `--text`, `--text-secondary`, `--bg`,
`--font-condensed`, `--font-mono`, and the motion tokens at
`src/index.css:25-28`. **No new tokens and no new palette.** If you believe you
need one, name it and justify it in a follow-up rather than adding it quietly.

Extract the derived logic into pure, testable modules:
`src/components/layout/sidebarState.js` (roll-up state, offer trigger).

---

## 10. What this supersedes

| Document | Status |
|---|---|
| `2026-07-30-sidebar-navigation-design.md` §D1–D6 | **superseded.** Its required set of six was derived editorially and includes the wrong things; its two-section structure and its Groups-out-of-the-sidebar decision (D1) are replaced by §3 here. |
| `2026-07-29-sidebar-visual-hierarchy-design.md` | **superseded for visual decisions.** Its three-level indented tree, its lock-glyph dimming, and its blanket-icon proposal are all dropped. |
| `2026-07-29-structure-tree-design.md` | **unaffected**, but note §3 here puts Programs/Units/Groups back in the sidebar as flat rows. Reconcile before building that trial. |
| `2026-07-31-camp-setup-flow-recommendations.md` | **still governs.** §4 here is its R1. |

Mark the two superseded documents when this lands, rather than leaving three
sidebar specs disagreeing — that is the exact failure the setup review
documented.

**Not done, and it cannot be done from here (2026-08-01).** Both live on the
unmerged `docs/ux-specs-from-oss-research` branch, owned by another session.
Marking them means editing that branch's files, which this work must not do —
see the stream-ownership note referenced in §1. The `supersedes` frontmatter is
therefore empty rather than pointing at paths that do not exist on `main`.
**Whoever merges that branch must mark them then**, or three sidebar specs will
disagree on `main` for the first time.

---

## 11. Constraint checks

**Neither schedule is canonical**
(`docs/adr/2026-07-28-plural-candidate-schedules-per-camp.md` + its 2026-07-29
addendum, which makes route selection live in this sidebar):

- Generated Schedule and Manual Build share a section, mark vocabulary, row
  height, indent and type size. Alphabetical order, an artifact of the alphabet
  — the existing comment at `Sidebar.jsx:27-30` says so and must survive.
- **No reordering, no recency ordering, no usage-based promotion, ever.**
  NocoDB demonstrates the failure live: a view drag persists
  `is_default_view` and silently reassigns the default. Ordering *becomes*
  designation.
- **The Schedule section is exempt from the fold offer.** Only Camp Set Up is
  offered. Schedule never recedes.
- "Manual Schedule" → "Manual Build" is a symmetric rename against "Generated
  Schedule"; if it reads as subordinate in situ, revert to "Manual Schedule".

**No router.** Everything here is `onNavigate(screenKey)` plus local state. If
any part seems to need a URL, back button, or deep link, stop and flag it.

**Camp language.** Programs, Units, Groups, Days, Time Blocks, Activities, Fixed
Events. Never `tiers`, `cohorts`, `anchor_activities`, or a bare uuid — see
`recordLabels.js` and CONSTITUTION Art. V.

**Scale.** A camp runs **1 to 100 groups**. Sidebar rows are per *area*, not per
group, so the row count is fixed — verify this stays true.

---

## 12. Testing

Test-first at these seams. Pure modules so they need no React:

**`readiness.js`**
- every table populated, zero days → exactly one gap naming Days
- zero cohorts → a gap, even though the engine never reads `cohorts`
- zero anchors → **no** gap
- zero day overrides → **no** gap
- all six present → `[]`
- the same gap array drives `Sidebar`, `ScheduleScreen` and `CampSetup` — assert
  all three from one fixture

**`sidebarState.js`**
- roll-up shows `! n / 6` when gaps exist, `✓ 6 / 6` when none
- the conflicts badge rolls up to the System header when collapsed
- a collapsed section with no badge and no gaps rolls up to nothing, never `0`
- offer triggers on the gaps→no-gaps transition only, never on first load
- offer does not re-trigger once `setupFoldOffered` is true, on either answer
- breaking setup on a folded section updates the roll-up and does **not** expand
- malformed persisted state falls back to defaults without throwing

**`Sidebar.jsx`**
- Generated Schedule and Manual Build render with identical style props
- no code path reorders the Schedule section
- optional rows never render the `!` mark
- 100 groups does not change the sidebar's row count

---

## 13. Open questions — decide, do not guess

1. **What does the LAN row open?** A new screen, or the existing device/pairing
   surface? It is new in this design and unspecified.
2. **Does "nothing moves when setup breaks while folded" read as safe or as too
   quiet?** §7's least certain rule. Watch a director break setup on a folded
   sidebar.
3. **Can the Camp Set Up header both toggle and navigate cleanly?** §3.1. If
   not, toggling wins and Camp Setup returns as an item.
4. **Is `count > 0` honest for Days and Time Blocks?** It is a *presence* test,
   not a *sufficiency* test. A camp with one day and one block passes. Deliberately
   not solved here — see R4 in the setup review. Do not invent a stronger
   predicate without a ticket.
5. **Should a keyboard shortcut toggle the sidebar?** None of the four
   researched products has one — verified *absent* in Twenty by code search.

---

## 14. Prototypes

All on `work/flag-system-review`, under `docs/work/specs/prototypes/`. Static,
self-contained, open in a browser. They use Shoresh's real tokens.

| File | Shows |
|---|---|
| `2026-07-31-sidebar-sections-checkmarks.html` | §3, §5 — three sections, marks, June and August states |
| `2026-07-31-sidebar-collapsible-sections.html` | §6 — interactive collapse, roll-up rule |
| `2026-07-31-sidebar-autocollapse-offer.html` | §7 — the offer, driveable, with a memory readout |
| `2026-07-31-camp-setup-r1-prototype.html` | §4 — the gate defect walked as a loop, and R1 |

Prototypes are illustrative. Where they and this document disagree, **this
document governs** — the prototypes were built in sequence and the earlier ones
predate later decisions.

---

## 16. Implementation record — 2026-08-01

Both phases built. Deviations from this document, each with its reason:

**§13.1, the LAN row — resolved, and merged rather than added.** Product owner: *"lan opens
devices that pair or are pairing."* That is the existing device screen, so a separate LAN row
would have been a second row pointing at one destination. The admin row is now **LAN & Devices**.
The `host` / `client` meta in §3's sketch is **not** built: no LAN mode is exposed to the
renderer at all, so it would need a new IPC surface. Worth a ticket, not worth smuggling into
a sidebar change.

**§3.1, toggle and navigate — both, via a separate hit area.** Product owner, 2026-08-01,
described the intent as *"click a tab on the side bar and it pops up, as well as a next button
on the bottom of those screens to move to the next and a check mark being present when
completed."* So: the header row toggles, and a small `?` at its right edge reaches Camp Setup,
which still holds the plain-language `desc` strings. The fallback in §3.1 (toggling wins, Camp
Setup returns as an item) was not needed.

**The Next-button chain was broken, and that is the same bug as §4.** Nothing in the app
navigated **to** Days: `GroupsScreen` jumped straight to Time Blocks, so the only way to reach
Days was to already know it existed. Programs had no Next button, so the chain had no start.
The chain now runs Programs → Units → Groups → Days → Time Blocks → Activities → Fixed Events,
matching `REQUIRED_AREAS` order and the sidebar's row order. **Those three orders must stay in
agreement** — a director following Next buttons and a director reading down the sidebar are
walking the same path.

**§4.1's third consumer.** `getSetupGaps` is read by `Sidebar` and `ScheduleScreen` and
`CampSetup`. Verified rendered, not only tested: with Units, Groups, Time Blocks and Activities
empty, the sidebar shows four `!` marks and Camp Setup says *"4 things still needed before you
can build a week: Units, Groups, Time Blocks and Activities."* One call, one answer.

**Adding Programs to the required set is stricter than before**, so both real databases were
checked rather than assumed: `shoresh-dev` and the installed `shoresh` each hold a cohort, and
the setup screens already gate group entry on one. No camp is stranded.

Still open from §13: the LAN status meta (above), whether "nothing moves when setup breaks while
folded" reads as safe (§13.2 — unchanged, still the least certain rule), the sufficiency-vs-
presence question (§13.4, deliberately not solved), and the keyboard shortcut (§13.5, not built).

## 15. Suggested phasing

**Phase 1 — readiness.** `readiness.js`, wired into all three consumers.
Delete CampSetup's bar, gate, CTA and false copy. No sidebar restructure yet.
This alone fixes a reachable correctness bug and is independently shippable.

**Phase 2 — sidebar.** Three sections, marks, collapse, roll-up, the offer.
Depends on phase 1 for the marks to mean anything.

Do not start phase 2 first. Marks driven by a wrong required set would put
today's completion bug somewhere more prominent than it is now.
