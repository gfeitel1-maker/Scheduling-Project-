// The three mutually-exclusive occupant columns on a template_slots row —
// what CONTENT a cell holds (an activity, an elective set, or an event).
// Precedence-ordered to match MUTUALLY_EXCLUSIVE_FIELDS.template_slots[0]
// (electron/ops/projections.js) exactly: the parity guard in
// slotOccupant.test.js fails if the two ever diverge, so a fourth occupant
// kind added to the projection group is caught here before it silently
// relies on precedence-order luck.
//
// NOT the same concept as refField()/collectSpanTails() in
// useSlotMutations.js: refField deliberately excludes elective_set_id
// because electives never span (a span CHAIN is keyed on activity_id or
// event_id only, ADR 2026-08-22 §4). occupantFields/readOccupant below are
// about what a single cell is OCCUPIED by, not which field a multi-block
// chain is threaded through. Do not merge the two — see the ADR and
// useSlotMutations.js's refField comment for why.
export const SLOT_OCCUPANT_FIELDS = ['activity_id', 'elective_set_id', 'event_id']

// The full occupant triple with `field` set to `value` and every other
// occupant column explicitly null. Used for BOTH the repo.writeSlotFields
// argument and the optimistic setSlots patch, so a forward write and its
// in-memory projection can never drift into disagreeing about which
// occupant columns got cleared.
export function occupantFields(field, value) {
  if (!SLOT_OCCUPANT_FIELDS.includes(field)) {
    throw new Error(`occupantFields: '${field}' is not a slot occupant column (expected one of ${SLOT_OCCUPANT_FIELDS.join(', ')})`)
  }
  const result = {}
  for (const f of SLOT_OCCUPANT_FIELDS) result[f] = f === field ? value : null
  return result
}

// All three occupant columns null — a cell with no content at all (source
// clear, tail release).
export function emptyOccupantFields() {
  const result = {}
  for (const f of SLOT_OCCUPANT_FIELDS) result[f] = null
  return result
}

// The full occupant triple read off a row, `?? null` normalized. The undo-
// capture primitive: call this against a FRESH row before a forward write to
// know exactly what to restore, regardless of which of the three columns
// the row was actually carrying.
export function readOccupant(row) {
  const result = {}
  for (const f of SLOT_OCCUPANT_FIELDS) result[f] = row?.[f] ?? null
  return result
}

// The ownWriteKinds tag for a row/triple, matching useContentRaceFlag.js's
// contentKind() precedence exactly (event over elective over activity) —
// verified by reading that function directly, not assumed. A wrong tag here
// doesn't corrupt persisted data, but it does defeat own-write suppression,
// spuriously firing the cross-device "changed elsewhere" warning on the
// device's own write.
export function occupantWriteKind(rowOrTriple) {
  if (rowOrTriple?.event_id) return `event:${rowOrTriple.event_id}`
  if (rowOrTriple?.elective_set_id) return `elective:${rowOrTriple.elective_set_id}`
  if (rowOrTriple?.activity_id) return `activity:${rowOrTriple.activity_id}`
  return 'empty'
}
