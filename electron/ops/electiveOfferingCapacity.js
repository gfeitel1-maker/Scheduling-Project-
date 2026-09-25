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
// stated. Nothing in this codebase surfaces that to a director today, and
// T245 deliberately does not invent a finding for it — each caller keeps
// exactly the behaviour it has.
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
