// Chips name the KINDS of thing a card holds, so a name earns one chip however
// many rows carry it. Anchors are the case that forced this: one real import
// made 112 of them and the card showed "Indoor Elective, Indoor Elective,
// Indoor Elective, Instructional, Instructional, Instructional" — six chips
// saying three things (T135). Exported for its own test.
//
// Exact names only. campA carries both "Project" and "Projects"; those are a
// near-duplicate for a human to judge, not a match for this to quietly merge.
export function dedupeChipItems(items = []) {
  const seen = new Set()
  return items.filter((item) => {
    const name = item?.name
    if (typeof name !== 'string') return true
    if (seen.has(name)) return false
    seen.add(name)
    return true
  })
}
