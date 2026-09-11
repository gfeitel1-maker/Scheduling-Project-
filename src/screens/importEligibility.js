// How an activity's eligible groups are described in the import preview.
//
// An empty selection and "all groups" (null) both write the same thing — no
// restriction (T35 Fix 3) — so they must SAY the same thing, or unticking every
// chip would silently lie about what gets committed. One formatter so the
// collapsed summary and the expanded editor cannot drift apart.
//
// It also has to stay readable. Importing one real camp file produced activity
// rows whose eligibility read:
//
//   "Groups: Mountain View, Lanterns, Wildcats, Falcons, Dolphins, Compass,
//    Tulip, Sunbeams, Oaks, Coves, Brook, Waterfall, Ridge, Blue Jay,
//    Cedar - Backcountry, Birch - Backcountry, Fox, Cub"
//
// — on every row, where what the director needed to know was "nearly all of
// them". A list stops being information somewhere around five names.
//
// Naming the exceptions is kept for the near-universal case because that IS the
// useful fact ("everyone except the preschools"). Beyond that it degrades to a
// count, which is honest about being a summary rather than pretending to be a
// list. The full set is always one click away in the chip editor.
//
// It lives in its own module rather than in ImportScreen.jsx because exporting
// a helper from a component file breaks fast refresh for the whole file
// (react-refresh/only-export-components).
const ELIGIBILITY_NAME_LIMIT = 4
const ELIGIBILITY_EXCEPTION_LIMIT = 2

export function formatEligibility(groupNames, allGroups = []) {
  if (groupNames == null || groupNames.length === 0) return 'All groups'

  const total = allGroups.length
  if (total > 0 && groupNames.length >= total) return 'All groups'

  // A short list is checked FIRST. In a two-group camp an activity on one of
  // them is "Groups: Yeladim", not "All groups except Bogrim" — naming the
  // exception only helps once the inclusions are too many to read.
  if (groupNames.length <= ELIGIBILITY_NAME_LIMIT) return `Groups: ${groupNames.join(', ')}`

  if (total > 0) {
    const included = new Set(groupNames)
    const missing = allGroups.filter((g) => !included.has(g))
    if (missing.length > 0 && missing.length <= ELIGIBILITY_EXCEPTION_LIMIT) {
      return `All groups except ${missing.join(' and ')}`
    }
  }

  return total > 0
    ? `${groupNames.length} of ${total} groups`
    : `${groupNames.length} groups`
}
