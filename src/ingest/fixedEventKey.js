// A stable React key for a proposed fixed/recurring event.
//
// The key used to be `name + time_block + days`, which collided on real data:
// importing one camp file logged "Encountered two children with the same key,
// Instructional Swim 11:50-12:25 Monday,Tuesday,Wednesday,Thursday" twice.
// React's warning says colliding children may be "duplicated and/or omitted" —
// on a list of decisions a director is about to commit, that is a correctness
// risk rather than console noise.
//
// SCOPE is what those events actually differed by: the same activity, at the
// same time, on the same days, proposed separately for different groups. It
// belongs in the identity.
//
// The parts are serialised as an ARRAY rather than joined on a separator. Any
// separator has to be a character that cannot appear in a camp's own names, and
// this repo already carries a scar from a load-bearing control byte in source
// (see localDb.js's key delimiter). JSON nesting is unambiguous for free: a
// group literally named "A,B" and the pair ["A", "B"] cannot collapse into the
// same string.

export function fixedEventKey(event) {
  const scope = event?.scope
  const scopeKey = !scope
    ? 'unscoped'
    : scope.is_all_groups
      ? 'all-groups'
      : (scope.groups ?? [])

  return JSON.stringify([event?.name, event?.time_block, event?.days ?? [], scopeKey])
}
