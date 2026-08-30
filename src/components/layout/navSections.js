// What the sidebar lists — the five-stage lifecycle IA (docs/adr/2026-08-28-
// stage-aware-nav-landing.md Decision 3, docs/work/specs/2026-08-28-
// lifecycle-ia-program.md §3): Roots is a fixed, chevron-less top row; the
// former "Camp Set Up"/"Schedule" two-section model is replaced by three
// collapsible stages — Germination / Sprouts / Plants — using the same
// sectionRollup/fold mechanism the old sections used.
//
// Which required area each row stands for. Child order matches the
// Next-button chain on the screens themselves and REQUIRED_AREAS in
// src/engine/readiness.js. Those orders must agree; a director following
// Next buttons and a director reading down the sidebar is taking the same
// path.
//
// Slice C (carried forward from the roots-as-hub IA): import is one
// state-aware entry point, not two fixed rows. An empty camp sees it as the
// prominent action on SeedScreen (the initiating act, not a stage — see
// App.jsx's `seed` landing). A populated camp reaches it here, in
// ADMIN_MENU_ITEMS as "Re-import last year" — it recedes rather than
// disappearing, so it stays reachable without competing for space every
// session.

// Roots — the fixed, always-visible top row (ADR Decision 3): the in-session
// landing screen for every camp with data (S5, OF-1), and the persistent
// inspector (docs/adr/2026-08-19-roots-census-and-persistent-inspector.md
// §(e)), reachable any time. No chevron, no children, no fold state — it is
// no longer doing setup's job (docs/work/specs/2026-08-28-lifecycle-ia-
// program.md §3/§4), so it carries no mark either.
export const ROOTS_ITEM = { key: 'roots', label: 'Roots' }

export const NAV_SECTIONS = [
  {
    key: 'germination',
    title: 'Germination',
    // The irreducible structure everything grows from.
    items: [
      // Programs is not listed. Every camp has exactly one, created for
      // it, and a row a director can only ever look at is a question
      // they should not have to answer — see src/engine/readiness.js.
      { key: 'tiers',        label: 'Age Divisions', area: 'tiers' },
      { key: 'groups',       label: 'Groups',        area: 'groups' },
      { key: 'days',         label: 'Days',          area: 'days' },
      { key: 'timeblocks',   label: 'Time Blocks',   area: 'timeblocks' },
      // Sits directly after Time Blocks (design D-1, docs/work/specs/2026-
      // 08-15-m3-locations-design.md carried forward): the picker that binds
      // a location to an activity lives on the Activities screen (now in
      // Sprouts), so Locations reads as the last piece of structure before
      // the program that uses it. Optional.
      { key: 'locations',    label: 'Locations',     area: 'locations',    optional: true },
    ],
  },
  {
    key: 'sprouts',
    title: 'Sprouts',
    // The program that grows from the structure.
    items: [
      { key: 'activities',   label: 'Activities',    area: 'activities' },
      // Fixed vs Recurring un-conflation (docs/adr/2026-08-28-fixed-vs-
      // recurring-events.md, WS2) — one AnchorsScreen, two nav keys, each
      // fixed to a `kind` prop by ANCHOR_KIND_BY_SCREEN in App.jsx (same
      // pattern as SCHEDULE_ROUTE_BY_SCREEN's fixed `route` prop) — not two
      // separate screens (§7's routing question, resolved this way per WS1's
      // nav entry + WS2's data model landing together). AREA_TABLE below
      // still counts the whole anchor_activities table for both rows
      // (unfiltered by kind) — a known limitation, not a WS2 requirement.
      // buildSchedule.js places both first and locks their cells before
      // anything else can be scheduled (see src/engine/readiness.js
      // OPTIONAL_AREAS comment). No `optional` chip on either — they read as
      // expected setup, like Activities. `expected: true` (mirroring
      // readiness.js's OPTIONAL_AREAS entry) is what tells Sidebar.jsx to
      // show a "needs a look" affordance instead of either "optional" or the
      // blocking "needed" — it still does not block building a draft.
      { key: 'fixedevents',  label: 'Fixed Events',    area: 'anchors', expected: true },
      { key: 'anchors',      label: 'Recurring Events', area: 'anchors', expected: true },
      // Electives Slice 1 (docs/adr/2026-08-22-nested-schedules-electives-
      // and-events.md §2): the "schedule within a schedule" — a director
      // builds elective sets/offerings here, off the campwide grid, which
      // stays opaque ("Electives"). Optional, like Locations.
      { key: 'electives',    label: 'Electives',     area: 'electives',    optional: true },
      // Special Events unification (owner-approved 2026-08-29, docs/adr/2026-
      // 08-29-unify-special-events-screen.md) — Events and Special Days were
      // previously two display-grouped rows under a quiet "Special Events"
      // heading (override-family-model ADR §6c); the owner corrected that to
      // an actual 2→1 merge: one row, one create/manage screen
      // (SpecialEventsScreen) covering both entity kinds. Its grid still
      // builds in Plants (schedule:special), untouched — only the Sprouts
      // authoring surface merged.
      { key: 'specialevents', label: 'Special Events', area: 'specialevents', optional: true },
    ],
  },
  {
    key: 'plants',
    title: 'Plants',
    // Pinned: never collapsible (WS5 S1, docs/work/specs/2026-08-29-ws5-
    // schedule-screens.md §1a). Route legibility lives in the sidebar — the
    // active schedule row's highlight is how a director knows which of the
    // four schedules they're in, so these rows must never fold out of view.
    // Germination/Sprouts stay collapsible (the tuck-away-setup affordance);
    // only Plants carries this.
    pinned: true,
    // The tree that grows above — the schedules.
    items: [
      // Two ways to build a week, side by side. Order is alphabetical and
      // carries no meaning: neither is the camp's real schedule, and the app
      // must never pick one for the director (ADR: plural candidate schedules
      // per camp). No reordering, no recency, no usage-based promotion — in
      // NocoDB, dragging a view silently reassigns the default. Ordering
      // becomes designation.
      { key: 'schedule:generated', label: 'Generated Schedule' },
      { key: 'schedule:manual',    label: 'Manual Build' },
      // docs/work/specs/2026-08-23-schedule-build-ia.md — the picker that
      // reaches SpecialDayGridEditor/EventGridEditor from the Schedule side.
      // Fixed row, never grows with data (the list inside is data, not nav
      // structure) — so it doesn't read as a third route. No badge (resolved
      // OQ1): "things you can optionally go build" carry no urgency.
      { key: 'schedule:special',   label: 'Special Schedules' },
      // docs/work/specs/2026-08-23-electives-gap.md — a SEPARATE sibling row,
      // not folded into Special Schedules: electives are core recurring
      // structure, not an exception category (the key IA decision in that
      // spec). Fixed row, never grows with data, same reasoning as
      // schedule:special above. Labeled "Elective Schedules" — distinct from
      // Sprouts's "Electives" authoring row, parallel to how "Special
      // Schedules" is distinct from Sprouts's "Special Days"/"Events" rows —
      // two identical "Electives" labels in one sidebar was confusing and
      // broke text-lookup-based tests (Sidebar.test.jsx).
      { key: 'schedule:electives', label: 'Elective Schedules' },
    ],
  },
]

// The admin cluster, reached from the Settings gear at the bottom of the
// sidebar (Sidebar.jsx) rather than from an always-open third nav section.
// Roots-as-Hub Slice B (ADR §4), carried forward by the lifecycle-IA
// restructure: a director's day-to-day sidebar is Roots + Germination/
// Sprouts/Plants; these are still fully reachable, just not competing for
// space every session.
export const ADMIN_MENU_ITEMS = [
  // Not a setup pathway — one setting, which had nowhere else to live once
  // the Camp Setup screen was retired.
  { key: 'camp',      label: 'Camp' },
  // Slice C: import is a single state-aware entry point. Empty camps see it
  // as the prominent SeedScreen action; once a camp has data, it recedes
  // here so it stays reachable without competing for space every session.
  { key: 'import',    label: 'Re-import last year' },
  // Sync conflict resolution — LAN collisions and post-reconnection
  // upserts — not schedule conflicts. Product owner confirmed 2026-07-31.
  // Keeps its badge here (ADR §4) so nothing time-sensitive hides behind
  // the gear.
  { key: 'conflicts', label: 'Conflicts', badgeKey: 'conflicts' },
  { key: 'trash',     label: 'Trash' },
]

// Devices stays admin-only (product owner, 2026-08-01: "lan opens devices
// that pair or are pairing" — that is this screen, so it is a separate,
// role-gated list rather than a fourth entry in ADMIN_MENU_ITEMS).
export const ADMIN_ONLY_MENU_ITEMS = [
  { key: 'devices', label: 'LAN & Devices' },
]

// Which tables each row counts. Rows not listed here show no count.
export const AREA_TABLE = {
  cohorts: 'cohorts',
  tiers: 'tiers',
  groups: 'groups',
  days: 'days_of_operation',
  timeblocks: 'time_blocks',
  activities: 'activities',
  locations: 'locations',
  anchors: 'anchor_activities',
  electives: 'elective_sets',
  // No entry for 'specialevents': the merged row spans two tables
  // (special_days + events) and AREA_TABLE only supports a single table per
  // area, so the badge count is simply omitted for this row (judgment call,
  // Maker round — see PR description).
}
