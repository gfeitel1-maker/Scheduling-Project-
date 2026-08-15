// The Setup Readiness hub's derived presentation state, kept out of the
// component so it can be tested without React (mirrors sidebarState.js's split).
//
// docs/work/onboarding-reconciliation/S5-READINESS-HUB-DESIGN.md §3, §4.

// The state → (glyph, colour, weight) grammar. The first three are lifted
// verbatim from Sidebar.jsx's MARK_COLOR; the last three extend it in the same
// spirit — a distinct glyph + a word + a colour role, colour never the sole
// carrier. `–` is the en-dash (U+2013), `⋯` the horizontal ellipsis (U+22EF).
export const STATE_VISUAL = {
  ready: { glyph: '✓', color: 'var(--success)', dim: false },
  'needs-attention': { glyph: '!', color: 'var(--accent)', dim: false },
  missing: { glyph: '!', color: 'var(--danger)', dim: false },
  optional: { glyph: '·', color: 'var(--text-secondary)', dim: true },
  'not-applicable': { glyph: '–', color: 'var(--text-secondary)', dim: true },
  'in-progress': { glyph: '⋯', color: 'var(--accent)', dim: false },
}

// The hub's three-way headline verdict, derived from the same `blocked` /
// `attention` the engine already returns — never a fourth source of truth.
// `attention` is only ever non-null once a caller passes live reconciliation
// `signals` into getReadiness — ReadinessHub.jsx does not yet, so needs-attention
// is forward-scaffolding today, not dead code.
export function verdictState({ blocked, attention }) {
  return blocked ? 'blocked' : attention ? 'needs-attention' : 'ready'
}

// The status word each state shows. `forward` categories say "not started"
// rather than "optional" — the same resting state, phrased for an area the app
// will grow into. A Ready row shows its count instead of a word.
export function statusWord(row) {
  switch (row.state) {
    case 'ready': return row.count != null ? String(row.count) : 'ready'
    case 'needs-attention': return 'review'
    case 'missing': return 'needed'
    case 'optional': return row.forward ? 'not started' : 'optional'
    case 'not-applicable': return row.naWord || 'not used'
    case 'in-progress': return 'staged'
    default: return ''
  }
}

// Turn the six-state readiness array + counts into the grouped rows the hub
// renders. Pure and React-free so it can be tested directly. Programs and
// Activity Rules are screen-level categories the ADR spine does not carry:
// Programs is always Ready (every camp auto-gets "Main"); Activity Rules is
// derived from Activities and can never be red (if Activities is empty it is
// Not-applicable — "nothing to rule yet" — not a second brick).
export function buildHubRows(readiness, counts = {}) {
  const by = Object.fromEntries(readiness.map((r) => [r.key, r]))
  const countFor = (area) => counts?.[area]

  const required = [
    row(by.tiers, 'Units', countFor('tiers'), 'two'),
    row(by.groups, 'Groups', countFor('groups'), 'two'),
    row(by.days, 'Days', countFor('days'), 'two'),
    row(by.timeblocks, 'Time Blocks', countFor('timeblocks'), 'two'),
    row(by.activities, 'Activities', countFor('activities'), 'two', { subRow: activityRulesRow(by.activities) }),
  ]

  const optional = [
    row(by.anchors, 'Fixed Events', countFor('anchors'), 'review'),
    // M3 — no longer `forward: true` (readiness.js promoted `location` into
    // OPTIONAL_AREAS): it now has a real screen and collection, so it shows
    // a count like every other optional row once places exist, "optional"
    // rather than "not started" while empty.
    row(by.location, 'Locations', countFor('locations'), 'review'),
    row(by.staffing, 'Staffing', null, 'none', { forward: true }),
  ]

  const programs = [
    { key: 'cohorts', label: 'Programs', screen: 'cohorts', state: 'ready', count: countFor('cohorts') ?? null, doors: 'review' },
  ]

  return { required, optional, programs }
}

function row(entry, label, count, doors, extra = {}) {
  return {
    key: entry.key,
    label,
    screen: entry.screen,
    state: entry.state,
    count: count ?? null,
    doors,
    ...extra,
  }
}

// The single tested source of truth for whether a row shows an action at all.
// A row that has already landed (ready) or does not apply (not-applicable)
// gets no button and no reserved space — the count/word is the terminus.
// Every other state gets exactly one "Review" affordance; doors:'none' rows
// (Staffing) never get one regardless of state.
export function rowAction(row) {
  if (row.doors === 'none') return 'none'
  if (row.state === 'ready' || row.state === 'not-applicable') return 'none'
  return 'review'
}

// Activity Rules mirrors Activities: derived, never blocking. It is now rendered
// only as a decorative sub-line under the Activities row (see buildHubRows' subRow
// wiring), so it carries no `screen`/`doors` — it is never clickable and never
// passed to rowAction. Only `label`, `state`, and `naWord` are read (via the row
// and statusWord). With no live reconciliation session there is no at-rest
// "inferred, not confirmed" signal, so it degrades to Ready when activities exist.
function activityRulesRow(activitiesEntry) {
  const activitiesPresent = activitiesEntry && activitiesEntry.state !== 'missing'
  return {
    key: 'activityrules',
    label: 'Activity Rules',
    state: activitiesPresent ? 'ready' : 'not-applicable',
    count: null,
    naWord: 'nothing to rule yet',
  }
}
