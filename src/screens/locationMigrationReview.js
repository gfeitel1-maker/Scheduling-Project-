import { deriveLocationId } from '../../electron/ops/locationId.js'

// M3c — pure helpers for the first-run migration review region.
// docs/adr/2026-08-15-locations-merge-and-delete-rehome.md D3/D4/D5,
// docs/work/specs/2026-08-15-m3-locations-design.md Part 3.
// Kept out of LocationsScreen.jsx so that file stays component-only
// (react-refresh/only-export-components).

// The journal holds two near_duplicate rows per pair (one per spelling) —
// group them back into one merge decision by their (sorted) variants array.
export function groupNearDuplicateReviews(reviews) {
  const groups = new Map()
  for (const r of reviews) {
    if (r.kind !== 'near_duplicate') continue
    const variants = [...(r.detail?.variants ?? [])].sort()
    // JSON.stringify, not join(' ') — a space-joined key can collide for
    // space-containing names (["A B","C"] and ["A","B C"] both join to
    // "A B C"), which would make React's key={group.key} on NearDuplicateGate
    // treat two different merge decisions as one component instance.
    const key = JSON.stringify(variants)
    if (!groups.has(key)) groups.set(key, { key, variants, reviewIds: [] })
    groups.get(key).reviewIds.push(r.id)
  }
  return [...groups.values()]
}

function resolveVariant(name, campId, locations, activities) {
  const locationId = deriveLocationId(campId, name)
  const loc = locations.find((l) => l.id === locationId)
  if (!loc) return null
  const activityCount = activities.filter((a) => a.location_id === locationId).length
  return { name, locationId, capacity: loc.capacity, activityCount }
}

// D4 self-heal: a group whose variant locations no longer both exist was
// already resolved (merged) somewhere — on this device or a peer whose
// merge replicated in — so it is dropped here rather than re-presented.
export function activeNearDuplicateGroups(reviews, campId, locations, activities) {
  return groupNearDuplicateReviews(reviews)
    .map((group) => ({
      ...group,
      variantRows: group.variants.map((name) => resolveVariant(name, campId, locations, activities)).filter(Boolean),
    }))
    .filter((group) => group.variantRows.length >= 2)
}

// Default surviving spelling: most bound activities; ties broken by the
// higher capacity (the migration's own permissive rule).
export function defaultWinner(variantRows) {
  return variantRows.reduce((best, v) => {
    if (!best) return v
    if (v.activityCount !== best.activityCount) return v.activityCount > best.activityCount ? v : best
    return v.capacity > best.capacity ? v : best
  }, null)
}

// D-2 (owner decision): numbers-only copy, renderable from journal data
// alone — never an activity name, which could contradict a since-edited
// live activity. docs/work/specs/2026-08-15-m3-locations-design.md §3.4.
export function capacityDisagreementCopy(detail) {
  const caps = detail?.declaredCaps ?? []
  const seeded = detail?.seededCapacity
  const list = caps.length === 2 ? `${caps[0]} and ${caps[1]}` : caps.join(', ')
  return `activities here asked for different limits (${list} groups at once). Shoresh kept the most room: ${seeded}.`
}

export function wasUnlimitedCopy(detail) {
  const seeded = detail?.seededCapacity ?? 1
  return `had no limit set and is now ${seeded} group${seeded === 1 ? '' : 's'} at a time. That may change a generated week or two — take a look before you regenerate.`
}

export function variantList(names) {
  if (names.length === 1) return `“${names[0]}”`
  return names
    .map((n, i) => {
      const sep = i === 0 ? '' : i === names.length - 1 ? ' and ' : ', '
      return `${sep}“${n}”`
    })
    .join('')
}
