---
title: Icon Vocabulary Decision Table
document_type: spec
status: active
authority: subordinate-to-constitution
governing_docs: [docs/governance/constitution/CONSTITUTION.md, docs/governance/standards/DESIGN_STANDARD.md]
owner: Governor (session app-icon-audit-a9a598)
created: 2026-09-11
archive_when: every row is either shipped or explicitly declined
review_trigger: a new icon is added outside src/components/icons/, or a text glyph is proposed as an icon
---

# Icon vocabulary — decision table

Status: DRAFT — awaiting owner decisions on D1–D6
Date: 2026-09-11
Scope: every icon-bearing glyph rendered in `src/`. No behavior change.

## Why

There is no icon system. Icons are invented per-file in three incompatible
forms: ~14 locally-defined inline SVG functions, Unicode glyphs as literal
JSX strings, and a handful of emoji. The same concept renders differently
depending on which screen a director is on — "warning" is `⚠` text on Login
but an SVG triangle on Import; "check" is `✓` in fourteen places but an SVG
circle-check on Roots.

The goal is one concept, one form. The goal is NOT one glyph per shape:
several marks are triangles or checks by coincidence and mean different
things. Where that is true it is recorded below as a deliberate split.

## Non-goals

- Emoji replacement (Locations kind picker, `🌤`, `⛅`, `📋`). Owner deferred;
  tracked separately.
- Any change to what a mark *means*, when it appears, or what it is colored.
  This is form only. A mark that is wrong today stays wrong and is filed.
- Introducing an icon dependency. These stay hand-authored SVG.

## The table

| # | Concept | Current renderings | Sites | Proposed canonical form |
|---|---------|-------------------|-------|------------------------|
| 1 | Check / success (confirmation) | `✓` text ×14 | 14 | `<CheckIcon/>` — 12x12 outline, `currentColor` |
| 2 | Check / success (state mark) | `✓` in sidebar fixed-width column | 3 | **UNCHANGED — see D1** |
| 3 | Check / success (celebratory) | SVG circle-check, 24px (Roots empty state) | 1 | **UNCHANGED — see D2** |
| 4 | Warning / caution | `⚠` text ×4 | 4 | `<WarningIcon/>` — triangle, matches Import's existing path |
| 5 | Warning (blocking, sidebar) | `!` in fixed-width column | 2 | **UNCHANGED — see D1** |
| 6 | Danger / cannot-undo | SVG triangle (Import) | 1 | Same `<WarningIcon/>`, `stroke="var(--danger)"` |
| 7 | Close / clear / dismiss | `×` text ×6 | 6 | `<CloseIcon/>` — 12x12 X stroke. **See D3** |
| 8 | Remove row (destructive) | red `×` in grid editors | 3 | `<CloseIcon/>` + `var(--danger)`. **See D3** |
| 9 | Disclosure (expand/collapse) | `▲`/`▼` text (Activities); SVG chevron ×2 (Import) | 3 | `<ChevronIcon/>` rotated 180° when open |
| 10 | Disclosure (sidebar fold) | `▶` rotated | 1 | `<ChevronIcon/>` |
| 11 | Dropdown affordance | `▾` (Versions, WeekSwitcher) | 2 | `<ChevronIcon/>` |
| 12 | Reorder up/down | `▲`/`▼` buttons (both grid editors) | 4 | **SPLIT — `<ArrowIcon/>`, not chevron. See D4** |
| 13 | Reorder left/right | `◀`/`▶` buttons (Event grid) | 2 | `<ArrowIcon/>` rotated |
| 14 | Review-toggle state | `↗` inactive / `▾` active (StatBadge) | 1 | `<ChevronIcon expanded={active}/>` — D5 resolved |
| 15 | Back navigation | `←` text ×10 | 10 | `<ArrowIcon/>` rotated 180° |
| 16 | Forward / next | `→` in Next buttons + ScheduleDoor | 3 | **UNCHANGED in ScheduleDoor — see D6** |
| 17 | Cell span merge/split | SVG chevron, rotated 90° for split | 1 | Already canonical — fold into `<ChevronIcon/>` |
| 18 | Unfillable flag | SVG circle-exclamation | 1 | Keep; rename to shared module |
| 19 | Outdoor | SVG sun | 1 | Keep; rename to shared module |
| 20 | Open elective | SVG arrow-out | 1 | Keep; rename to shared module |
| 21 | Pulled cell | SVG arrow-out-of-bracket | 1 | Keep; rename to shared module |
| 22 | Edit / override | SVG pencil | 1 | Keep; rename to shared module |
| 23 | Location pin | **3 different SVG paths** (LocationPicker, SpecialDayCell, EventCell) | 3 | One `<PinIcon/>` — LocationPicker's path wins (most refined) |
| 24 | Add | SVG plus ×2 (identical, duplicated) + `+` text (CapacityStepper) | 3 | One `<PlusIcon/>` |
| 25 | Search | `⌕` text (ActivityPalette) | 1 | `<SearchIcon/>` |
| 26 | Undo / redo | `↩` / `↪` text (Schedule toolbar) | 2 | `<UndoIcon/>` / mirrored |
| 27 | Lock / PIN | SVG padlock (Conflicts) | 1 | Keep; rename to shared module |
| 28 | Identity / roots | SVG root glyph (ReconstructionMoment) | 1 | Keep — identity mark, never reused |
| 29 | Info | `ⓘ` text (Login) | 1 | `<InfoIcon/>` |
| 30 | Timer / lockout | `⏱` text (Login) | 1 | `<ClockIcon/>` |
| 31 | Settings | `⚙` text (Sidebar gear) | 1 | `<GearIcon/>` |
| 32 | Mode choice | `★` new / `↻` join (ModeSelect) | 2 | `<StarIcon/>` / `<RefreshIcon/>` |
| 33 | Empty state | SVG calendar (CalmEmptyState) | 1 | Keep; rename to shared module |
| 34 | Paste pending | `⊡` (Schedule) | 1 | `<ClipboardIcon/>` |
| 35 | Indent / push | `⇥` (ScheduleGroupView) | 1 | Keep as text — no icon equivalent. **See D3** |

## Open decisions (owner)

**D1 — Do the sidebar marks (`✓` / `!` / `·`) join the icon system?**
Recommendation: **NO, leave as text.** They live in a 13px fixed-width column
at fontSize 11 / fontWeight 700, color-mapped, and the code comment states the
width is fixed so labels do not shift as ticks appear. They are a three-glyph
*state vocabulary* (done / needed / not-started), not decoration — `·` has no
icon equivalent at all, and swapping two of three to SVG breaks the set.
Confidence: high.

**D2 — Does the Roots "nothing needs you" circle-check become the standard check?**
Recommendation: **NO, keep it distinct.** It is 24px, `var(--success)`, and is
the emotional payoff of an empty attention queue. The standard check is a 12px
inline confirmation mark. Same concept, deliberately different weight.
Confidence: medium — this is a taste call and yours to make.

**D3 — Is `×` a close icon or a text character?**
This is the one with a trap. `×` is currently BOTH the close glyph on 6 buttons
AND a literal multiplication sign in 5 places: `"3 groups × 4 blocks"`,
`"2–4×/wk"`, `"Add Anchor (×3)"`. No find-and-replace is safe.
Recommendation: **convert the 6 buttons to `<CloseIcon/>` by hand; leave the 5
multiplication signs alone.** This is the highest-risk item in the program and
should be its own PR with the 5 non-sites listed in the description.
Confidence: high.

**D4 — Are reorder arrows the same concept as disclosure chevrons?**
Recommendation: **NO — split them.** Today both are `▲`/`▼`, which is exactly
the collision worth fixing: a chevron means "this reveals more", an arrow means
"this moves the thing". Making them the same glyph would make the app *less*
legible, not more.
Confidence: high.

**D5 — RESOLVED (owner, 2026-09-11): one rotating chevron.**
StatBadge rendered `↗` when inactive and `▾` when active for the same toggle —
two unrelated metaphors (external-link vs dropdown) standing in for one on/off
state, neither of which read as "reviewing / not reviewing", which is what the
`title` attribute says it means.

Both are replaced by a single `<ChevronIcon>` that rotates, matching every
other disclosure in the app. The tile does open a review list, so disclosure
is the honest metaphor.

Kept rather than dropped, even though the tile already signals state three
other ways (`aria-pressed`, a coloured border, a faint fill): the glyph's
second job is separating a clickable tile from a non-clickable one ("Placed",
and any concern whose count is zero), and that distinction would otherwise
rest on border colour alone.

Rendered inline (`display: inline-block`, `vertical-align: middle`) rather
than in a flex row, so a long label — "Spread across the week" — still wraps
normally with the chevron following the last line. Verified in the running
app: the chevron's offset from the label's optical centre is 0.75px and
identical in both states, because the polyline is centred on the viewBox's
y-axis and so maps onto itself under a 180° rotation.

**D6 — Does ScheduleDoor's `→` become an icon?**
Recommendation: **NO, leave as text.** It is an animation target — hover finds
it via `querySelector('[data-arrow]')` and translates it, gated on
`prefersReducedMotion()`. Converting it to a component risks the motion for no
legibility gain. The other two `→` (Next buttons) can convert.
Confidence: high.

## Sequencing

One PR per row group, smallest blast radius first. Each is independently
revertible.

1. **Shared module + the 10 already-SVG icons.** Pure move, no visual change.
   Establishes `src/components/icons/`. Zero risk.
2. **Dedupe the three pin paths and the two plus paths.** Visual change limited
   to SpecialDayCell / EventCell / CapacityStepper.
3. **Check / success (row 1).** 14 sites, but 7 are the same copy-pasted line
   in 7 setup screens — extract that renderer once and 7 sites collapse to 1.
4. **Warning (rows 4, 6).** 5 sites.
5. **Back / forward (rows 15, 16).** 12 sites, mechanical.
6. **Disclosure vs reorder (rows 9–13).** The messy one. Depends on D4.
7. **Close (rows 7, 8).** Last, alone, because of D3's overloading trap.

## Test coupling

Five test files assert on these glyphs directly and will need updating in the
PR that changes each: `Sidebar.test.jsx`, `ScheduleScreen.test.jsx`,
`ConflictsScreen.test.jsx`, `WeekSwitcher.test.jsx`,
`ImportScreen.fixedEventRouting.test.jsx`. Where a test asserts on a glyph as a
proxy for state, it should assert on an accessible name or `data-testid`
instead — the glyph change is the prompt to fix the assertion, not to re-couple
it to a new glyph.

## Success predicate

- Every icon in `src/` imports from `src/components/icons/`, or is one of the
  documented text-glyph exceptions (D1, D6, row 35, the 5 multiplication `×`).
- No concept in the table renders two ways.
- `npm run verify` green.
- A grep for inline `<svg` outside `src/components/icons/` returns only the
  documented exceptions.
