// rootMapNav — resolves a RootMap node selection to the real screen a
// director edits that data on. Pure config, no React/IO. A dangling target
// (a key here that isn't a real App.jsx SCREENS entry) is caught by
// rootMapNav.test.js, not left to fail silently at click time.

// Domain-level fallback (used when a domain node itself is clicked, or a
// child has no more specific entry below). 'Context' has no edit surface
// today — no ingested entity maps to it (domainRollup.js) — so it stays null.
export const DOMAIN_SCREEN = {
  Structure: 'groups',
  Scheduling: 'activities',
  Time: 'timeblocks',
  Facility: 'locations',
  Context: null,
}

// Child-level targets, keyed by the same child display names domainRollup.js's
// CHILD_OF/REQUIRED_GAP_CHILD_OF produce.
export const CHILD_SCREEN = {
  Units: 'cohorts',
  Groups: 'groups',
  'Age Divisions': 'tiers',
  Activities: 'activities',
  'Fixed Events': 'anchors',
  Days: 'days',
  'Time Blocks': 'timeblocks',
  Locations: 'locations',
}

// Human labels for the "Open in {label} →" button. Reuses the plain screen
// names a director already knows from the sidebar.
export const SCREEN_LABEL = {
  groups: 'Groups & Units',
  activities: 'Activities',
  timeblocks: 'Time Blocks',
  locations: 'Locations',
  cohorts: 'Units',
  tiers: 'Age Divisions',
  anchors: 'Fixed Events',
  days: 'Days',
}

// Resolves a node selection ({ domainKey, childKey? }) to a screen key, or
// null when the node has no edit surface (Context).
export function screenForNode(domainKey, childKey) {
  if (childKey && CHILD_SCREEN[childKey]) return CHILD_SCREEN[childKey]
  return DOMAIN_SCREEN[domainKey] ?? null
}
