// The ONE resolution of an `elective_set_activities` row's capacity columns
// (`capacity_mode`, `capacity_limit`) into an effective capacity (T245, the
// ticket's "one definition of X" refactor).
//
// This existed TWICE before: in src/screens/elective/assignment/
// buildOfferings.js (feeding the engine) and inline in getElectiveRunHandler's
// over-capacity block — and the two did not agree about ('limited', NULL).
// Neither caller's behaviour changes here; what changes is that the case is
// now NAMEABLE instead of each caller re-deriving it.
//
// `unknownLimit` is ('limited', NULL): a capacity that is declared but not
// stated. T245 deliberately did not invent a finding for it here — each
// caller kept exactly the behaviour it had. T316 adds that finding at the
// generation-time caller (buildOfferings.js's findBlankCapacities, surfaced
// by AssignmentPanel, which refuses to solve while one exists rather than
// letting the row reach the engine as capacity 0). The read-time caller
// (getElectiveRunHandler, electron/main.js) is unchanged and still skips it
// silently — see that comment for why that gap is not this ticket's.
//
// Tolerates the undefined/undefined shape src/localClient.mock.js's rows can
// have (buildOfferings.js's H5 comment), defaulting to schema.sql's own
// DEFAULT of 'unlimited'.
export function resolveOfferingCapacity(setActivity) {
  const mode = setActivity?.capacity_mode ?? 'unlimited'
  if (mode === 'unlimited') return { kind: 'unlimited' }
  const limit = setActivity?.capacity_limit
  if (limit == null) return { kind: 'unknownLimit' }
  return { kind: 'limited', capacity: Math.max(0, limit) }
}

// The ONE resolution of an `elective_set_activities` row's MINIMUM columns
// (`min_mode`, `min_to_run`) — T265, schema v80. Lives beside the capacity
// resolver because it is the same kind of fact read the same way, and having one
// home is what stopped the two capacity copies from disagreeing (T245).
//
// `min_mode` is the AUTHORITY, exactly as `capacity_mode` is: under 'none' the
// value is ignored ENTIRELY, so a leftover number from a minimum a director set
// and then cleared can never come back to life.
//
// NOTHING IS COERCED HERE, and that is the whole point of the two-part shape.
// There is deliberately no `Math.max` and no `?? 0`: the schema CHECK guarantees
// a stated value is an integer >= 1, so the only values this can return are null
// (via 'none'/'unknownMinimum') or a real minimum. A minimum of 0 is
// unrepresentable rather than merely discouraged.
//
// `unknownMinimum` is ('required', NULL) — declared but not stated, the mirror of
// capacity's `unknownLimit`. It enforces NOTHING. Reading it as 0 would delete
// the constraint silently; reading it as "cannot run" would make the offering
// unrunnable forever. Both are the live blank-capacity defect, one direction
// each, which is why this case is NAMED and left to the caller.
//
// Tolerates the undefined shape src/localClient.mock.js's rows can have
// (buildOfferings.js's H5 comment), defaulting to schema.sql's own DEFAULT.
export function resolveOfferingMinimum(setActivity) {
  const mode = setActivity?.min_mode ?? 'none'
  if (mode !== 'required') return { kind: 'none' }
  const value = setActivity?.min_to_run
  if (value == null) return { kind: 'unknownMinimum' }
  return { kind: 'required', minimum: value }
}
