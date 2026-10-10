// Which pre-filled setup steps a director has actually looked at.
//
// A new camp is created with Monday to Friday already in place, so the sidebar
// would tick Days as done before anyone had looked at it. A pre-filled step
// shows "needs a look" until the director opens it (or edits it), and only
// then is ticked.
//
// Per device, like the rest of the sidebar's state (sidebarState.js): not camp
// data, never synced. Keyed by camp so a second project on the same machine
// starts from its own state.

// Add an area here only if camp creation fills it in for the director.
export const PREFILLED_AREAS = ['days']

// Areas the app creates for every camp (cohorts) or that are the prefilled
// steps themselves say nothing about whether a camp is in use.
const NOT_EVIDENCE_OF_USE = new Set([...PREFILLED_AREAS, 'cohorts'])

const keyFor = (campId) => `shoresh-setup-reviewed:${campId}`

export function loadSetupReviewed(storage, campId) {
  try {
    const parsed = JSON.parse(storage.getItem(keyFor(campId)))
    if (parsed && typeof parsed === 'object') {
      return { decided: parsed.decided === true, areas: { ...(parsed.areas || {}) } }
    }
  } catch { /* unreadable or blocked: start empty */ }
  return { decided: false, areas: {} }
}

function save(storage, campId, state) {
  try { storage.setItem(keyFor(campId), JSON.stringify(state)) } catch { /* in-memory state still holds for the session */ }
}

export function markAreaReviewed(storage, campId, area) {
  const state = loadSetupReviewed(storage, campId)
  if (state.areas[area]) return state
  const next = { ...state, areas: { ...state.areas, [area]: true } }
  save(storage, campId, next)
  return next
}

// Decided once, the first time counts are known for this camp on this device.
// A camp that already has setup data beyond the pre-filled steps was in use
// before this mark existed, so its pre-filled steps count as reviewed — an
// upgrade must not take a tick away. A camp with nothing else yet is new, and
// stays "needs a look" no matter what it gains afterwards.
export function settleSetupReviewed(storage, campId, counts) {
  const state = loadSetupReviewed(storage, campId)
  if (state.decided) return state
  const inUse = Object.entries(counts).some(([area, n]) => !NOT_EVIDENCE_OF_USE.has(area) && n > 0)
  const areas = inUse
    ? { ...state.areas, ...Object.fromEntries(PREFILLED_AREAS.map((a) => [a, true])) }
    : state.areas
  const next = { decided: true, areas }
  save(storage, campId, next)
  return next
}
