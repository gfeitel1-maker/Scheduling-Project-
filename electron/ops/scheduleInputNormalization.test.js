// Pins the ONE normalization implementation both the renderer
// (src/screens/schedule/useScheduleData.js) and the headless path
// (electron/ops/scheduleEngineInputs.js) now share.
//
// The `unit_ids` case below is a REGRESSION test, not a hypothetical: while
// these rules were two hand-copied implementations, the headless copy parsed
// only `group_ids` and never `unit_ids`, for the whole life of the v65
// column. Nothing threw — src/engine/anchorScope.js's resolveAnchorGroupIds
// tests `Array.isArray(anchor.unit_ids)`, so a raw JSON string is simply not
// a scope claim and falls through to the unit_id > is_all_groups > group_ids
// fallback. Every MCP/headless caller silently lost division scope.
import { describe, it, expect } from 'vitest'
import { resolveAnchorGroupIds } from '../../src/engine/anchorScope.js'
import { DIRECT_CAMP_ENTITIES, PARENT_SCOPED_ENTITIES } from './campScopedEntities.js'
import {
  SCHEDULE_INPUT_ENTITIES,
  normalizeScheduleInputs,
} from './scheduleInputNormalization.js'

const CAMP = 'camp-1'
const OTHER = 'camp-2'

describe('normalizeScheduleInputs', () => {
  it('parses BOTH anchor id-list columns, so division scope survives', () => {
    const { anchors, groups } = normalizeScheduleInputs(
      {
        tiers: [{ id: 'unit-a', camp_id: CAMP, sort_order: 0 }],
        groups: [
          { id: 'g1', camp_id: CAMP, name: 'Bears', tier_id: 'unit-a' },
          { id: 'g2', camp_id: CAMP, name: 'Cubs', tier_id: 'unit-b' },
        ],
        anchor_activities: [
          { id: 'anc-1', camp_id: CAMP, group_ids: '["g9"]', unit_ids: '["unit-a"]' },
        ],
      },
      CAMP
    )

    expect(anchors[0].group_ids).toEqual(['g9'])
    expect(anchors[0].unit_ids).toEqual(['unit-a'])
    // Non-vacuity: the engine must actually READ it as a division claim. With
    // the raw string this returned ['g9'] — the fallback — not ['g1'].
    expect(resolveAnchorGroupIds(anchors[0], groups)).toEqual(['g1'])
  })

  it('sorts days by sort_order BEFORE de-duping by day_of_week', () => {
    const { days } = normalizeScheduleInputs(
      {
        days_of_operation: [
          { id: 'late', camp_id: CAMP, day_of_week: 1, sort_order: 9 },
          { id: 'early', camp_id: CAMP, day_of_week: 1, sort_order: 0 },
          { id: 'tue', camp_id: CAMP, day_of_week: 2, sort_order: 1 },
        ],
      },
      CAMP
    )
    // The survivor of the duplicate pair is the lowest sort_order, not
    // whichever the DB happened to return first.
    expect(days.map((d) => d.id)).toEqual(['early', 'tue'])
  })

  it('sorts groups by their tier order, then by name; orphan tiers sort last', () => {
    const { groups } = normalizeScheduleInputs(
      {
        tiers: [
          { id: 't-old', camp_id: CAMP, sort_order: 1 },
          { id: 't-young', camp_id: CAMP, sort_order: 0 },
        ],
        groups: [
          { id: 'g-orphan', camp_id: CAMP, name: 'Aardvarks', tier_id: 't-gone' },
          { id: 'g-old-b', camp_id: CAMP, name: 'Bears', tier_id: 't-old' },
          { id: 'g-old-a', camp_id: CAMP, name: 'Antelope', tier_id: 't-old' },
          { id: 'g-young', camp_id: CAMP, name: 'Zebras', tier_id: 't-young' },
        ],
      },
      CAMP
    )
    expect(groups.map((g) => g.id)).toEqual(['g-young', 'g-old-a', 'g-old-b', 'g-orphan'])
  })

  it('scopes every camp_id-bearing list to the camp, and leaves elective_set_activities alone', () => {
    const out = normalizeScheduleInputs(
      {
        groups: [
          { id: 'mine', camp_id: CAMP, name: 'Bears', tier_id: null },
          { id: 'theirs', camp_id: OTHER, name: 'Aardvarks', tier_id: null },
        ],
        locations: [{ id: 'l1', camp_id: CAMP }, { id: 'l2', camp_id: OTHER }],
        events: [{ id: 'e1', camp_id: CAMP }, { id: 'e2', camp_id: OTHER }],
        elective_sets: [{ id: 'es1', camp_id: CAMP }, { id: 'es2', camp_id: OTHER }],
        // Parent-scoped through elective_set_id; it has NO camp_id column, so
        // filtering it on one would silently empty the list.
        elective_set_activities: [{ id: 'esa1', elective_set_id: 'es1', activity_id: 'a1' }],
      },
      CAMP
    )
    expect(out.groups.map((x) => x.id)).toEqual(['mine'])
    expect(out.locations.map((x) => x.id)).toEqual(['l1'])
    expect(out.events.map((x) => x.id)).toEqual(['e1'])
    expect(out.electiveSets.map((x) => x.id)).toEqual(['es1'])
    expect(out.electiveSetActivities.map((x) => x.id)).toEqual(['esa1'])
  })

  it('treats a missing or null list as empty rather than throwing', () => {
    // The renderer's repository defaults its best-effort elective/event
    // fetches to [] on failure; a degraded load must stay a degraded load.
    const out = normalizeScheduleInputs({ groups: null }, CAMP)
    for (const key of Object.keys(out)) expect(out[key]).toEqual([])
    expect(normalizeScheduleInputs(undefined, CAMP).activities).toEqual([])
  })

  it('never mutates or re-orders the caller’s input arrays', () => {
    const tiers = [
      { id: 't-b', camp_id: CAMP, sort_order: 1 },
      { id: 't-a', camp_id: CAMP, sort_order: 0 },
    ]
    normalizeScheduleInputs({ tiers }, CAMP)
    expect(tiers.map((t) => t.id)).toEqual(['t-b', 't-a'])
  })

  it('actually reads every entity it declares, and declares every entity it reads', () => {
    // Guards the seam that replaced the two hand-copied fetch lists. A name
    // declared but never read is a table both call sites fetch for nothing;
    // a name read but never declared is a table NOBODY fetches, which does
    // not throw — it silently normalizes to [].
    expect(new Set(SCHEDULE_INPUT_ENTITIES).size).toBe(SCHEDULE_INPUT_ENTITIES.length)

    const readEntities = new Set()
    const probe = new Proxy(
      Object.fromEntries(
        SCHEDULE_INPUT_ENTITIES.map((e) => [e, [{ id: `${e}-row`, camp_id: CAMP, name: 'x' }]])
      ),
      {
        get(target, prop) {
          if (typeof prop === 'string') readEntities.add(prop)
          return target[prop]
        },
      }
    )
    const out = normalizeScheduleInputs(probe, CAMP)

    for (const entity of SCHEDULE_INPUT_ENTITIES) {
      expect(readEntities, `declared but never read: ${entity}`).toContain(entity)
    }
    for (const entity of readEntities) {
      expect(SCHEDULE_INPUT_ENTITIES, `read but never declared: ${entity}`).toContain(entity)
    }
    // And every declared entity surfaces somewhere in the output, so a
    // fetched table cannot be quietly dropped on the floor.
    const surfaced = new Set(Object.values(out).flat().map((row) => row.id))
    for (const entity of SCHEDULE_INPUT_ENTITIES) {
      expect(surfaced, `fetched but dropped: ${entity}`).toContain(`${entity}-row`)
    }
  })

  it('only declares entities the shared camp-scoped registry can actually serve', () => {
    // The structural link to campScopedEntities.js. electron/ops/read.js's
    // listEntities hard-rejects any entity absent from those two registries,
    // so a name added here but not there would throw at MCP runtime — not at
    // build time, and not in the renderer, which reaches these tables by a
    // different path.
    for (const entity of SCHEDULE_INPUT_ENTITIES) {
      expect(
        DIRECT_CAMP_ENTITIES.has(entity) || entity in PARENT_SCOPED_ENTITIES,
        `${entity} is not a registered camp-scoped entity`
      ).toBe(true)
    }
  })
})
