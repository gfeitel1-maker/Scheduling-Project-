// rootMapNav — resolves a RootMap node selection to the real screen a
// director edits that data on. Pure config, no React/IO. A dangling target
// (a key here that isn't a real App.jsx SCREENS entry) is caught by
// rootMapNav.test.js, not left to fail silently at click time.

// Domain-level fallback (used when a domain node itself is clicked, or a
// child has no more specific entry below).
export const DOMAIN_SCREEN = {
  Structure: 'groups',
  Scheduling: 'activities',
  Time: 'timeblocks',
  Facility: 'locations',
}

// Child-level targets, keyed by the same child display names domainRollup.js's
// CHILD_OF/REQUIRED_GAP_CHILD_OF produce.
export const CHILD_SCREEN = {
  Program: 'cohorts',
  Groups: 'groups',
  'Age Divisions': 'tiers',
  Activities: 'activities',
  'Recurring Events': 'anchors',
  Days: 'days',
  'Time Blocks': 'timeblocks',
  Locations: 'locations',
  // Regroup slice (owner decision 2026-08-24): Events/Special Days/Electives
  // moved from the dropped 'Context' domain to ordinary Scheduling children.
  // Each points at its own setup-entity edit screen (App.jsx's SCREENS map),
  // same pattern as Activities->'activities'/Recurring Events->'anchors' —
  // not the Schedule-side build pickers ('schedule:special',
  // 'schedule:electives'), which are a separate destination for building the
  // actual grid, not editing the entity list.
  Events: 'events',
  'Special Days': 'specialdays',
  Electives: 'electives',
}

// Human labels for the "Open in {label} →" button. Reuses the plain screen
// names a director already knows from the sidebar.
export const SCREEN_LABEL = {
  groups: 'Groups',
  activities: 'Activities',
  timeblocks: 'Time Blocks',
  locations: 'Locations',
  cohorts: 'Program',
  tiers: 'Age Divisions',
  anchors: 'Recurring Events',
  days: 'Days',
  'schedule:manual': 'Schedule',
  'schedule:generated': 'Schedule',
  'schedule:special': 'Special Schedules',
  events: 'Events',
  specialdays: 'Special Days',
  electives: 'Electives',
}

// Resolves a node selection ({ domainKey, childKey? }) to a screen key, or
// null when the node has no edit surface.
export function screenForNode(domainKey, childKey) {
  if (childKey && CHILD_SCREEN[childKey]) return CHILD_SCREEN[childKey]
  return DOMAIN_SCREEN[domainKey] ?? null
}
