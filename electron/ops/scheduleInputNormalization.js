// The ONE implementation of "raw setup rows → schedule inputs".
//
// Why this module exists
// ----------------------
// Two call sites need the same setup lists, normalized the same way:
//
//   1. src/screens/schedule/useScheduleData.js's `load()` — the renderer,
//      which feeds them to the grid, computeFindings, and buildSchedule.
//   2. electron/ops/scheduleEngineInputs.js — the headless path (MCP
//      `schedule_state`, scripts/mcp/tools.js), which has no React tree.
//
// Until this module, (2) carried a header comment declaring itself a MANUAL
// MIRROR of (1) — "keep this in sync if that logic changes" — with nothing
// structural enforcing it. It did not stay in sync. By the time the mirror
// covered eight fields it had silently lost a rule: the renderer parses BOTH
// JSON-stringified id-list columns on an anchor (`group_ids` AND, since v65/
// T180, `unit_ids`), while the headless copy parsed only `group_ids`.
// src/engine/anchorScope.js's resolveAnchorGroupIds tests
// `Array.isArray(anchor.unit_ids)`, so a raw JSON STRING is not a scope
// claim: it falls through to unit_id > is_all_groups > group_ids. A
// division-scoped anchor therefore covered the wrong groups — usually none —
// for every headless caller, with no error, no lint failure and no test
// failure. That is the exact failure mode a comment cannot prevent and a
// second copy invites.
//
// Why NOT derive this from campScopedEntities.js
// ----------------------------------------------
// That module answers "which tables belong to a camp, and how are they
// scoped" — and electron/ops/read.js's `listEntities` ALREADY applies it, so
// every row this module receives is camp-scoped before it arrives. The part
// that actually drifted is none of that: it is the per-field sort, de-dupe
// and JSON-parse rules, which campScopedEntities.js neither knows nor could
// know. Deriving the entity list from it would have deduplicated the least
// drift-prone half of the copy and left the half that broke untouched.
//
// This module is deliberately PURE — no db handle, no IPC, no React. That is
// what lets the renderer share it: the renderer's entanglement with React
// state is in the load's generation guard and setState calls, which wrap this
// normalization but are not part of it.
import { normalizeActivityEligibility, parseIdList } from '../../src/utils/normalizeActivityEligibility.js'

// The raw rows this module needs, keyed by TABLE name — the shape both
// `repo.loadSetupLists()` (renderer) and `listEntities()` (headless) speak.
// Exported so each call site DERIVES its fetch list from here instead of
// hand-maintaining its own, and so a test can assert the renderer's
// repository actually returns all of them.
export const SCHEDULE_INPUT_ENTITIES = [
  'groups',
  'tiers',
  'time_blocks',
  'days_of_operation',
  'activities',
  'anchor_activities',
  'locations',
  'cohorts',
  'elective_sets',
  'elective_set_activities',
  'events',
]

// `elective_set_activities` has no camp_id column of its own — it is
// parent-scoped through elective_set_id, and both read paths already scope it
// by joining through elective_sets.camp_id (electron/ops/read.js;
// localClient.list via main.js's list() handler, both off
// PARENT_SCOPED_ENTITIES). Re-filtering it here on a column it does not have
// would silently empty the list.
const NOT_CAMP_FILTERED = new Set(['elective_set_activities'])

const bySortOrder = (x, y) => (x.sort_order ?? 0) - (y.sort_order ?? 0)

/**
 * Normalize raw setup rows into the lists the schedule engine and the
 * schedule screen both consume.
 *
 * @param {object} rowsByEntity rows keyed by table name (see
 *   SCHEDULE_INPUT_ENTITIES). A missing or null key is treated as an empty
 *   list — the renderer's repository defaults elective/event fetches to []
 *   on a best-effort failure, and that must stay a degraded load, not a throw.
 * @param {string} campId the camp to scope to. Both read paths are already
 *   single-camp, so this filter is defensive, not the isolation boundary —
 *   but it is applied identically on both sides so a stray row cannot make
 *   the two disagree.
 */
export function normalizeScheduleInputs(rowsByEntity, campId) {
  const raw = (entity) => {
    const rows = (rowsByEntity || {})[entity] || []
    return NOT_CAMP_FILTERED.has(entity) ? [...rows] : rows.filter((x) => x.camp_id === campId)
  }

  const tiers = raw('tiers').sort(bySortOrder)
  const timeBlocks = raw('time_blocks').sort(bySortOrder)

  // De-dupe days by day_of_week AFTER sorting, so the survivor of a duplicate
  // pair is the lowest-sort_order one, not whichever the DB returned first.
  const days = raw('days_of_operation')
    .sort(bySortOrder)
    .filter((x, i, arr) => arr.findIndex((y) => y.day_of_week === x.day_of_week) === i)

  const activities = raw('activities').map(normalizeActivityEligibility)

  // Both id-list columns are JSON-stringified in SQLite and MUST become real
  // arrays here, at the read boundary, so the pure engine never deserializes.
  // `unit_ids` (v65, T180) is the anchor's DIVISION scope and is resolved
  // live by src/engine/anchorScope.js — omitting it does not throw, it
  // silently drops the scope. See this file's header. See T63 for group_ids.
  const anchors = raw('anchor_activities').map((x) => ({
    ...x,
    group_ids: parseIdList(x.group_ids),
    unit_ids: parseIdList(x.unit_ids),
  }))

  // Groups sort by their tier's order first, then by name within a tier. A
  // group whose tier_id matches no live tier sorts last (999) rather than
  // first, so an orphaned group never displaces a real one.
  const tierOrderMap = new Map(tiers.map((tier) => [tier.id, tier.sort_order ?? 0]))
  const groups = raw('groups').sort((x, y) => {
    const ox = tierOrderMap.get(x.tier_id) ?? 999
    const oy = tierOrderMap.get(y.tier_id) ?? 999
    return ox !== oy ? ox - oy : x.name.localeCompare(y.name)
  })

  return {
    groups,
    tiers,
    days,
    timeBlocks,
    activities,
    anchors,
    locations: raw('locations'),
    cohorts: raw('cohorts'),
    electiveSets: raw('elective_sets'),
    electiveSetActivities: raw('elective_set_activities'),
    events: raw('events'),
  }
}
