// Headless assembly of buildSchedule()'s legacy-signature inputs
// ({ groups, tiers, days, timeBlocks, activities, fixedEvents, campId,
// locations, electiveSetActivities, events }) from DB rows, for callers that
// have no renderer/React tree to load through. `electiveSetActivities`/
// `events` (T193) are what let buildSchedule resolve an elective offering's
// or an event's location for a stored overlay slot fed in via
// preplacedSlots — without them the overlay rows exist but their occupancy
// is invisible, which is exactly the falsely-clean result T193 exists to
// close. `locations` IS consumed by buildSchedule (its
// normalizeInput reads `input.locations`, defaulting to [] — an empty
// capacity map — when omitted, per src/engine/buildSchedule.js's own
// comment); this module includes it so a caller that spreads this result
// straight into buildSchedule(...) gets real location-capacity constraints
// instead of silently unconstrained ones. Do not drop it as unused without
// re-checking that call site.
//
// Extracted seam (docs/adr/2026-08-21-mcp-ingestion-server.md, Decision 8).
// This module used to declare itself a MANUAL MIRROR of the renderer's
// src/screens/schedule/useScheduleData.js `load()` — a hand-copied second
// implementation of the same filter/sort/de-dupe/parse rules, kept aligned
// by a comment. It did not stay aligned (it lost fixedEvents' `unit_ids` parse
// for the whole life of v65). Both sides now call the ONE implementation in
// ./scheduleInputNormalization.js; the only thing left here is the fetch and
// the choice of which normalized lists this legacy signature carries.
import { listEntities } from './read.js'
import {
  SCHEDULE_INPUT_ENTITIES,
  normalizeScheduleInputs,
} from './scheduleInputNormalization.js'
import { resolveEffectiveDays } from '../../src/engine/effectiveDays.js'

// `weekId` is explicit (null = no week): replaced days (T350, ADR 2026-10-09
// D4) are a fact about a week, so without one nothing is replaced. `days` is
// returned whole; buildSchedule/computeFindings apply `replacedDayIds` themselves.
export function assembleScheduleEngineInputs(db, campId, weekId) {
  if (weekId === undefined) throw new Error('assembleScheduleEngineInputs: weekId is required (null = no week)')
  // Fetch list DERIVED from the normalizer's own declared inputs, never
  // hand-listed here — that is what makes "a new setup list was added" a
  // one-place edit instead of a two-place one that compiles either way.
  const rowsByEntity = {}
  for (const entity of SCHEDULE_INPUT_ENTITIES) {
    rowsByEntity[entity] = listEntities(db, entity)
  }

  const {
    groups, tiers, days, timeBlocks, activities, fixedEvents, locations,
    // `cohorts` and `electiveSets` are normalized but DELIBERATELY not
    // returned. buildSchedule's normalizeInput branches on `input.cohorts`
    // being present — handing it cohorts would switch every headless caller
    // off the legacy signature this module's callers expect, which is a
    // behaviour change, not a de-duplication. `electiveSets` is unread by
    // the engine (it resolves offerings through electiveSetActivities).
    // Add either only with the call site in scripts/mcp/tools.js in hand.
    electiveSetActivities, events,
  } = normalizeScheduleInputs(rowsByEntity, campId)

  const { replacedDayIds } = weekId == null
    ? { replacedDayIds: [] }
    : resolveEffectiveDays({
        days, weekId,
        placements: listEntities(db, 'special_day_placements').filter(p => p.week_id === weekId),
        specialDays: listEntities(db, 'special_days'),
      })

  return { groups, tiers, days, replacedDayIds, timeBlocks, activities, fixedEvents, locations, electiveSetActivities, events }
}
