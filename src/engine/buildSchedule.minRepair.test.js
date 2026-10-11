import { describe, it, expect } from 'vitest'
import buildSchedule from './buildSchedule.js'

// Owner: a camp that imports a filled week should get a filled week back from Generate.
// Greedy placement can fill every cell yet leave an activity below its weekly minimum,
// because cells went to activities already at or above theirs. The min repair lifts
// those surplus placements and gives the cells to the activity that is short.
const act = (id, extra) => ({ id, name: id, priority: 'high', min_per_week: 0, max_per_week: 5, max_groups_per_slot: 0, same_tier_only: false, eligible_tier_ids: [], eligible_group_ids: [], prefer_before_day: null, prefer_before_day_min: null, ...extra })
const block = (i) => ({ id: `b${i}`, name: `B${i}`, start_time: `0${i}:00`, end_time: `0${i}:50`, sort_order: i, part_of_day: 'morning' })
const input = (activities) => ({
  groups: [{ id: 'g1', name: 'Aleph', tier_id: 't1', availability: 'all' }],
  tiers: [{ id: 't1', name: 'Junior' }],
  days: [{ id: 'd1', label: 'Monday', day_of_week: 1, sort_order: 0 }],
  timeBlocks: [block(1), block(2)],
  activities, fixedEvents: [], campId: 'min-repair', replacedDayIds: [],
})

describe('buildSchedule — no activity left below its minimum when the week can hold it', () => {
  it('a low-priority two-block span displaces high-priority singles that have no minimum', () => {
    const { slots, findings } = buildSchedule(input([act('Archery'), act('Drama'), act('Hike', { priority: 'low', span_blocks: 2, min_per_week: 1 })]))
    expect(findings.filter((f) => f.kind === 'UNDERSERVED')).toEqual([])
    expect(slots.filter((s) => s.activityId === 'Hike')).toHaveLength(2)
  })
  it('a single-block activity short of its minimum takes a cell from one above its own', () => {
    const { findings } = buildSchedule(input([act('Archery'), act('Drama'), act('Swim', { priority: 'low', min_per_week: 1 })]))
    expect(findings.filter((f) => f.kind === 'UNDERSERVED')).toEqual([])
  })
  it('never lifts an activity below its own minimum to do it', () => {
    const { findings } = buildSchedule(input([act('Archery', { min_per_week: 1 }), act('Drama', { min_per_week: 1 }), act('Hike', { priority: 'low', span_blocks: 2, min_per_week: 1 })]))
    const short = findings.filter((f) => f.kind === 'UNDERSERVED').map((f) => f.activityId)
    expect(short).toEqual(['Hike'])
  })
})

// The owner's acceptance rule in miniature: build a full week first, read the rules off it the way
// import does (per-group weekly count -> min = lowest, max = highest; capacity = most groups seen
// sharing an activity in one slot; eligibility = groups seen), then Generate must place every minimum.
function mulberry(seed) {
  return () => { seed |= 0; seed = (seed + 0x6D2B79F5) | 0; let t = Math.imul(seed ^ (seed >>> 15), 1 | seed); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296 }
}
function feasibleWeek(seed) {
  const r = mulberry(seed)
  const nG = 2 + Math.floor(r() * 4), nD = 2 + Math.floor(r() * 3), nB = 2 + Math.floor(r() * 3), nA = nB * nD + Math.floor(r() * 3)
  const groups = Array.from({ length: nG }, (_, i) => ({ id: `g${i}`, name: `G${i}`, tier_id: 't1', availability: 'all' }))
  const days = Array.from({ length: nD }, (_, i) => ({ id: `d${i}`, label: `D${i}`, day_of_week: i + 1, sort_order: i }))
  const timeBlocks = Array.from({ length: nB }, (_, i) => block(i + 1))
  const names = Array.from({ length: nA }, (_, i) => `A${i}`)
  const week = [] // the known-feasible schedule: one activity per cell, once per day per group
  for (const g of groups) for (const d of days) {
    const pool = names.slice()
    for (const b of timeBlocks) {
      const k = Math.floor(r() * pool.length)
      week.push({ g: g.id, d: d.id, b: b.id, a: pool.splice(k, 1)[0] })
    }
  }
  const count = new Map(), share = new Map(), seen = new Map()
  for (const c of week) {
    count.set(`${c.a}|${c.g}`, (count.get(`${c.a}|${c.g}`) ?? 0) + 1)
    share.set(`${c.a}|${c.d}|${c.b}`, (share.get(`${c.a}|${c.d}|${c.b}`) ?? 0) + 1)
    if (!seen.has(c.a)) seen.set(c.a, new Set())
    seen.get(c.a).add(c.g)
  }
  const activities = names.filter((n) => seen.has(n)).map((n) => {
    const per = [...seen.get(n)].map((g) => count.get(`${n}|${g}`))
    const cap = Math.max(...[...share].filter(([k]) => k.startsWith(`${n}|`)).map(([, v]) => v))
    return act(n, { min_per_week: Math.min(...per), max_per_week: Math.max(...per), max_groups_per_slot: cap, eligible_group_ids: [...seen.get(n)] })
  })
  return { groups, tiers: [{ id: 't1', name: 'Junior' }], days, timeBlocks, activities, fixedEvents: [], campId: `feasible-${seed}`, replacedDayIds: [] }
}

describe('buildSchedule — a week built from a feasible schedule is filled again', () => {
  it('places every minimum on 1000 seeded weeks known to be feasible', () => {
    const misses = []
    for (let seed = 1; seed <= 1000; seed++) {
      const { slots, findings } = buildSchedule(feasibleWeek(seed))
      const short = findings.filter((f) => f.kind === 'UNDERSERVED')
      if (short.length) misses.push(`${seed}: ${short.map((f) => `${f.activityId}/${f.groupId} ${f.got}<${f.needed}`).join(', ')}`)
      const empty = slots.filter((x) => x.type === 'activity' && !x.activityId)
      if (empty.length) misses.push(`${seed}: ${empty.length} empty cell(s)`)
    }
    expect(misses).toEqual([])
  })
})
