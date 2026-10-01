// Risk item 1 from docs/adr/2026-10-01-anchors-become-fixed-and-recurring-events.md: the anchor ->
// fixed/recurring-event vocabulary rename must be a PURE identifier substitution inside
// buildSchedule.js, fixedEventScope.js (formerly anchorScope.js) and fixedEventActivityLink.js
// (formerly anchorActivityLink.js) — same call order, same object shapes, same Map insertion
// order. A reordered call would silently change the Mulberry32 draw sequence.
//
// This snapshot was captured from the RENAMED implementation and cross-checked by hand, before
// this file was committed, against the PRE-rename implementation (git history, the commit
// immediately before the v84 rename landed) using the exact same fixture — the two produced
// byte-identical `slots`, and `findings` differed in exactly the two expected kind strings
// (ANCHOR_IDENTITY_GAP -> FIXED_EVENT_IDENTITY_GAP; this fixture does not exercise
// ANCHOR_DUPLICATE/FIXED_EVENT_DUPLICATE, which computeFindings() produces separately — see below).
// That comparison is not repeatable from inside this test (it needs the pre-rename source tree),
// so this file pins the post-rename output going forward: a future change to buildSchedule.js that
// reorders a call or changes an object shape will break this snapshot.
import { describe, it, expect } from 'vitest'
import buildSchedule from './buildSchedule.js'

const baseGroup = { id: 'g1', name: 'Aleph', tier_id: 't1', availability: 'all' }
const baseGroup2 = { id: 'g2', name: 'Bet', tier_id: 't1', availability: 'all' }
const baseDay = { id: 'd1', label: 'Monday', day_of_week: 1, sort_order: 0 }
const day2 = { id: 'd2', label: 'Tuesday', day_of_week: 2, sort_order: 1 }
const baseBlock = { id: 'b1', name: 'Morning', start_time: '09:00', end_time: '10:15', sort_order: 0, part_of_day: 'morning' }
const block2 = { id: 'b2', name: 'Late Morning', start_time: '10:30', end_time: '11:45', sort_order: 1, part_of_day: 'morning' }
const block3 = { id: 'b3', name: 'Afternoon', start_time: '13:00', end_time: '14:15', sort_order: 2, part_of_day: 'afternoon' }

const lunch = { id: 'lunch', name: 'Lunch', priority: 'high', max_per_week: 10, min_per_week: 2, is_outdoor: false, location: null, max_groups_per_slot: 2, same_tier_only: false, eligible_tier_ids: [], eligible_group_ids: [], prefer_before_day: null, prefer_before_day_min: null }
const swim = { id: 'swim', name: 'Swim', priority: 'high', max_per_week: 10, min_per_week: 2, is_outdoor: true, location: 'pool', max_groups_per_slot: 1, same_tier_only: false, eligible_tier_ids: [], eligible_group_ids: [], prefer_before_day: null, prefer_before_day_min: null }
const arts = { id: 'arts', name: 'Arts', priority: 'low', max_per_week: 5, min_per_week: 1, is_outdoor: false, location: null, max_groups_per_slot: 2, same_tier_only: false, eligible_tier_ids: [], eligible_group_ids: [], prefer_before_day: null, prefer_before_day_min: null }

// Resolves by activity_id (real row shape) — triggers FIXED_EVENT_DUPLICATE-adjacent exclusion
// (the T62 anchored-activity exclusion) inside buildSchedule itself.
const fixedEventLunch = { id: 'anc-lunch', activity_id: 'lunch', name: 'Lunch', unit_id: null, is_all_groups: true, group_ids: [], day_id: null, time_block_id: 'b1', span_blocks: 1 }
// Unresolved activity_id (no live activity with this id) — triggers FIXED_EVENT_IDENTITY_GAP.
const fixedEventGap = { id: 'anc-gap', activity_id: 'does-not-exist', name: 'Mifkad', unit_id: null, is_all_groups: true, group_ids: [], day_id: null, time_block_id: 'b2', span_blocks: 1 }

function buildInput() {
  return {
    groups: [baseGroup, baseGroup2],
    tiers: [{ id: 't1', name: 'Junior' }],
    days: [baseDay, day2],
    timeBlocks: [baseBlock, block2, block3],
    activities: [lunch, swim, arts],
    fixedEvents: [fixedEventLunch, fixedEventGap],
    locations: [{ id: 'pool', name: 'Pool', capacity: 1 }],
    campId: 'det-pin-camp',
  }
}

function serialize(result) {
  const sortedSlots = [...result.slots].sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)))
  const sortedFindings = [...result.findings].sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)))
  return { slots: sortedSlots, findings: sortedFindings }
}

// The PRE-RENAME expectation, captured from the implementation before the engine's
// public contract was renamed. It is deliberately left verbatim: the test below applies
// ONLY the two declared renames to it and compares. Any other drift — a reordered slot, a
// changed PRNG draw, a lost finding — still fails, which is the whole point of the pin.
const EXPECTED_PRE_RENAME = {"slots":[{"groupId":"g1","dayId":"d1","blockId":"b1","cohort_id":null,"type":"anchor","activityId":null,"anchorId":"anc-lunch","is_span_head":true,"flags":{}},{"groupId":"g1","dayId":"d1","blockId":"b2","cohort_id":null,"type":"anchor","activityId":null,"anchorId":"anc-gap","is_span_head":true,"flags":{}},{"groupId":"g1","dayId":"d1","blockId":"b3","cohort_id":null,"type":"activity","activityId":"swim","anchorId":null,"is_span_head":true,"flags":{}},{"groupId":"g1","dayId":"d2","blockId":"b1","cohort_id":null,"type":"anchor","activityId":null,"anchorId":"anc-lunch","is_span_head":true,"flags":{}},{"groupId":"g1","dayId":"d2","blockId":"b2","cohort_id":null,"type":"anchor","activityId":null,"anchorId":"anc-gap","is_span_head":true,"flags":{}},{"groupId":"g1","dayId":"d2","blockId":"b3","cohort_id":null,"type":"activity","activityId":"swim","anchorId":null,"is_span_head":true,"flags":{}},{"groupId":"g2","dayId":"d1","blockId":"b1","cohort_id":null,"type":"anchor","activityId":null,"anchorId":"anc-lunch","is_span_head":true,"flags":{}},{"groupId":"g2","dayId":"d1","blockId":"b2","cohort_id":null,"type":"anchor","activityId":null,"anchorId":"anc-gap","is_span_head":true,"flags":{}},{"groupId":"g2","dayId":"d1","blockId":"b3","cohort_id":null,"type":"activity","activityId":"arts","anchorId":null,"is_span_head":true,"flags":{}},{"groupId":"g2","dayId":"d2","blockId":"b1","cohort_id":null,"type":"anchor","activityId":null,"anchorId":"anc-lunch","is_span_head":true,"flags":{}},{"groupId":"g2","dayId":"d2","blockId":"b2","cohort_id":null,"type":"anchor","activityId":null,"anchorId":"anc-gap","is_span_head":true,"flags":{}},{"groupId":"g2","dayId":"d2","blockId":"b3","cohort_id":null,"type":"activity","activityId":"arts","anchorId":null,"is_span_head":true,"flags":{}}],"findings":[{"kind":"FIXED_EVENT_IDENTITY_GAP","groupId":null,"activityId":"does-not-exist","severity":"error","reason":"\"Mifkad\" is not linked to a live activity — regeneration is blocked until this is fixed","anchorId":"anc-gap"},{"kind":"UNDERSERVED","groupId":"g1","activityId":"arts","severity":"caution","reason":"Goal: 1×/wk — scheduled 0× (group: Aleph, activity: Arts)","got":0,"needed":1},{"kind":"UNDERSERVED","groupId":"g1","activityId":"lunch","severity":"caution","reason":"Goal: 2×/wk — scheduled 0× (group: Aleph, activity: Lunch)","got":0,"needed":2},{"kind":"UNDERSERVED","groupId":"g2","activityId":"lunch","severity":"caution","reason":"Goal: 2×/wk — scheduled 0× (group: Bet, activity: Lunch)","got":0,"needed":2},{"kind":"UNDERSERVED","groupId":"g2","activityId":"swim","severity":"caution","reason":"Goal: 2×/wk — scheduled 0× (group: Bet, activity: Swim)","got":0,"needed":2}]}

// The ONLY changes the T293 rename is permitted to make to buildSchedule's output:
// the slot type discriminator's value, and the slot/finding field name carrying the id.
function applyDeclaredRename(value) {
  if (Array.isArray(value)) return value.map(applyDeclaredRename)
  if (value === null || typeof value !== 'object') return value
  const out = {}
  for (const [k, v] of Object.entries(value)) {
    if (k === 'type' && v === 'anchor') { out.type = 'fixed_event'; continue }
    out[k === 'anchorId' ? 'fixedEventId' : k] = applyDeclaredRename(v)
  }
  return out
}

describe('buildSchedule determinism pin (anchor -> fixed/recurring-event rename, T293)', () => {
  it('output is the pre-rename output with ONLY the two declared renames applied', () => {
    const result = serialize(buildSchedule(buildInput()))
    expect(result).toEqual(applyDeclaredRename(EXPECTED_PRE_RENAME))
  })

  it('the pin is non-vacuous: the pre-rename expectation really did carry the old names', () => {
    const raw = JSON.stringify(EXPECTED_PRE_RENAME)
    expect(raw).toContain('"type":"anchor"')
    expect(raw).toContain('"anchorId"')
    const renamed = JSON.stringify(applyDeclaredRename(EXPECTED_PRE_RENAME))
    expect(renamed).not.toContain('"type":"anchor"')
    expect(renamed).not.toContain('"anchorId"')
    expect(renamed).toContain('"fixedEventId"')
  })

  it('findings carry no stray ANCHOR_* kind string — only FIXED_EVENT_* and unrelated kinds', () => {
    const result = buildSchedule(buildInput())
    const kinds = new Set(result.findings.map((f) => f.kind))
    for (const kind of kinds) {
      expect(kind.startsWith('ANCHOR_')).toBe(false)
    }
    expect(kinds.has('FIXED_EVENT_IDENTITY_GAP')).toBe(true)
  })
})
