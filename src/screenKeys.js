// Mirror of App.jsx's SCREENS map keys — plain data, not components, so this
// file (unlike App.jsx) can be exported from and imported into a pure test
// without the react-refresh/only-export-components lint rule objecting and
// without pulling in the whole screen component tree.
//
// T108 Phase 2 review round 2 (MED/HIGH #4) — introduced as the guard rail
// for the exact bug this round found: readiness.js's OPTIONAL_AREAS and
// rootMapNav.js's CHILD_SCREEN/DOMAIN_SCREEN each carried a 'dayoverrides'
// entry with no SCREENS entry behind it. Keep this list in sync with
// App.jsx's SCREENS object — screenDestinationsExist.test.js checks every
// readiness/rootMap `screen` value against it.
export const SCREEN_KEYS = new Set([
  'camp', 'import', 'roots', 'conflicts', 'trash',
  'cohorts', 'tiers', 'groups', 'days', 'timeblocks', 'activities',
  'locations', 'anchors', 'electives', 'specialdays',
  'schedule', 'schedule:manual', 'schedule:generated',
  'devices',
])
