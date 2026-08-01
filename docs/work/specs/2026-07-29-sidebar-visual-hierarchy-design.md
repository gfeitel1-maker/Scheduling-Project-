---
title: "Sidebar visual hierarchy — design spec"
document_type: spec
status: superseded
created: 2026-07-29
governing_docs: [docs/governance/standards/DESIGN_STANDARD.md]
related_files: [src/components/layout/Sidebar.jsx, src/components/layout/Shell.jsx, src/styles/shared.js]
related_specs: [docs/work/specs/2026-07-29-structure-tree-design.md]
archive_when: superseded 2026-08-01 — kept for its reasoning until the sidebar work is archived
---

## DESIGN SPEC — Sidebar Visual Hierarchy

> **SUPERSEDED for visual decisions, 2026-08-01**, by
> [`2026-07-31-sidebar-and-setup-readiness-handoff.md`](2026-07-31-sidebar-and-setup-readiness-handoff.md),
> which is implemented and shipped. Its three-level indented tree, lock-glyph
> dimming, and blanket-icon proposal were all dropped. Kept for the reasoning,
> not as instruction.

Director's framing: this is read dozens of times a day by someone who knows
camp operations, not software. The sidebar's job is to answer two questions
instantly — "where am I" and "what do I still need to set up" — without
requiring the director to read every label every time.

### Relationship to the Structure-tree spec

`docs/work/specs/2026-07-29-structure-tree-design.md` proposes a trial
**Structure** screen that visualizes Programs → Units → Groups as an org
chart, alongside (not replacing) the three flat screens, pending a retire
decision in its §6. This sidebar spec does not depend on that trial landing
or being adopted. It nests the *existing* three flat items (Programs, Units,
Groups) visually so the sidebar itself expresses the hierarchy today. If
Structure is later adopted and the flat screens retired, the three nested
sidebar rows collapse to one "Structure" row at `lvl-0` — a strict
simplification, no rework of the section/indent mechanism itself.

---

### Layout

`Sidebar.jsx` keeps its two-section shape (`Setup`, `Operations`) but changes
three structural things:

1. **Programs / Units / Groups render as one indented tree**, not three
   siblings, inside the Setup section:
   - Programs at indent level 0 (same as other Setup items).
   - Units at indent level 1, with a 1px vertical guide line at `left: 22px`
     connecting it visually to Programs above.
   - Groups at indent level 2, with its own guide line at `left: 36px`
     connecting to Units.
   - This is presentational nesting only — clicking any of the three still
     navigates to its existing flat screen (`cohorts`, `tiers`, `groups`
     keys unchanged). No new component tree, no collapse/expand of the
     nav items themselves (that complexity belongs to the Structure screen,
     not the sidebar).

2. **The Setup section becomes collapsible, and auto-collapses once
   complete.** "Complete" = every one of the 9 Setup entities has at least
   one row (a simple existence check per entity, computed once in `App.jsx`
   or `Sidebar.jsx` from data already fetched for badges — no new query
   shape). While incomplete, Setup renders expanded by default. Once
   complete, it renders as a single collapsed disclosure row reading
   `Setup ✓`, and Operations — the section used every working day — sits at
   the top of the visible list. The director can still click the disclosure
   row to re-expand Setup at any time (e.g., adding a new program mid-season).
   Collapse state is a per-device UI preference in `localStorage`
   (`shoresh-sidebar-setup-expanded`), same rationale as the Structure
   spec's own persisted expand state — never synced, never in the op log.

3. **Generated Schedule and Manual Schedule render inside one bordered
   pair-group**, not as two plain rows in the flat list. Same icon, same
   type weight, alphabetical order (unchanged), separated by a single
   hairline divider inside the shared border, with a small italic caption
   beneath the pair: "two candidate schedules — neither is final." This is
   the direct, explicit answer to the non-canonical constraint (see check
   below) — the grouping communicates "these two things are a pair of
   equals," which the current flat list does not.

Component structure inside `Sidebar.jsx` stays a single component (no new
files needed) — add a `NAV_TREE` shape only for the three Programs/Units/
Groups rows (an `indent` field per item) and a `pair` grouping flag for the
schedule rows, consumed by the existing `.map()` render loop.

### Visual Style

- Item height: 32px (7px vertical padding + ~18px line height), up from the
  current ~29px — enough room for a 15×15 icon without cramping.
- Indentation: level 0 = `paddingLeft: 16` (matches section header's 20px
  minus the 3px active-border reservation — actually keep left padding
  consistent at `16px` for level 0, `30px` for level 1, `44px` for level 2 —
  each level adds 14px, enough to read as a step without wasting width in a
  232px rail).
- Icons: 15×15, `stroke-width: 1.5`, `color: var(--text-secondary)` at rest,
  `var(--primary)` when active — never a second color channel. See Icons
  below.
- Section header: unchanged 10px / 700 / 0.12em uppercase / secondary — but
  now a clickable row with a chevron (`▾`/rotated `▸`) at its right edge,
  9px, `var(--text-secondary)`, rotating 90° on collapse
  (`transform var(--motion-fast) var(--ease-out)`).
- Item label: 13px, 400 weight default / 600 weight active — unchanged from
  current, this ratio already reads fine.
- Pair-group border: `1px solid var(--border)`, `borderRadius: 8`, margin
  `2px 16px 4px`; internal divider between the two items is a plain
  `1px solid var(--border)` (not a full-width hairline extending past the
  card — the card's rounded corners should visually contain both rows as
  one unit).
- Pair caption: 10px, `var(--text-secondary)`, `font-style: italic`, padding
  `4px 16px 2px`.
- Disabled/locked item: `opacity: 0.55`, cursor `not-allowed`, no hover
  background change. Lock glyph 11×11 at the row's right edge,
  `var(--text-secondary)`, `stroke-width: 1.8` (slightly heavier than body
  icons so the small glyph doesn't disappear).
- Sidebar width: keep 200px in production if width must stay fixed (the
  prototype uses 232px for comfortable icon+indent breathing room at
  screenshot scale) — see Implementation Notes on width.

### States

| State | Visual |
|---|---|
| Default | `color: var(--text)`, icon `var(--text-secondary)`, `border-left: 3px solid transparent` |
| Hover | `background: var(--bg)`; icon/text color unchanged. No hover on disabled items. |
| Active | `color: var(--primary)`, `font-weight: 600`, `border-left: 3px solid var(--primary)`, icon `var(--primary)`, subtle fill `color-mix(in srgb, var(--primary) 5%, transparent)` (new — current version has no active fill, only the border; the fill makes the active row scannable at a glance without leaning harder on the border alone) |
| Focus (keyboard) | `outline: 2px solid var(--primary)`, `outline-offset: -2px` — must be visible against both the default and active background |
| Disabled (setup-sequencing gate) | `opacity: 0.55`, `cursor: not-allowed`, lock glyph, native `title` tooltip with the specific prerequisite ("Add groups and time blocks first") |
| Section header collapsed | Chevron rotated -90°, section content `max-height: 0` (see Animation) |
| Section header expanded | Chevron at rest, `Setup ✓` replaced by plain `Setup` label while incomplete |

### Interactions

- Click any item → `onNavigate(item.key)`, unchanged.
- Click a **disabled** item → no navigation. This is a deliberate change
  from today (everything is currently clickable). The gate is advisory, not
  a hard block on the underlying screen — if the director navigates to
  Activities some other way (e.g., a future command palette), the screen's
  own empty state still explains what's missing. The sidebar gate exists so
  a first-time director's eye is steered correctly, not to enforce a rule
  the data layer doesn't otherwise enforce.
- Click the Setup section header (anywhere in the row, not just the
  chevron) → toggles expand/collapse, persists to `localStorage`.
- Hover a disabled item → native title tooltip only (no custom popover —
  restraint; a custom tooltip component would be new surface area for one
  small affordance).
- Footer "Diagnostics" disclosure → click toggles a `max-height` reveal of
  the project path + build label (see Footer below).

### Animation

| Moment | Trigger | Type | Duration / easing | Notes |
|---|---|---|---|---|
| Section collapse/expand | Click header | **Settle** — `max-height` 0 ↔ auto (measured), `opacity` 0 ↔ 1 on inner content | `var(--motion-settle)` (340ms) `var(--ease-out)` | This is a "large state change" per the motion vocabulary's own duration table — use the long token, not `--motion-base`. Chevron rotation runs concurrently at `var(--motion-fast)` (140ms) — the small glyph settles faster than the panel it controls, per standard practice for disclosure chevrons. |
| Chevron rotation | Same trigger | Rotate transform only, no fade | `var(--motion-fast)` (140ms) `var(--ease-out)` | |
| Hover background | Mouse enter/leave | Fade of `background` | `var(--motion-fast)` (140ms), linear/ease | Matches existing `transition: background 0.1s` — round up to the token value (140ms) for consistency. |
| Active-row fill appearing on navigation | Route change | **Fade**, opacity 0→1 on the new active fill, no lift | `var(--motion-fast)` (140ms) `var(--ease-out)` | Do not slide or lift the active indicator — it's a state label, not new content. |
| Diagnostics disclosure | Click | `max-height` 0→auto | `var(--motion-settle)` (340ms) `var(--ease-out)` | Same treatment as the Setup section — one disclosure pattern reused everywhere it appears, which is itself a hierarchy cue: "this expand/collapse behavior always means the same thing." |

**What must not move:** the pair-group border for the two schedules never
animates open/closed, resizes, or reorders — it is a static visual grouping,
never a collapsible tree, so nothing about its rendering can imply either
schedule is more "expanded" or more current than the other.

Every animation above ships a `prefers-reduced-motion` fallback via the
existing `prefersReducedMotion()` helper in `src/styles/shared.js`: when
true, collapse/expand snaps instantly (no `max-height` transition, no
chevron rotation transition), hover/active fades render at 0ms.

### Icons

Introduce icons — the current sidebar has none, and 12–13 flat text rows is
exactly the density problem named in the brief. No icon library is in this
codebase today (`grep` confirms no lucide/heroicons dependency), so icons
ship as inline outline SVGs matching the Design Standard's own icon rule
("outline, simple, consistent, never cartoon, `stroke-width` ~1.5"),
authored once as small React components (e.g.,
`src/components/layout/icons/index.jsx` exporting `IconGear`, `IconLayers`,
etc.) rather than pulled from an external package — consistent with this
project shipping zero UI dependencies beyond `@dnd-kit`.

Mapping (see prototype for exact paths):

| Item | Icon |
|---|---|
| Camp Setup | gear |
| Programs | 2×2 grid of squares (org-level grouping) |
| Units | single bordered square with cross-divider (a "unit" of the grid) |
| Groups | two overlapping person outlines |
| Days | calendar |
| Time Blocks | clock |
| Activities | star/flag |
| Fixed Events | map pin |
| Day Overrides | calendar with checkmark |
| Generated Schedule / Manual Schedule | **identical** calendar-grid icon for both — deliberate, see non-canonical check |
| Conflicts | alert triangle |
| Device Manager | monitor |

**Every item gets an icon.** There is no item without a natural pictogram —
if a future item genuinely has none, it gets a plain filled dot
(`var(--text-secondary)`) at the same 15×15 slot rather than leaving blank
space, so the left-edge alignment column never breaks.

### Section treatment / nesting

- Sections are disclosure rows (chevron affordance), not static labels.
- The three-level Programs/Units/Groups nesting is expressed through
  **indentation + a thin connecting guide line**, not a collapsible
  sub-tree. A collapsible tree control here would duplicate the Structure
  screen's own job (§2 of that spec already owns full tree interaction —
  expand/collapse, drag-to-reparent, inline add). The sidebar's nesting is
  read-only visual context: "these three screens are not equals, here is
  their shape" — nothing more.
- Guide lines: `1px solid var(--border)`, positioned absolutely at the
  indent boundary, spanning the height of the nested rows. This is the same
  visual device NocoDB/Baserow use for Base→Table nesting, scaled down.

### Badges, counts, and state signals

Per-item numeric badges (currently only `conflicts`) keep their existing
shape (`var(--danger)` filled pill, 16px, white mono digits) — colour alone
never carries the signal, since the badge only ever appears next to a label
that already says "Conflicts." No new badge types are introduced.

The **incomplete-setup signal** is deliberately *not* a badge. A badge on
every unfinished Setup item (9 possible badges) would recreate the density
problem the brief names. Instead:
- Section-level: the collapsed `Setup ✓` checkmark communicates "all done"
  in one glyph, appearing only when true — no separate "incomplete" badge
  variant needed, since expanded-with-no-checkmark already reads as
  "unfinished" by omission.
- Item-level sequencing: the lock glyph + dim (Disabled state above) is the
  only per-item signal, and it only fires for the one dependency case named
  in the brief (Activities needs Groups + Time Blocks). This is intentionally
  narrow — do not generalize to a full dependency graph across all 9 items;
  that is scope the brief did not ask for and would make the sidebar itself
  a rules engine.

No sync-status signal is added to the sidebar in this pass — sync state
(Host/Client, pending conflicts count) already surfaces via the `conflicts`
badge and the existing Device Manager screen; duplicating it in the footer
was considered and rejected as adding a diagnostic competing with
navigation, which is problem #5 in the brief.

### Collapse/resize behaviour

- **Sidebar itself: no resize, no full collapse to icon-rail, in this pass.**
  The brief's five problems are about internal density and hierarchy, not
  about reclaiming screen width — this is a desktop Electron app with
  "generous space" (brief's own words), and a resizable/collapsible rail
  is real scope (persisted width, min/max, icon-only mode with tooltips)
  that isn't what was asked for. If width flexibility is wanted later, it's
  a separate ticket.
- **The Setup section's collapse (above) is the one collapse behaviour this
  spec proposes**, and it persists per-device in `localStorage`, not synced.

### Footer

Current footer stacks: project path (+ DEV badge), build label, Backup
button, version — four unrelated things at fixed visual weight, which is
named directly in the brief as problem #5.

Changes:
- **DEV badge moves to the header**, next to the camp name, not the footer.
  It is a safety-critical signal per
  `docs/adr/2026-07-28-explicit-userdata-directory.md` ("if you do not see
  it, you are looking at the installed app's data") — that signal earns a
  more prominent, always-visible position than the bottom of a scrollable
  nav, and grouping it with the camp name keeps "which camp, which
  database" answerable in one glance at the top of the rail. When not a dev
  build, nothing renders in its place (no "PROD" badge) — silence is the
  normal state, exactly as today.
- **Project path and build label collapse into a "Diagnostics ▾" disclosure**,
  off by default. These are true diagnostics (useful when filing a bug, or
  for the developer/director confirming which install they're in) but not
  something a director needs visible on every glance. Same disclosure
  pattern and motion as the Setup section, for consistency.
- **Backup now stays, unchanged**, at its current position and admin-only
  gating — it's a real action, not a diagnostic, and belongs at the level
  of prominence it already has.
- **Version stays**, small, at the very bottom.

Net effect: footer goes from 4 stacked things to 2 always-visible things
(Backup button, version) plus 1 opt-in disclosure — density reduction
mirrors what happens in the nav above it.

### Accessibility

- Focus order follows DOM order: header → Setup disclosure → (if expanded)
  Setup items in list order → Operations header → Operations items → footer
  disclosure → Backup button. No `tabIndex` overrides.
- All items remain real `<button>` elements (unchanged from current
  implementation) — native keyboard activation (Enter/Space) and focus
  handling come for free.
- Disabled items: render as a real `<button disabled>` with `aria-disabled`
  and the `title` tooltip carrying the reason, so screen readers announce
  both the disabled state and why, not just a dimmed label.
- Section header disclosure: `aria-expanded` on the header button,
  `aria-controls` pointing at the section's item list `id`.
- Contrast: `var(--text-secondary)` (`#5C6670`) on `var(--surface)`
  (`#FCFBF8`) is ~4.6:1, clears AA for the 10px uppercase section labels
  and 11px footer text. `var(--primary)` (`#173B63`) active-row text on the
  5%-navy-tint background stays effectively the same as text-on-surface
  contrast (~11:1) since the tint is barely perceptible — no risk there.
  Lock glyph and disabled-item text at `opacity: 0.55` on `var(--surface)`
  drops secondary-text contrast to roughly 3:1 — **acceptable only because
  it is not the sole carrier of the disabled state** (cursor, lock icon,
  and tooltip all corroborate); if an accessibility audit flags it, raise
  to `opacity: 0.65` rather than changing the icon.
- Reduced motion: covered under Animation above — every transition has an
  instant fallback via `prefersReducedMotion()`.

### Prototype

`docs/work/specs/prototypes/2026-07-29-sidebar-visual-hierarchy-prototype.html`
— two static frames:
1. Default mid-onboarding state: Setup expanded, Units active, Programs→
   Units→Groups nested with guide lines, Activities disabled with lock +
   tooltip, the Generated/Manual pair-group with its caption, Conflicts
   badge.
2. Setup-complete state: Setup collapsed to `Setup ✓`, Operations promoted
   to the top, Device Manager visible (admin), footer Diagnostics
   disclosure, no DEV badge (represents the installed build).

Open directly in a browser — self-contained, no build step.

### Non-canonical-schedule check

- Generated and Manual Schedule use the **same icon**, same font weight
  rules (both follow the ordinary default/active/hover states — neither has
  a permanently-bolder or permanently-tinted variant), and stay in
  **alphabetical order** (Generated before Manual — an artifact of the
  alphabet, not a ranking), exactly matching the existing code comment's
  intent in `Sidebar.jsx:27-30`.
- They are visually **grouped as a pair** (shared border, shared caption)
  rather than each competing individually with the 9 Setup items and
  Conflicts for attention — but pairing is symmetric: neither item is
  "inside" or "under" the other, both sit at the same indent, same row
  height, same type size, split by one plain internal divider.
- The caption "two candidate schedules — neither is final" makes the rule
  explicit in-product, which the current sidebar does not — a first-time
  director today has no way to know from the sidebar alone that both are
  legitimate.
- No collapse, no drag-reorder, no usage-based reordering (e.g., "most
  recently viewed schedule first") is proposed for this pair — any of those
  would let one schedule's screen state quietly promote itself above the
  other, which is the exact failure mode the ADR warns about.

### Implementation Notes for Maker

- Keep `Sidebar.jsx` a single component; do not split into a new tree
  component. Add: a small `NAV_TREE` config extending the existing
  `NAV_SECTIONS` items with an `indent: 0|1|2` field for Programs/Units/
  Groups, a `pair: true` grouping flag consumed to wrap Generated/Manual
  in the bordered container, and a `disabledUntil` predicate field for
  Activities (`groups.length > 0 && timeblocks.length > 0`) evaluated from
  data already available to `Sidebar`'s parent (`App.jsx` already computes
  `sidebarBadges`; extend that prop, don't add a new fetch inside
  `Sidebar.jsx` — it currently has no query capability of its own beyond
  `getCamp`/`getCurrentProject`, keep it that way).
- **Setup-complete check is a derived boolean, not stored.** Compute it in
  `App.jsx` alongside `sidebarBadges` from counts already fetched for
  badges/dashboard purposes — do not add a new IPC round-trip solely for
  this. If no existing count is available for one of the 9 entities,
  that's a real gap to flag back to Governor before building, not something
  to fake with a placeholder `true`.
- Icons: new file(s) under `src/components/layout/icons/` as small
  functional components taking no props but `className`/inline `style`
  passthrough for color — follow the inline-style convention (no CSS
  classes for color, `stroke="currentColor"` inherited via inline
  `style={{ color: ... }}` on the wrapping element, which is how SVG
  `currentColor` composes with this codebase's inline-style-only rule).
- `localStorage` keys: `shoresh-sidebar-setup-expanded` (boolean-ish
  string) — matches the naming precedent already set by
  `shoresh-structure-expanded` in the Structure spec.
- **Width:** this spec's prototype renders at 232px for legibility of the
  new indentation levels; the current production sidebar is a hardcoded
  200px. Recommend Maker widen to `224px` (not full 232px) as the smallest
  bump that keeps 44px-indent Groups rows from feeling cramped against a
  15px icon — flagging this as a value Maker should confirm against the
  actual rendered app rather than treating 224 as gospel, since it depends
  on the real font metrics, not the prototype's.
- Values that belong in `src/styles/shared.js` as `S`: `S.sidebarItem`
  (base item style object, parameterized by `indent`/`active`/`disabled`
  the way `S.cellStructuralBar` already takes a param), `S.sidebarSectionHeader`,
  `S.sidebarPairGroup`, `S.sidebarPairCaption`, `S.sidebarDisclosure`
  (shared by both the Setup section and the footer Diagnostics row, since
  they're the same interaction pattern). Keep the per-icon SVGs and the
  `NAV_TREE`/`NAV_SECTIONS` data structures local to `Sidebar.jsx` — they
  are not shared across screens.
- **This sidebar does not introduce a router, URL, or back button.** All
  navigation remains the existing plain `useState` string in `App.jsx` via
  `onNavigate`. Nothing in this spec depends on deep links.
- The disabled-item gate is UI-only steering, not enforcement — do not let
  it become an excuse to skip validating Activities' own empty state for
  "no groups yet" on the screen itself; the sidebar gate and the screen's
  own empty-state message must tell the same story if a director reaches
  the screen by another path.
