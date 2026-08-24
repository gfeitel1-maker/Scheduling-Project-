// What the sidebar lists, and which required area each Roots child row stands
// for.
//
// docs/adr/2026-08-22-roots-as-hub-setup-ia.md, docs/work/specs/2026-08-22-
// roots-as-hub-setup-ia-slices.md "Slice B".
//
// Roots-as-Hub Slice B: the entity setup rows (Age Divisions/Groups/Days/
// Time Blocks/Activities + optional Locations/Recurring Events/Special Days) are
// no longer flat siblings of Roots — they are Roots's own collapsible
// children (Sidebar.jsx renders `item.children` nested under the Roots row,
// toggled by its own chevron, independent of the "Camp Set Up" section
// fold). Roots itself still navigates to the Roots screen on click. The two
// schedule routes stay distinct rows (ADR §3 — this is the explicit reversal
// of the abandoned W2 attempt that collapsed them). Camp/Conflicts/Trash/LAN
// & Devices move behind the Settings gear (ADMIN_MENU_ITEMS /
// ADMIN_ONLY_MENU_ITEMS, rendered by Sidebar.jsx) — reusing the W2 stash
// pattern (commit f6bfe45), minus its schedule-route collapse.
//
// The sidebar is the camp's setup pathway — product owner, 2026-08-01: "there
// are currently two pathways to setting up a camp and only one is needed —
// which should be the sidebar." Child order matches the Next-button chain on
// the screens themselves and REQUIRED_AREAS in src/engine/readiness.js. Those
// orders must agree; a director following Next buttons and a director reading
// down Roots's children is taking the same path.
//
// Slice C: import is one state-aware entry point, not two fixed rows. An
// empty camp sees it as the prominent action on the Roots banner
// (rootsBanner.jsx, brandNew ? primary). A populated camp reaches it here,
// in ADMIN_MENU_ITEMS as "Re-import last year" — it recedes rather than
// disappearing, so it stays reachable without competing for space every
// session.

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
      // step that can be complete. Its `children` are the entity setup
      // screens, nested and collapsible (Slice B) rather than flat siblings.
      {
        key: 'roots', label: 'Roots',
        children: [
          // Programs is not listed. Every camp has exactly one, created for
          // it, and a row a director can only ever look at is a question
          // they should not have to answer — see src/engine/readiness.js.
          { key: 'tiers',        label: 'Age Divisions', area: 'tiers' },
          { key: 'groups',       label: 'Groups',        area: 'groups' },
          { key: 'days',         label: 'Days',          area: 'days' },
          { key: 'timeblocks',   label: 'Time Blocks',   area: 'timeblocks' },
          { key: 'activities',   label: 'Activities',    area: 'activities' },
          // Sits directly after Activities (design D-1, docs/work/specs/2026-08-15-m3-locations-design.md):
          // the picker that binds a location to an activity lives on the
          // Activities screen, so the two read better adjacent. Optional — its
          // own Next chain points at Recurring Events without touching Activities'
          // own required Next button.
          { key: 'locations',    label: 'Locations',     area: 'locations',    optional: true },
          // Recurring Events (carpool, flagpole, lunch, all-camp) are camp-wide
          // anchors, not a nice-to-have — buildSchedule.js places them first and
          // locks their cells before anything else can be scheduled (see
          // src/engine/readiness.js OPTIONAL_AREAS comment). No `optional` chip:
          // this row reads as expected setup, like Activities. `expected: true`
          // (mirroring readiness.js's OPTIONAL_AREAS entry) is what tells
          // Sidebar.jsx to show a "needs a look" affordance instead of either
          // "optional" or the blocking "needed" — it still does not block
          // building a draft (readiness.js carries that as a Needs-attention
          // resting state, never Missing).
          { key: 'anchors',      label: 'Recurring Events', area: 'anchors', expected: true },
          // Electives Slice 1 (docs/adr/2026-08-22-nested-schedules-electives-
          // and-events.md §2): the "schedule within a schedule" — a director
          // builds elective sets/offerings here, off the campwide grid, which
          // stays opaque ("Electives"). Optional, like Locations/Recurring Events.
          { key: 'electives',    label: 'Electives',     area: 'electives',    optional: true },
          // Override-family-model ADR §6c (docs/adr/2026-08-23-override-
          // family-model.md): Events and Special Days are display-grouped
          // under one quiet, non-navigating heading — "these feel like one
          // thing" (owner's felt model). This is a display-layer grouping
          // only: no schema change, each row keeps its own `area`/optional
          // status/Next-chain identity untouched. Sidebar.jsx renders a
          // `heading` marker as a plain label, never a row.
          { key: 'special-schedule-heading', heading: 'Special Schedule' },
          // Events overlay placement Slice 1 (docs/adr/2026-08-22-events-
          // overlay-placement.md §5): an event is a named, opaque block a
          // director places directly on the campwide schedule (not its own
          // sub-schedule, unlike Electives). Optional, same posture.
          { key: 'events',       label: 'Events',        area: 'events',       optional: true },
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
      // Roots's "Electives" authoring row, parallel to how "Special
      // Schedules" is distinct from Roots's "Special Days"/"Events" rows —
      // two identical "Electives" labels in one sidebar was confusing and
      // broke text-lookup-based tests (Sidebar.test.jsx).
      { key: 'schedule:electives', label: 'Elective Schedules' },
      // Day Map (B1, read-only) — docs/adr/2026-08-24-run-the-day-on-the-map.md
      // Decision 2. Route/day/block selection is in-screen, unpersisted; this
      // row is just the nav destination, same posture as schedule:special.
      { key: 'schedule:map', label: 'Day Map' },
    ],
  },
]

// The admin cluster, reached from the Settings gear at the bottom of the
// sidebar (Sidebar.jsx) rather than from an always-open third nav section.
// Roots-as-Hub Slice B (ADR §4): a director's day-to-day sidebar is Roots +
// Schedule; these are still fully reachable, just not competing for space
// every session.
export const ADMIN_MENU_ITEMS = [
  // Not a setup pathway — one setting, which had nowhere else to live once
  // the Camp Setup screen was retired.
  { key: 'camp',      label: 'Camp' },
  // Slice C: import is a single state-aware entry point. Empty camps see it
  // as the prominent Roots banner action; once a camp has data, it recedes
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

// Which tables each Roots child row counts. Rows not listed here show no count.
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
  electives: 'elective_sets',
  events: 'events',
}
