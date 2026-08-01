---
title: "Sidebar mechanics across four OSS products — consolidated reference"
document_type: spec
status: active
created: 2026-07-30
governing_docs: [docs/governance/standards/DESIGN_STANDARD.md]
related_specs: [docs/work/specs/2026-07-31-sidebar-and-setup-readiness-handoff.md]
archive_when: the sidebar design questions it answers are all settled
---

# Sidebar mechanics across four OSS products — consolidated reference

Compiled 2026-07-30 from four independent source-level investigations. Every
product was read at a pinned commit; where a fact was not verified in source it
is marked. Superseded first-pass claims are listed in §6 so they don't get
re-cited.

Commits read: Twenty `079e9b8` (main), Baserow `2158049` (develop),
OpenProject `dev` July 2026, NocoDB — docs only, no source read.

---

## 1. Density and dimensions

| | Twenty | Baserow | OpenProject | NocoDB |
|---|---|---|---|---|
| Default width | 220px | 240px | 280px | unverified |
| Min / max | 180 / 350 | 52 / 300 | 11 (snaps to 0) / unverified | unverified |
| Collapsed | 40px icon rail | 52px icon rail | **0px, fully hidden** | "mini sidebar" doc exists, unread |
| Resizable | yes, drag right edge | yes, drag handle 5px | yes, 0.25rem handle | unverified |
| Width persisted | **yes** — `localStorage` `navigationDrawerWidth` | **no** — `ref(240)` resets each mount | **yes** — `localStorage` `openProject-mainMenuWidth` | unverified |
| Item height | 28px (32 mobile) | 32px | 36px | unverified |
| Font size | 13px | unverified | 14px | unverified |
| Section header | 11px / 600 / **sentence case** | 11px / 500 | 12px / 600 | unverified |

Shoresh today: 200px, no resize, no collapse, 13px items, section headers
10px / 700 / uppercase / 0.12em tracking — the heaviest header treatment of
any of them, and the only fixed width.

## 2. Hierarchy — nobody indents three levels

- **Twenty** — 2 levels, hard-capped in the type
  (`NavigationDrawerItemIndentationLevel = 1 | 2`). Nesting drawn as a 1px
  vertical bar + rounded elbow (8×14px, `border-bottom-left-radius: 4px`),
  effective indent ≈24.5px. A five-state machine
  (`getNavigationSubItemLeftAdornment`) darkens the guide **only along the path
  from folder to selected child**.
- **Baserow** — 2 levels. `.tree__sub { margin-left: 21px }` plus a vertical
  rule via `::before`/`::after` (no elbow). **No chevrons at all** — children
  render only when the parent is the selected application
  (`v-if="isAppSelected(application)"`). Auto-expand-on-select, no expand state
  to manage or persist.
- **OpenProject** — unbounded depth handled by **sliding drill-down**: a
  `descend` button replaces the visible level, a back header (`arrow-left`)
  ascends. Exactly one level on screen. No indent guides.
- **NocoDB** — the shipped sidebar is **single-base**, not a workspace tree
  (`TreeView/index.vue`, the all-bases draggable tree, is dead code referenced
  by nothing). Base sits in the header; Table (`pl-2`) → View (`pl-7.5`) = **two
  indented levels** normally, but Source → Table (`pl-8`) → View (`pl-14`) =
  **three** when more than one external source is enabled. **No depth prop, no
  computed indent, no guides** — four padding combinations hardcoded by hand
  (`pl-7.5`/`pl-14`/`pl-13.5`/`pl-20.5`), with empty states repeating the
  numbers again (`ml-9`/`pl-14.5`/`pl-21.5`). Also added a **paid folder layer**
  ("View Sections") because flat view lists broke down at scale.
  Chevron trick worth stealing: on desktop the disclosure chevron is an absolute
  overlay that **replaces the item's icon on hover** (`icon: group-hover:opacity-0`,
  `chevron: opacity-0 group-hover:opacity-100`) — no extra horizontal space.

**Implication for Programs → Units → Groups (3 levels):** outside what any of
them attempt with indentation. Three viable shapes, cheapest first:
1. auto-expand-on-select (Baserow) — no expand state, cannot ever show a
   40-group wall
2. drill-down with back header (OpenProject, Twenty's `NavigationDrawerBackButton`)
3. indentation with guides (Twenty, Baserow) — but capped at 2 levels in both

## 3. Active / hover state — a real divergence

| | Active treatment | Weight change? |
|---|---|---|
| Twenty | faint wash (`background.transparent.light`), colour → primary | **no** — always 500 |
| Baserow | 4% translucent wash, colour → `#202128` | **no** — always 500 |
| OpenProject | **`border-left: 5px solid`** + wash + bold on parents | yes, on parents |
| NocoDB | unverified | unverified |

Twenty and Baserow both use hover and active backgrounds that are *identical*,
differentiating active only by persistent text colour. Twenty reserves outline
(`1px solid blue`) for a third state: selected-in-edit-mode.

Shoresh today uses a 3px left border **and** weight 400→600 — both mechanisms
at once. Defensible, but the heaviest of the three approaches and worth an
explicit decision.

## 4. Counts, badges, and state

- **Twenty** — **no counts in the sidebar at all.** Instead a *secondary label*:
  `label · secondaryLabel` at lighter colour, regular weight. Its only badge is
  a `Pill` for `'soon'`/`'new'` modifiers.
- **OpenProject** — two mechanisms (registry `badge:`, and `Primer::Beta::Counter`
  from `MenuItem#count`). Notification counts **return `nil` at zero so the badge
  disappears** rather than rendering `0`.
- **Baserow** — `BadgeCounter` with `:limit="10"`; plain text count for Members;
  an 8×8 dot for unread-elsewhere. Renders **in-flight jobs as pseudo-items**
  with live `progress_percentage`, and undo/redo in the footer carry spinners.
- **Empty sections remove themselves**: Twenty's Favorites is
  `if (topLevelItems.length === 0) return null`.

## 5. Behaviour

**Search.** All three verified products separate a command surface from the
sidebar. Baserow's sidebar "search box" is a **fake input** — a clickable div
with a `⌘K` hint that opens a modal; it searches applications, tables, fields
**and row content**, workspace-scoped, 3-char min, 400ms debounce. Twenty's ⌘K
is **not a modal** but a page stack in a right side panel (`/` → record search,
`@` → AI, `⇧F` → favourite). OpenProject has sidebar-local filtering of its
views submenu, separate from global search (`s`).

**Favorites.** Twenty: yes, server-backed `navigationMenuItem` records, drag-
sortable, folder-capable. OpenProject: star moves a list to the top of its
section, and **static lists deliberately cannot be favourited**. **Baserow: does
not exist** — a grep across `web-frontend`, `core`, `premium` and `enterprise`
found no star icon, store, or endpoint.

**OpenProject's four-section grouping** (`app/menus/submenu.rb`), the most
directly borrowable structure found: `Starred` / `Default` / `Public` /
`Private`, alphabetical within each section, static entries non-favouritable and
non-reorderable. Saving and surfacing are **decoupled** — public/private is
access control, starred is sidebar presence.

**Reordering.** Twenty: fractional `position`, drag via dnd-kit, cross-section
drags blocked, and edits accumulate in a **draft state**
(`navigationMenuItemsDraftState`) flushed by an explicit save — not one write per
drag. Baserow: reorder only, no reparenting, `POST .../order/` with an id array.
OpenProject: no reorder affordance found; strictly alphabetical.

**Keyboard.** **None of the four has a shortcut for collapsing the sidebar** —
verified *absent* in Twenty by code search, not merely unfound. Arrow-key
traversal of sidebar items: absent in Baserow, unverified in Twenty.
OpenProject has a documented `g`-prefixed shortcut set plus access keys.

**Settings/admin takes over the sidebar** in all three verified products, with a
back button, rather than sitting as a leaf in the main tree.

**Three-zone layout** — pinned top / scrolling middle / pinned bottom
(`margin-top: auto`) — present in all three verified products. Shoresh already
has this.

## 6. Superseded first-pass claims — do not re-cite

- "Twenty draws no connecting lines or indentation guides; level 2 gets a
  breadcrumb instead." **Wrong.** `NavigationDrawerItemBreadcrumb` is a drawn
  graphical connector (vertical bar + rounded elbow), not text.
- "Baserow has an in-sidebar filter input." **Wrong** — it's a fake input
  opening a ⌘K modal.
- "Left-border active state was not verified in any of the four." **Superseded**
  — OpenProject uses `border-left: 5px solid`.
- "Twenty's section header casing is unknown (lives in `Label`)."
  **Resolved** — 11px, weight 600, sentence case, no letter-spacing.
- "Baserow's width persistence not verified." **Resolved** — it is not
  persisted.
- OpenProject was initially reported as essentially unverifiable (DNS failure).
  **Superseded** — later read from `dev` source with file-level citations; it is
  now the best-documented of the four for menu structure.

## 6a. The ordering footgun — direct evidence for our ADR

**In NocoDB, reordering views can change which view is the default.** A
same-list drag persists `updateView(id, { order }, { is_default_view: … })`,
recomputing the default through `getFirstNonPersonalView(...)`. Cross-section
drags also write `fk_view_section_id`.

This is exactly the failure Governor predicted when pruning drag-reorder and
recency-sorting from the Manual/Generated pair: **ordering silently becomes
designation.** A shipping product does it by accident. Strongest available
argument for keeping the two candidate schedules unreorderable and never
recency-sorted — see
`docs/adr/2026-07-28-plural-candidate-schedules-per-camp.md`.

## 6b. Peek-on-hover (NocoDB) — makes collapse cheap

`View.vue handleMouseMove`: when the cursor comes within **4px** of the sidebar
edge (`e.clientX < 4 + normalizedMiniSidebarWidth`) a temporary overlay sidebar
opens; it closes once the cursor is **10px** past the sidebar's width. Peeked
state is `h-4/5 pb-2 rounded-r-lg border-1 shadow-lg`, `width: calc(100% + 4px)`,
`z-501`. Animation 250ms through an eight-state machine
(`openStart → … → peekCloseEnd`).

## 7. Still unverified

- **NocoDB's entire visual layer** — width, density, active state, icon set,
  badges. Only docs summaries were obtained; no component source read.
- Whether NocoDB's table/view icons are emoji-picker-driven.
- Arrow-key traversal in Twenty (no handler found; absence not proven).
- Sync-status or onboarding-progress indicators mounted in any drawer.
- Dark-theme token values anywhere.
