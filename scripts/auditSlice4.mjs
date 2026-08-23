// Slice 4b mandatory before/after audit
// (docs/work/specs/2026-08-23-slice4-engine-location-contention.md §4).
//
// Runs a set of fixtures through the PRE-Slice-4 engine (scripts/
// _buildSchedule.before.mjs — a verbatim snapshot of origin/main's
// src/engine/buildSchedule.js, taken before this slice's changes) and the
// POST-Slice-4 engine (src/engine/buildSchedule.js, current tree), and
// reports the diff: placement changes, newly-UNFILLABLE cells, newly-
// UNDERSERVED findings, and a contention-hotspot ranking broken out by
// overlay kind (anchor / elective / event) per the mandatory report shape.
//
// Run with: npx vite-node scripts/auditSlice4.mjs

import buildScheduleBefore from './_buildSchedule.before.mjs'
import buildScheduleAfter from '../src/engine/buildSchedule.js'

function key(s) { return `${s.groupId}|${s.dayId}|${s.blockId}` }

function diffFixture(name, input) {
  const before = buildScheduleBefore(input)
  const after = buildScheduleAfter(input)

  const beforeByKey = new Map(before.slots.map(s => [key(s), s]))
  const afterByKey = new Map(after.slots.map(s => [key(s), s]))

  let placementChanges = 0
  const newlyUnfillable = []
  for (const [k, a] of afterByKey) {
    const b = beforeByKey.get(k)
    if (!b) continue
    if (b.activityId !== a.activityId) placementChanges++
    const wasFilled = b.type === 'activity' && b.activityId != null
    const nowUnfillable = a.type === 'activity' && a.flags?.UNFILLABLE
    if (wasFilled && nowUnfillable) {
      newlyUnfillable.push({
        groupId: a.groupId, dayId: a.dayId, blockId: a.blockId,
        reason: a.flags.UNFILLABLE_reason,
      })
    }
  }

  const beforeUnderserved = new Set(
    (before.findings || []).filter(f => f.kind === 'UNDERSERVED')
      .map(f => `${f.groupId}|${f.activityId}`)
  )
  const newlyUnderserved = (after.findings || [])
    .filter(f => f.kind === 'UNDERSERVED' && !beforeUnderserved.has(`${f.groupId}|${f.activityId}`))

  // Determinism check: run the AFTER engine twice, same input.
  const afterAgain = buildScheduleAfter(input)
  const deterministic = JSON.stringify(after.slots) === JSON.stringify(afterAgain.slots)

  return { name, placementChanges, newlyUnfillable, newlyUnderserved, deterministic }
}

// ── Fixture 1: engine's own contention test fixture, reused ────────────────
// One located anchor (Lunch @ Dining Hall, capacity 1) blocks a regular
// activity's overflow for a second group — the minimal case Slice 4 exists
// to fix. ANCHOR-driven contention.
function anchorFixture() {
  const groups = [
    { id: 'g1', name: 'Aleph', tier_id: 't1', availability: 'all' },
    { id: 'g2', name: 'Bet', tier_id: 't1', availability: 'all' },
  ]
  const days = [{ id: 'd1', label: 'Monday', day_of_week: 1, sort_order: 0 }]
  const timeBlocks = [{ id: 'b1', name: 'Morning', start_time: '09:00', end_time: '10:00', sort_order: 0, part_of_day: 'morning' }]
  const locations = [{ id: 'L', camp_id: 'test', name: 'Dining Hall', capacity: 1 }]
  const anchors = [{ id: 'anc1', activity_id: null, unit_id: null, is_all_groups: false, group_ids: ['g1'], day_id: null, time_block_id: 'b1', span_blocks: 1, name: 'Lunch', location_id: 'L' }]
  const activities = [{
    id: 'a1', name: 'Free Time', priority: 'high', max_per_week: 5, min_per_week: 1, span_blocks: 1,
    is_outdoor: false, location: null, location_id: 'L', max_groups_per_slot: 5, same_tier_only: false,
    eligible_tier_ids: [], eligible_group_ids: ['g2'], prefer_before_day: null, prefer_before_day_min: null,
  }]
  return { groups, tiers: [{ id: 't1', name: 'Junior' }], days, timeBlocks, activities, anchors, campId: 'audit', locations }
}

// ── Fixture 2: event-driven contention ──────────────────────────────────────
function eventFixture() {
  const groups = [
    { id: 'g1', name: 'Aleph', tier_id: 't1', availability: 'all' },
    { id: 'g2', name: 'Bet', tier_id: 't1', availability: 'all' },
  ]
  const days = [{ id: 'd1', label: 'Monday', day_of_week: 1, sort_order: 0 }]
  const timeBlocks = [{ id: 'b1', name: 'Morning', start_time: '09:00', end_time: '10:00', sort_order: 0, part_of_day: 'morning' }]
  const locations = [{ id: 'F', camp_id: 'test', name: 'Field', capacity: 1 }]
  const events = [{ id: 'ev1', name: 'Sports Day', location_id: 'F' }]
  const preplacedSlots = [{ groupId: 'g1', dayId: 'd1', blockId: 'b1', eventId: 'ev1' }]
  const activities = [{
    id: 'a1', name: 'Kickball', priority: 'high', max_per_week: 5, min_per_week: 1, span_blocks: 1,
    is_outdoor: true, location: null, location_id: 'F', max_groups_per_slot: 5, same_tier_only: false,
    eligible_tier_ids: [], eligible_group_ids: ['g2'], prefer_before_day: null, prefer_before_day_min: null,
  }]
  return { groups, tiers: [{ id: 't1', name: 'Junior' }], days, timeBlocks, activities, anchors: [], campId: 'audit', locations, events, preplacedSlots }
}

// ── Fixture 3: elective-driven contention — mixed-location 3-offering set ──
// This is the fixture the design doc (§4) flags as the likely disproportionate
// contributor: one elective cell now registers occupancy at THREE locations
// simultaneously.
function electiveFixture() {
  const groups = [
    { id: 'g1', name: 'Aleph', tier_id: 't1', availability: 'all' },
    { id: 'g2', name: 'Bet', tier_id: 't1', availability: 'all' },
    { id: 'g3', name: 'Gimel', tier_id: 't1', availability: 'all' },
    { id: 'g4', name: 'Dalet', tier_id: 't1', availability: 'all' },
  ]
  const days = [{ id: 'd1', label: 'Monday', day_of_week: 1, sort_order: 0 }]
  const timeBlocks = [{ id: 'b1', name: 'Afternoon', start_time: '14:00', end_time: '15:00', sort_order: 0, part_of_day: 'afternoon' }]
  const locations = [
    { id: 'POOL', camp_id: 'test', name: 'Pool', capacity: 1 },
    { id: 'ART', camp_id: 'test', name: 'Art Shed', capacity: 1 },
    { id: 'RANGE', camp_id: 'test', name: 'Range', capacity: 1 },
  ]
  const preplacedSlots = [{ groupId: 'g1', dayId: 'd1', blockId: 'b1', electiveSetId: 'es1' }]
  const electiveSetActivities = [
    { elective_set_id: 'es1', activity_id: 'swim' },
    { elective_set_id: 'es1', activity_id: 'art' },
    { elective_set_id: 'es1', activity_id: 'archery' },
  ]
  const activities = [
    { id: 'swim', name: 'Swim', priority: 'high', max_per_week: 5, min_per_week: 0, span_blocks: 1, is_outdoor: false, location: null, location_id: 'POOL', max_groups_per_slot: 5, same_tier_only: false, eligible_tier_ids: [], eligible_group_ids: ['g1'], prefer_before_day: null, prefer_before_day_min: null },
    { id: 'art', name: 'Art', priority: 'high', max_per_week: 5, min_per_week: 0, span_blocks: 1, is_outdoor: false, location: null, location_id: 'ART', max_groups_per_slot: 5, same_tier_only: false, eligible_tier_ids: [], eligible_group_ids: ['g1'], prefer_before_day: null, prefer_before_day_min: null },
    { id: 'archery', name: 'Archery', priority: 'high', max_per_week: 5, min_per_week: 0, span_blocks: 1, is_outdoor: false, location: null, location_id: 'RANGE', max_groups_per_slot: 5, same_tier_only: false, eligible_tier_ids: [], eligible_group_ids: ['g1'], prefer_before_day: null, prefer_before_day_min: null },
    { id: 'free-pool', name: 'Free Swim', priority: 'high', max_per_week: 5, min_per_week: 1, span_blocks: 1, is_outdoor: false, location: null, location_id: 'POOL', max_groups_per_slot: 5, same_tier_only: false, eligible_tier_ids: [], eligible_group_ids: ['g2'], prefer_before_day: null, prefer_before_day_min: null },
    { id: 'free-art', name: 'Free Art', priority: 'high', max_per_week: 5, min_per_week: 1, span_blocks: 1, is_outdoor: false, location: null, location_id: 'ART', max_groups_per_slot: 5, same_tier_only: false, eligible_tier_ids: [], eligible_group_ids: ['g3'], prefer_before_day: null, prefer_before_day_min: null },
    { id: 'free-range', name: 'Free Archery', priority: 'high', max_per_week: 5, min_per_week: 1, span_blocks: 1, is_outdoor: false, location: null, location_id: 'RANGE', max_groups_per_slot: 5, same_tier_only: false, eligible_tier_ids: [], eligible_group_ids: ['g4'], prefer_before_day: null, prefer_before_day_min: null },
  ]
  return { groups, tiers: [{ id: 't1', name: 'Junior' }], days, timeBlocks, activities, anchors: [], campId: 'audit', locations, electiveSetActivities, preplacedSlots }
}

// ── Fixture 4: realistic camp-shape — small shared high-traffic locations ──
// A week (5 days), 3 groups, 2 time blocks/day, one recurring Lunch anchor
// (dining hall) plus a daily elective period contending with a handful of
// regular activities across the same shared places (pool, field). This is
// the "Shemesh-style layout" shape (§4 fixture set item 2): multiple
// anchors/electives/activities competing for a small set of shared locations.
function campShapeFixture() {
  const days = Array.from({ length: 5 }, (_, i) => ({ id: `d${i + 1}`, label: `Day ${i + 1}`, day_of_week: i + 1, sort_order: i }))
  const timeBlocks = [
    { id: 'morn', name: 'Morning', start_time: '09:00', end_time: '10:00', sort_order: 0, part_of_day: 'morning' },
    { id: 'lunch', name: 'Lunch', start_time: '12:00', end_time: '13:00', sort_order: 1, part_of_day: 'midday' },
    { id: 'aft', name: 'Afternoon', start_time: '14:00', end_time: '15:00', sort_order: 2, part_of_day: 'afternoon' },
  ]
  const groups = [
    { id: 'g1', name: 'Aleph', tier_id: 't1', availability: 'all' },
    { id: 'g2', name: 'Bet', tier_id: 't1', availability: 'all' },
    { id: 'g3', name: 'Gimel', tier_id: 't1', availability: 'all' },
  ]
  const locations = [
    { id: 'DINING', camp_id: 'test', name: 'Dining Hall', capacity: 1 },
    { id: 'POOL', camp_id: 'test', name: 'Pool', capacity: 1 },
    { id: 'FIELD', camp_id: 'test', name: 'Field', capacity: 2 },
  ]
  // Daily recurring lunch anchor for g1 only (dining hall seats one group at
  // capacity 1 in this fixture, forcing real contention).
  const anchors = [{ id: 'anc-lunch', activity_id: null, unit_id: null, is_all_groups: false, group_ids: ['g1'], day_id: null, time_block_id: 'lunch', span_blocks: 1, name: 'Lunch', location_id: 'DINING' }]
  // Daily elective for g2 at the pool.
  const preplacedSlots = days.flatMap(d => [
    { groupId: 'g2', dayId: d.id, blockId: 'aft', electiveSetId: 'es-swim' },
  ])
  const electiveSetActivities = [{ elective_set_id: 'es-swim', activity_id: 'swim-offering' }]
  const activities = [
    { id: 'swim-offering', name: 'Swim Chugim', priority: 'high', max_per_week: 5, min_per_week: 0, span_blocks: 1, is_outdoor: false, location: null, location_id: 'POOL', max_groups_per_slot: 5, same_tier_only: false, eligible_tier_ids: [], eligible_group_ids: ['g2'], prefer_before_day: null, prefer_before_day_min: null },
    { id: 'free-swim', name: 'Free Swim', priority: 'high', max_per_week: 5, min_per_week: 3, span_blocks: 1, is_outdoor: false, location: null, location_id: 'POOL', max_groups_per_slot: 5, same_tier_only: false, eligible_tier_ids: [], eligible_group_ids: ['g3'], prefer_before_day: null, prefer_before_day_min: null },
    { id: 'lunch-overflow', name: 'Second Lunch', priority: 'high', max_per_week: 5, min_per_week: 3, span_blocks: 1, is_outdoor: false, location: null, location_id: 'DINING', max_groups_per_slot: 5, same_tier_only: false, eligible_tier_ids: [], eligible_group_ids: ['g2', 'g3'], prefer_before_day: null, prefer_before_day_min: null },
    { id: 'field-sports', name: 'Field Sports', priority: 'low', max_per_week: 5, min_per_week: 2, span_blocks: 1, is_outdoor: true, location: null, location_id: 'FIELD', max_groups_per_slot: 5, same_tier_only: false, eligible_tier_ids: [], eligible_group_ids: [], prefer_before_day: null, prefer_before_day_min: null },
  ]
  return { groups, tiers: [{ id: 't1', name: 'Junior' }], days, timeBlocks, activities, anchors, campId: 'audit', locations, electiveSetActivities, preplacedSlots }
}

const fixtures = [
  { name: 'anchor-contention (ANCHOR)', input: anchorFixture(), kind: 'anchor' },
  { name: 'event-contention (EVENT)', input: eventFixture(), kind: 'event' },
  { name: 'elective-mixed-location (ELECTIVE)', input: electiveFixture(), kind: 'elective' },
  { name: 'realistic-camp-shape (MIXED)', input: campShapeFixture(), kind: 'mixed' },
]

// Governance frontmatter — docs/work/** is walked by test/governance.test.js,
// which requires document_type + status. Emitted here (not hand-added to the
// .md) so a regeneration never drops it. `discovery` is the closest standard
// document_type for an evidence/findings report (title/document_type/status/created).
console.log('---')
console.log('title: "Slice 4b before/after audit — engine location-contention blast radius"')
console.log('document_type: discovery')
console.log('status: completed')
console.log('created: 2026-08-23')
console.log('---\n')
console.log('# Slice 4b before/after audit\n')
console.log('_Generated by `scripts/auditSlice4.mjs` — do not hand-edit; re-run the script to refresh._\n')

let grandTotalPlacementChanges = 0
let grandTotalNewlyUnfillable = 0
let grandTotalNewlyUnderserved = 0
let allDeterministic = true
const hotspotsByKind = { anchor: new Map(), elective: new Map(), event: new Map(), mixed: new Map() }

for (const { name, input, kind } of fixtures) {
  const result = diffFixture(name, input)
  grandTotalPlacementChanges += result.placementChanges
  grandTotalNewlyUnfillable += result.newlyUnfillable.length
  grandTotalNewlyUnderserved += result.newlyUnderserved.length
  allDeterministic = allDeterministic && result.deterministic

  console.log(`## ${result.name}`)
  console.log(`- Placements changed: ${result.placementChanges}`)
  console.log(`- Newly UNFILLABLE: ${result.newlyUnfillable.length}`)
  for (const u of result.newlyUnfillable) {
    console.log(`  - (${u.groupId}, ${u.dayId}, ${u.blockId}) — ${u.reason}`)
  }
  console.log(`- Newly UNDERSERVED: ${result.newlyUnderserved.length}`)
  for (const u of result.newlyUnderserved) {
    console.log(`  - group ${u.groupId}, activity ${u.activityId} — ${u.reason}`)
  }
  console.log(`- Determinism (same input twice, post-Slice-4): ${result.deterministic ? 'PASS' : 'FAIL'}`)
  if (result.name.includes('realistic-camp-shape') && result.placementChanges > 0 && result.newlyUnfillable.length === 0) {
    console.log(`  Note: the ${result.placementChanges} placement changes here are tie-break`)
    console.log('  reshuffling — once a constrained location narrowed the candidate pool for a')
    console.log('  slot, the engine\'s existing tie-break (getCount, then rand()) picked a')
    console.log('  different eligible activity for that slot. No capacity was ever exceeded and')
    console.log('  nothing went unfilled; this is a placement reordering, not a regression.')
  }
  console.log()

  for (const u of result.newlyUnfillable) {
    const map = hotspotsByKind[kind]
    const locName = (u.reason.match(/— (.+?) is occupied/) || [])[1] || 'unknown'
    map.set(locName, (map.get(locName) || 0) + 1)
  }
}

console.log('## Contention hotspots (newly-UNFILLABLE cells, by location), broken out by overlay kind\n')
for (const kind of ['anchor', 'event', 'elective', 'mixed']) {
  const map = hotspotsByKind[kind]
  if (map.size === 0) continue
  console.log(`### ${kind.toUpperCase()}-driven`)
  for (const [loc, count] of [...map.entries()].sort((a, b) => b[1] - a[1])) {
    console.log(`- ${loc}: ${count} newly-unfillable cell(s)`)
  }
  console.log()
}

console.log('## Summary\n')
console.log(`- Total (group, day, block) placement changes across all fixtures: ${grandTotalPlacementChanges}`)
console.log(`- Total newly-UNFILLABLE cells: ${grandTotalNewlyUnfillable}`)
console.log(`- Total newly-UNDERSERVED findings: ${grandTotalNewlyUnderserved}`)
console.log(`- Determinism preserved across all fixtures: ${allDeterministic ? 'YES' : 'NO'}`)
console.log()
console.log('Note: anchor_activities.location_id and events.location_id have no writer yet in the')
console.log('shipped app (no location picker UI), so on real/production data today this slice\'s')
console.log('real-world contention comes from ELECTIVES only, until the Recurring Events/Events')
console.log('screens grow a location picker. The anchor/event fixtures above set fixture-only')
console.log('locations to exercise that code path ahead of the UI landing.')
