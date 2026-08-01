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
    // its explanations; those now live on the screens they describe
    // (src/components/screenIntroText.js), so there is nothing to link to.
    items: [
      { key: 'cohorts',      label: 'Programs',      area: 'cohorts' },
      { key: 'tiers',        label: 'Units',         area: 'tiers' },
      { key: 'groups',       label: 'Groups',        area: 'groups' },
      { key: 'days',         label: 'Days',          area: 'days' },
      { key: 'timeblocks',   label: 'Time Blocks',   area: 'timeblocks' },
      { key: 'activities',   label: 'Activities',    area: 'activities' },
      { key: 'anchors',      label: 'Fixed Events',  area: 'anchors',      optional: true },
      { key: 'dayoverrides', label: 'Day Overrides', area: 'dayoverrides', optional: true },
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
  anchors: 'anchor_activities',
  dayoverrides: 'day_override_templates',
}
