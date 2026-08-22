// What the sidebar lists, and which required area each Camp Set Up row stands
// for.
//
// docs/work/specs/2026-07-31-sidebar-and-setup-readiness-handoff.md §3.
//
// The sidebar is the camp's setup pathway — product owner, 2026-08-01: "there
// are currently two pathways to setting up a camp and only one is needed —
// which should be the sidebar." Rows are ordered as setup is walked, matching
// the Next-button chain on the screens themselves and REQUIRED_AREAS in
// src/engine/readiness.js. Those three orders must agree; a director following
// Next buttons and a director reading down the sidebar are taking the same path.

export const NAV_SECTIONS = [
  {
    key: 'setup',
    title: 'Camp Set Up',
    // The header only toggles. It used to also reach the Camp Setup screen for
    // its explanations; those explanations are gone entirely (2026-08-22,
    // roots-as-hub setup IA), so there is nothing to link to.
    items: [
      // Roots — the home base for setup and the in-session landing screen
      // (S5, OF-1; superseded plan: docs/work/plans/2026-08-19-roots-
      // dashboard.md Task 3). Also the persistent inspector (docs/adr/
      // 2026-08-19-roots-census-and-persistent-inspector.md §(e)): reachable
      // any time, not just mid-import, so a director can open it months
      // later to see what Shoresh knows about their camp. Carries no mark:
      // it is where the readiness verdict is read (see the banner), not a
      // step that can be complete. The Setup Readiness hub it replaces
      // (ReadinessHub.jsx) is retired — its verdict now lives on the Roots
      // banner.
      { key: 'roots',        label: 'Roots' },
      // Sits above the setup rows because it is what a returning camp does
      // first — and below nothing, because a new camp should not have to
      // wonder whether they need it. It carries no mark: importing is not a
      // step that can be complete.
      { key: 'import',       label: 'Import last year' },
      // Programs is not listed. Every camp has exactly one, created for it, and
      // a row a director can only ever look at is a question they should not
      // have to answer — see src/engine/readiness.js.
      { key: 'tiers',        label: 'Age Divisions', area: 'tiers' },
      { key: 'groups',       label: 'Groups',        area: 'groups' },
      { key: 'days',         label: 'Days',          area: 'days' },
      { key: 'timeblocks',   label: 'Time Blocks',   area: 'timeblocks' },
      { key: 'activities',   label: 'Activities',    area: 'activities' },
      // Sits directly after Activities (design D-1, docs/work/specs/2026-08-15-m3-locations-design.md):
      // the picker that binds a location to an activity lives on the
      // Activities screen, so the two read better adjacent. Optional — its
      // own Next chain points at Fixed Events without touching Activities'
      // own required Next button.
      { key: 'locations',    label: 'Locations',     area: 'locations',    optional: true },
      { key: 'anchors',      label: 'Fixed Events',  area: 'anchors',      optional: true },
      // T108 Phase 2 (design §10 "Removed") — the standalone Day Overrides
      // CRUD screen/nav entry is retired: overrides are now authored in
      // place on the rendered day via "Override this day" mode
      // (ScheduleScreen), not a separate setup-shaped screen.
      //
      // T106 (docs/adr/2026-08-20-special-days-authoring-and-day-override-
      // repoint.md D1/D3b): NOT under `schedule`: a special day is authored
      // once and reused (tier (c) durable), a setup-shaped relationship to
      // the camp, not a "build this week" relationship — putting it under
      // `schedule` would visually imply a third route competing with
      // Manual/Generated.
      { key: 'specialdays',  label: 'Special Days',  area: 'specialdays',  optional: true },
    ],
  },
  {
    key: 'schedule',
    title: 'Schedule',
    items: [
      // Two ways to build a week, side by side. Order is alphabetical and
      // carries no meaning: neither is the camp's real schedule, and the app
      // must never pick one for the director (ADR: plural candidate schedules
      // per camp). No reordering, no recency, no usage-based promotion — in
      // NocoDB, dragging a view silently reassigns the default. Ordering
      // becomes designation.
      { key: 'schedule:generated', label: 'Generated Schedule' },
      { key: 'schedule:manual',    label: 'Manual Build' },
    ],
  },
  {
    key: 'system',
    title: 'System',
    items: [
      // Not a setup pathway — one setting, which had nowhere else to live once
      // the Camp Setup screen was retired.
      { key: 'camp',      label: 'Camp' },
      // Sync conflict resolution — LAN collisions and post-reconnection
      // upserts — not schedule conflicts. Product owner confirmed 2026-07-31.
      { key: 'conflicts', label: 'Conflicts' },
      { key: 'trash',     label: 'Trash' },
    ],
    adminItems: [
      // Product owner, 2026-08-01: "lan opens devices that pair or are
      // pairing." That is this screen, so LAN is not a second row pointing at
      // the same destination — it is what this row is for, said plainly.
      { key: 'devices', label: 'LAN & Devices' },
    ],
  },
]

// Which tables each Camp Set Up row counts. Rows not listed here show no count.
export const AREA_TABLE = {
  cohorts: 'cohorts',
  tiers: 'tiers',
  groups: 'groups',
  days: 'days_of_operation',
  timeblocks: 'time_blocks',
  activities: 'activities',
  locations: 'locations',
  anchors: 'anchor_activities',
  specialdays: 'special_days',
}
