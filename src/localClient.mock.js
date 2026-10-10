// Browser-dev-server stand-in for window.shoresh (only Electron's preload-bridged
// renderer has the real thing). Lets ModeSelect/Join/Bootstrap/Login be visually
// verified with `npm run dev` outside Electron. Never used when window.shoresh exists.

// T74: the dev mock's import commit reuses the SAME pure decision layer the real
// committer does (src/ingest/buildPlan.js) so the reconciliation UI — recognition,
// field-update, hand-edit protection, and the T73 held-conflict resolution flow —
// can be exercised truthfully at localhost:5200. buildPlan is renderer-side (src/),
// same side as this mock, so importing it crosses no boundary.
import { buildPlan, CLEAR } from './ingest/buildPlan.js'
import { INGESTIBLE_ENTITIES } from './ingest/extractEntities.js'
import { normalizeName, recognitionKey } from './ingest/preview.js'
// S2c: the SAME pure field-update helpers the real committer uses, so the mock's
// fold/snapshot/validation cannot drift from electron/ops/ingest.js.
import { foldApprovedToRecords, enrichSnapshotRow, resolveFieldWrite, dbFieldFor } from './ingest/fieldUpdate.js'
// M4: same src/-may-import-electron/ops/locationId.js exception
// src/screens/locationMigrationReview.js already established — pure id
// derivation, no electron-only dependency.
import { deriveLocationId } from '../electron/ops/locationId.js'
// T306 — the SAME id derivation the real attribution op uses, so the mock's rekey
// lands a named camper on the same id the product would.
import { deriveCamperId, mintCamperId, deriveSpecialDayPlacementId } from '../electron/ops/electiveDerivedIds.js'
// T320 part 2 item 3 — the SAME derived id the real commitElectiveRun uses for
// a roster finding, so browser-dev and electron:dev agree on the row.
import { deriveElectiveRunFindingId } from '../electron/ops/deriveElectiveRunFindingId.js'
// T117 slice 2 — same src/-may-import-electron/ops/*.js pure-module exception,
// this time so :5200 can prove a version got created without a second resolver.
import { resolveImportedPlacements, describeUnresolved } from '../electron/ops/resolveImportedPlacements.js'
import { deriveScheduleTemplateId } from '../electron/ops/scheduleTemplateId.js'
import { hasContradictoryRanks } from './ingest/preferenceSheet.js'
// F8 (board item 9b round 3) — the SAME pure validator
// electron/ops/electiveRunResourceConflicts.js calls, so the mock's
// OUTER_RESOURCE_CONFLICT refusal cannot drift from the real one. Both sides
// of the src/-may-import-src exception this file already relies on
// throughout (buildPlan, resolveImportedPlacements, etc.).
import { findRouteConflicts } from './engine/routeConflicts.js'
// F8 (board item 9b round 3) — the ONE camper-tier resolution rule
// (division_label beats the roster group's tier), reused rather than
// re-derived, so the mock's BUNDLE_TIER_NOT_COVERED finding cannot disagree
// with the real one.
import { makeCamperIdentityResolver } from '../electron/ops/camperElectiveIdentity.js'
import { electiveChoiceLabelKey } from '../electron/ops/electiveDerivedIds.js'
import { coordinateOf, sameDayLabel, samePeriodLabel } from './ingest/preferenceCoordinateKeys.js'

import { parseDayOfWeek } from '../electron/ops/dayId.js'
import {
  deriveElectiveAssignmentId,
  deriveElectiveChoiceId,
  deriveElectivePreferenceId,
} from '../electron/ops/electiveDerivedIds.js'

const STORE_KEY = 'shoresh-mock-state'

// Transcribed from electron/ops/ingest.js (NAME_COLUMN / COHORT_SCOPED /
// COMPARABLE_COLUMNS) so the mock builds the SAME `existing` snapshot the real
// committer feeds buildPlan: names aliased for recognition, comparable VALUES for
// the field diff, tiers/time_blocks cohort-scoped. Same src/-never-imports-electron/
// duplication discipline as MOCK_WRITE_ALLOWLIST — a verbatim copy, not shared code.
// The tables campHasSetupData() checks — same set REQUIRED_AREAS (src/engine/
// readiness.js) treats as the blocking core, mirrored here as raw table names
// (not the getSetupGaps() key aliases) to match electron/main.js's SQL check.
const REQUIRED_SETUP_TABLES = ['tiers', 'groups', 'days_of_operation', 'time_blocks']

const MOCK_NAME_COLUMN = { days_of_operation: 'label' }
const mockNameColumnFor = (entity) => MOCK_NAME_COLUMN[entity] ?? 'name'
const MOCK_COHORT_SCOPED = new Set(['tiers', 'time_blocks'])
// S2c widens activities/groups to mirror electron's COMPARABLE_COLUMNS: the FK
// columns (eligible_group_ids, tier_id) are selected only so enrichSnapshotRow
// can resolve them to the LABEL forms buildPlan diffs (eligible_group_names,
// unit_name); the raw-id columns are never diffed directly.
const MOCK_COMPARABLE_COLUMNS = {
  cohorts: [],
  tiers: ['sort_order'],
  groups: ['availability', 'tier_id'],
  days_of_operation: ['day_of_week', 'sort_order'],
  time_blocks: ['start_time', 'end_time', 'sort_order'],
  // M4: 'location' -> 'location_id' (mirrors electron's COMPARABLE_COLUMNS).
  // max_groups_per_slot/same_tier_only (T114 co-schedule): added so a re-import
  // can actually DIFF them. Folding the inference into `fields` is not enough —
  // buildPlan only emits a field it can compare against the snapshot, so without
  // these two entries the fold was inert and a re-import silently never
  // refreshed the co-schedule values.
  //
  // Consequence worth knowing (Red Hat, T114 review): this is a NEW conflict
  // surface. A camp where a director hand-set one of these will now hold the
  // import for review when this year's grid disagrees — correct Policy A
  // behaviour, but behaviour that camp has never seen before, because these
  // columns were never written by an import until now.
  activities: ['priority', 'min_per_week', 'max_per_week', 'location_id', 'eligible_group_ids', 'max_groups_per_slot', 'same_tier_only'],
  locations: [],
}

// Per-field provenance marker, the mock's stand-in for the op-log `source`
// column the real Policy-A gate reads (electron/ops/ingest.js ~593). Keyed
// entity -> id -> field -> 'import' | 'human'. A field written by ingest is
// 'import'; a field written through the normal write()/edit path is 'human'.
// Protected iff a marker EXISTS and is not 'import' — exactly the real gate's
// `!!latestOp && latestOp.source !== 'import'`.
function fieldSourceMap(state) {
  if (!state.__fieldSource) state.__fieldSource = {}
  return state.__fieldSource
}
function markSource(state, entity, id, field, source) {
  const fs = fieldSourceMap(state)
  if (!fs[entity]) fs[entity] = {}
  if (!fs[entity][id]) fs[entity][id] = {}
  fs[entity][id][field] = source
}
function getSource(state, entity, id, field) {
  return state.__fieldSource?.[entity]?.[id]?.[field]
}

function loadState() {
  try {
    const raw = localStorage.getItem(STORE_KEY)
    if (raw) {
      const parsed = JSON.parse(raw)
      // Backfill for state saved before conflicts persistence existed.
      if (!Array.isArray(parsed.conflicts)) parsed.conflicts = []
      // Backfill for state saved before device pairing was mocked (T11).
      if (!Array.isArray(parsed.devices)) parsed.devices = seedDevices()
      // Backfill for state saved before per-field provenance existed (T74).
      if (!parsed.__fieldSource) parsed.__fieldSource = {}
      return parsed
    }
  } catch { /* fall through to default */ }
  return { camp: null, users: [], conflicts: [], devices: seedDevices(), __fieldSource: {} }
}

// Sample devices so Device Manager has something to render and its actions do
// something observable. Every name is marked "(sample)" — the dev mock is for
// evaluating layout and flow, never for concluding anything about real devices,
// and a screen that silently showed plausible-looking fake hardware would be
// worse than one that showed nothing. The sidebar's DEV badge is the other half
// of that signal (see ADR 2026-07-28).
function seedDevices() {
  const now = new Date().toISOString()
  return [
    { id: 'mock-device', name: 'This computer (sample)', pairing_status: 'authorized', authorized_at: now, revoked_at: null, last_synced_at: now },
    { id: 'mock-device-pending', name: 'Front Office iPad (sample)', pairing_status: 'pending', authorized_at: null, revoked_at: null, last_synced_at: null },
    { id: 'mock-device-paired', name: 'Kitchen Laptop (sample)', pairing_status: 'authorized', authorized_at: now, revoked_at: null, last_synced_at: now },
  ]
}

// A ready-to-review demo camp for the browser dev server, so the generated
// schedule's flag review can be iterated on at :5200 with hot-reload — no
// Electron, no native rebuild. Everything is marked "(sample)" and lives only
// in this device's localStorage; the DEV badge and this naming are the signal
// that nothing here is a real camp. Triggered by visiting `?demo=schedule`
// (see the window block at the bottom) or window.__seedDemo() from the console.
//
// Deliberately a PRE-BUILT generated week rather than a live generate: it makes
// the calm grid, the Unfillable concern box, the click-to-highlight, the hover
// reason and Accept all testable immediately. "Still needed" / "Spread"
// populate only after a real generate (findings are recomputed, never stored),
// so "Build a new week" is the way to exercise those.
function seedDemoCamp() {
  const CAMP = 'demo-camp'
  const TEMPLATE = `schedule-template:${CAMP}`
  const camp = { id: CAMP, name: 'Demo Camp (sample)' }
  const users = [
    { id: 'demo-admin', name: 'Director', pin: '1234', role: 'admin' },
    // T301 — a non-admin login so the bundle editor's role-gated Delete
    // button (admin-only; everything else stays editable regardless of
    // role) is demonstrable in the mock, not just in a unit test.
    { id: 'demo-staff', name: 'Counselor', pin: '1234', role: 'staff' },
  ]
  const cohorts = [{ id: 'main', camp_id: CAMP, name: 'Main' }]
  const tiers = [
    { id: 'tier-jr', camp_id: CAMP, cohort_id: 'main', name: 'Juniors', sort_order: 0 },
    { id: 'tier-sr', camp_id: CAMP, cohort_id: 'main', name: 'Seniors', sort_order: 1 },
  ]
  const groups = [
    { id: 'grp-1', camp_id: CAMP, name: 'Bunk 1', tier_id: 'tier-jr', availability: 'all' },
    { id: 'grp-2', camp_id: CAMP, name: 'Bunk 2', tier_id: 'tier-jr', availability: 'all' },
    { id: 'grp-3', camp_id: CAMP, name: 'Bunk 3', tier_id: 'tier-sr', availability: 'all' },
  ]
  const dayNames = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday']
  const days = dayNames.map((label, i) => ({ id: `day-${i}`, camp_id: CAMP, label, day_of_week: i + 1, sort_order: i + 1 }))
  // "Period 5" (not "Fifth Period"): T301 visual verification needs a block
  // name a per-cell preference sheet's coordinate header can resolve against
  // (preferenceCoordinateKeys.js's periodAliases only bridges a bare number to
  // "Period N"/"Block N", not to an ordinal-word block name like "Second
  // Period") — see the elective-bundle contention fixture below.
  const blockNames = ['First Period', 'Second Period', 'Third Period', 'Fourth Period', 'Period 5']
  const hh = (h) => String(h).padStart(2, '0')
  const time_blocks = blockNames.map((name, i) => ({
    id: `blk-${i}`, camp_id: CAMP, cohort_id: 'main', name, sort_order: i + 1,
    start_time: `${hh(9 + i)}:00:00`, end_time: `${hh(10 + i)}:00:00`,
  }))
  const activityNames = ['Swim', 'Art', 'Soccer', 'Drama', 'Archery']
  const activities = activityNames.map((name, i) => ({
    id: `act-${i}`, camp_id: CAMP, name, min_per_week: 2,
  }))

  // A full generated week. Every cell holds an activity except a few that the
  // engine "couldn't fill" — those carry the UNFILLABLE flag with a reason, so
  // the Unfillable box shows a real count and the highlight has cells to light.
  const unfillable = new Set(['grp-3|day-4|blk-3', 'grp-3|day-1|blk-0', 'grp-2|day-2|blk-2'])
  // T301 slice 2/3 — three cells of the week are an ELECTIVE placement
  // instead of a fixed activity, so __seedDemo() lands on something the
  // bundle-authoring control can actually demonstrate (without this, the set
  // exists but "isn't on a schedule yet" and every "+ Add bundle" trigger is
  // disabled — the feature would be invisible). Two divisions (grp-1 Juniors
  // and grp-3 Seniors both at Monday/Second Period) and two periods for
  // Juniors (Monday + Wednesday/Second Period), enough to author a real
  // cross-division, multi-period bundle.
  //
  // Thursday/Friday at Period 5 (grp-1 only) are a SEPARATE pair of cells,
  // additive to the three above, existing only so a from-scratch verification
  // script can author its OWN atomic-placement contention fixture (a bundle
  // spanning them, capacity-limited, two campers each ranking one of the two
  // cells) without disturbing the Monday/Wednesday cells or their block's
  // ordinal-word name, which an already-delivered capture script's own aria-
  // label assertions still reference verbatim.
  const ELECTIVE_SET_ID = 'eset-1'
  const electiveCells = new Set([
    'grp-1|day-0|blk-1', 'grp-3|day-0|blk-1', 'grp-1|day-2|blk-1',
    'grp-1|day-3|blk-4', 'grp-1|day-4|blk-4',
  ])
  const template_slots = []
  groups.forEach((g, gi) => {
    days.forEach((d, di) => {
      time_blocks.forEach((b, bi) => {
        const key = `${g.id}|${d.id}|${b.id}`
        const isUnfillable = unfillable.has(key)
        const isElective = electiveCells.has(key)
        template_slots.push({
          id: `slot-${key}`,
          template_id: TEMPLATE,
          group_id: g.id,
          day_id: d.id,
          time_block_id: b.id,
          activity_id: isElective || isUnfillable ? null : `act-${(gi + di + bi) % activityNames.length}`,
          elective_set_id: isElective ? ELECTIVE_SET_ID : null,
          fixed_event_id: null,
          is_fixed_event: 0,
          is_span_head: 1,
          is_released: 0,
          flags: isUnfillable
            ? { UNFILLABLE: true, UNFILLABLE_reason: 'No activity these campers can do fits here' }
            : {},
        })
      })
    })
  })

  const WEEK = `schedule-week:${CAMP}:1`
  return {
    camp, users, conflicts: [], devices: seedDevices(),
    cohorts, tiers, groups,
    days_of_operation: days,
    time_blocks,
    activities,
    locations: [],
    fixed_events: [],
    // One week; the generated schedule belongs to it (week_id). The switcher
    // renders it and "+ New Week" adds more, all in localStorage.
    schedule_weeks: [{ id: WEEK, camp_id: CAMP, name: 'Week 1', sort_order: 0, is_archived: 0 }],
    schedule_templates: [{ id: TEMPLATE, camp_id: CAMP, name: 'Generated', kind: 'generated', week_id: WEEK }],
    template_slots,
    schedule_snapshots: [],
    // T301 — a demonstrable elective set: placed on the schedule (see
    // electiveCells above), with a few offerings a director can build a
    // bundle on top of. capacity_mode/status/min_mode spelled out explicitly
    // even though SCHEMA_DEFAULTS would backfill them on a WRITE — this array
    // is returned directly as seeded state, never passed through write().
    elective_sets: [{ id: ELECTIVE_SET_ID, camp_id: CAMP, name: 'Afternoon Electives (sample)', sort_order: 0, is_reusable: 1 }],
    elective_set_activities: [
      // Drama is capacity-LIMITED to 1 (the other two offerings stay
      // uncapped) — a real, plausible value on its own, and load-bearing for
      // the T301 visual-verification contention fixture: it is what forces
      // the solver's tier 1 to CHOOSE between two campers for one bundle
      // rather than seating both.
      { id: 'esa-1', elective_set_id: ELECTIVE_SET_ID, activity_id: 'act-3', capacity_mode: 'limited', capacity_limit: 1, status: 'confirmed', min_mode: 'none', min_to_run: null },
      { id: 'esa-2', elective_set_id: ELECTIVE_SET_ID, activity_id: 'act-4', capacity_mode: 'unlimited', capacity_limit: null, status: 'confirmed', min_mode: 'none', min_to_run: null },
      { id: 'esa-3', elective_set_id: ELECTIVE_SET_ID, activity_id: 'act-1', capacity_mode: 'unlimited', capacity_limit: null, status: 'confirmed', min_mode: 'none', min_to_run: null },
    ],
    elective_bundles: [],
    elective_bundle_periods: [],
    elective_bundle_tiers: [],
  }
}

function updateDevice(deviceId, patch) {
  const state = loadState()
  const device = (state.devices || []).find((d) => d.id === deviceId)
  // Mirrors the real handler, which throws 'device not found' rather than
  // silently succeeding — the screen's error path should be reachable in dev.
  if (!device) throw new Error('device not found')
  Object.assign(device, patch)
  saveState(state)
  return device
}

function saveState(state) {
  localStorage.setItem(STORE_KEY, JSON.stringify(state))
}

function randomId() {
  return Math.random().toString(36).slice(2) + Date.now().toString(36)
}

// Schema v73 (T241) relaxed nine of these ten tables' UNIQUE(...) index to a
// plain index, so this map no longer mirrors a DB-level constraint for any of
// them — it mirrors the APP-LEVEL pre-check instead: electron/ops/
// operations.js's UNIQUE_FIELD_ENTITIES, which localWriteClient.write()
// consults (detectUniqueFieldCollision) and rejects on BEFORE appendOp ever
// runs, on the real local-write path. That pre-check is unconditional and
// blocking — it stays on the local write path deliberately (docs/superpowers/
// specs/2026-09-23-merge-unique-collision-design.md §C, "Unchanged,
// deliberately"): a duplicate created THIS way is still refused in real
// Electron, exactly as this map still refuses it here. The "two same-named
// rows coexist" outcome v73 exists for is a DIFFERENT path entirely — two
// devices independently creating the same name (different entity_ids),
// reconciled by an Automerge MERGE, never reachable through this mock's
// single-process write() — so it cannot be demonstrated in `npm run dev` by
// typing a duplicate; that needs pre-seeded colliding rows instead.
// `days_of_operation` is the one exception that is STILL a real SQLite
// UNIQUE(camp_id, day_of_week) constraint (schema.sql) — one of the four
// hard-set tables v73 deliberately left alone.
// ALSO load-bearing for camp_id auto-stamping below (`uniqueKey?.includes(
// 'camp_id')`) — do not remove an entry casually; it stamps camp_id on a
// brand-new row, not just collision detection.
// NOTE: elective_sets/events are structured-rejected ({status:'rejected',
// reason:'unique_field'}) by the REAL registry but this mock still throws raw
// for them (pre-existing, documented drift below at UNIQUE_FIELD_ENTITIES —
// their dev-mode create callers were built against the raw-throw shape).
const UNIQUE_KEYS = {
  cohorts:     ['camp_id', 'name'],
  groups:      ['camp_id', 'name'],
  activities:  ['camp_id', 'name'],
  tiers:       ['camp_id', 'cohort_id', 'name'],
  time_blocks: ['camp_id', 'cohort_id', 'name'],
  locations:   ['camp_id', 'name'],
  special_days: ['camp_id', 'name'],
  elective_sets: ['camp_id', 'name'],
  events: ['camp_id', 'name'],
  days_of_operation: ['camp_id', 'day_of_week'],
}

// Mirrors electron/ops/operations.js's UNIQUE_FIELD_ENTITIES exactly (D2,
// docs/adr/2026-08-15-locations-concurrent-create-collision.md): entity/field
// pairs whose UNIQUE(camp_id, name) collision is rejected via a structured
// {status:'rejected', reason:'unique_field', existing} result — matching the local
// direct-write path (_prior: also "handleSubmitOp's op_rejected", deleted at the
// Stage 6c cutover along with the op_rejected message) — rather than
// a thrown SQLITE_CONSTRAINT_UNIQUE-shaped Error. Every OTHER UNIQUE_KEYS
// entity above still throws raw, because it is not app-level pre-checked by
// detectUniqueFieldCollision.
//
// Guarded by uniqueFieldEntitiesMockParity.test.js so a mock entity can't drift
// from the real registry's field, and so entities that MUST reproduce the
// structured rejection in dev-mode/browser-mock (npm run dev) stay present.
// `activities` is required here — the two-rows split's concurrent-create path is
// verified in dev-mode, and without it the mock throws raw instead of rejecting.
// NOTE: elective_sets/events are structured-rejected by the REAL registry but
// deliberately NOT mirrored here yet — their dev-mode create callers were built
// against the raw-throw behavior (mock.electives.test.js pins it), so switching
// them is a separate change with its own caller-audit, tracked as known drift
// (Red Hat 2026-08-23). Exported for the parity test.
export const UNIQUE_FIELD_ENTITIES = {
  locations: 'name',
  activities: 'name',
}

// H5 (T229 round 2) — columns electron/db/schema.sql declares NOT NULL
// DEFAULT (elective_set_activities.status/capacity_mode, schema.sql:1037-
// 1049). This is a MOCK-ONLY gap, not a projection defect: the real
// electron/ops/projections.js ensureExists does
// `INSERT OR IGNORE INTO elective_set_activities (id, elective_set_id,
// activity_id) VALUES (?, ?, ?)` (projections.js:494) and SQLite materialises
// the NOT NULL DEFAULTs on that INSERT — the real row comes back with
// status:'confirmed'/capacity_mode:'unlimited' whether or not the write path
// ever named those columns. This mock has no schema behind its rows at all —
// write() below persists exactly the fields it is given — so a freshly
// created row here had NO status/capacity_mode until this fix: undefined,
// not the schema default. That silently made every new elective offering
// (ElectiveSetDetail's "Add Offering" flow writes only
// elective_set_id/activity_id) both unconfirmed AND capacity-zero to
// buildOfferings.js, but only in browser-dev — the packaged/electron:dev app
// was never affected. Stamped on new-row creation only, mirroring how
// camp_id is stamped below.
// min_mode (v80, T265) joins them for the same reason: the real INSERT
// materialises its NOT NULL DEFAULT of 'none', and a mock row reading back
// `undefined` instead would leave the minimum's authority column unset on every
// freshly created offering. min_to_run needs no default — it is nullable, and
// null IS "no minimum stated".
const SCHEMA_DEFAULTS = {
  elective_set_activities: { capacity_mode: 'unlimited', status: 'confirmed', min_mode: 'none' },
}

// Registered listeners for the mock's event-style methods (onOpApplied,
// onOpConflict, onOpRejected). Stored here — rather than left as no-ops — so
// a future test/dev session can trigger a synthetic op-applied/conflict/
// rejected event (e.g. via mockShoresh._triggerOpConflict(msg)) without
// monkey-patching this file each time.
let opAppliedListeners = []
let pairingRequestListeners = []
// Join-flow mock state (see the join* methods below).
let mockJoinWindowOpen = false
let mockJoinStarted = false
// Host-handoff mock state (docs/adr/2026-10-09-host-succession-simple.md). `npm run dev` has no second
// device, so the handoff never progresses by itself: a console/evidence session drives the states it
// wants to look at through mockShoresh._setHandoff({ handoff, lastResult, isHost, ... }).
let mockHandoff = { handoff: null, lastResult: null, isHost: true }
let handoffListeners = []
// docs/adr/2026-08-16-client-reauth-on-restart.md (T87 Part 3)
let authRejectedListeners = []
let opConflictListeners = []
let opRejectedListeners = []

// Hand-maintained, independent transcription of every PROJECTIONS[entity].fields
// in electron/ops/projections.js — deliberately NOT an import. src/ must never
// import from electron/ (that boundary is unbroken across the whole codebase;
// see CLAUDE.md/ARCHITECTURE_STANDARD.md §6), so this is a verbatim copy kept
// honest by electron/ipcSurfaceParity.test.js's drift check, not by sharing code.
// A future agent may be tempted to "just import projections.js" to eliminate
// this duplication — don't: that would be the first src/ -> electron/ import
// in the project and the drift test exists specifically so staleness here is
// loud (a failing test) rather than silent.
// Independent transcription of PARENT_SCOPED_ENTITIES's parentKey in
// electron/ops/campScopedEntities.js, for the entities C4's
// listByScope targets. Same duplication discipline as
// MOCK_WRITE_ALLOWLIST above: src/ never imports from electron/, so this is
// a verbatim copy kept honest by electron/ipcSurfaceParity.test.js's drift
// check rather than by sharing code.
export const MOCK_SCOPE_KEYS = {
  template_slots: 'template_id',
  schedule_snapshots: 'template_id',
  week_activity_exclusions: 'week_id',
  week_group_exclusions: 'week_id',
  week_location_exclusions: 'week_id',
  special_day_placements: 'week_id',
}

// T102 — emulate SQLite's INTEGER affinity, which the in-memory mock otherwise
// lacks entirely.
//
// The op log carries every value as a STRING (validateBulkReplaceRows in
// electron/ops/operations.js accepts only string/null). In the real app that
// string lands in an INTEGER column and SQLite coerces it, so the renderer
// reads back the number 1. The mock stored it verbatim, so the renderer read
// back the string "1" — and normalizeSlots' toSlotBool (src/utils/
// normalizeSlots.js) is a strict `value === 1 || value === true`, so "1"
// became FALSE.
//
// Measured 2026-09-12 on a seeded dev camp: 0 of 90 template_slots rows read
// as is_span_head, so every cell was treated as the continuation of a merged
// block. Continuations render nothing, so the schedule grid came up with no
// cells and no grid lines at all, while the stats bar correctly said
// "45 of 45 Placed". Real-app-invisible, dev-mock-fatal — which is exactly the
// divergence class T102 was filed about, though not the shape it described.
//
// Scoped to the columns the renderer reads as booleans rather than applied to
// every numeric-looking string: a camp named "2024" must stay a string.
const INTEGER_AFFINITY_FIELDS = {
  template_slots: ['is_fixed_event', 'is_span_head', 'is_released'],
}

function coerceIntegerAffinity(entity, field, value) {
  if (typeof value !== 'string') return value
  if (!INTEGER_AFFINITY_FIELDS[entity]?.includes(field)) return value
  if (!/^-?\d+$/.test(value)) return value
  return Number(value)
}

export const MOCK_WRITE_ALLOWLIST = {
  camps: ['name'],
  users: ['camp_id', 'name', 'pin_hash', 'pin_salt', 'role', 'auth_sig', 'cred_version'],
  // tombstones (T233): kept in parity with PROJECTIONS.tombstones so the dev mock does not wrongly
  // reject a tombstone field. In the real app a tombstone is minted ONLY by purgeCamperRecord (a
  // support command), never via the ordinary client write path — this allowlist entry is for dev-mock
  // parity, not an invitation to write tombstones from the UI.
  tombstones: ['entity', 'version', 'sig', 'created_at'],
  cohorts: [
    'camp_id',
    'name',
    'session_week_start',
    'session_week_end',
    'capacity_source',
    'fixed_event_model',
    'sort_order',
  ],
  groups: ['camp_id', 'name', 'tier_id', 'availability'],
  days_of_operation: ['camp_id', 'label', 'day_of_week', 'sort_order'],
  time_blocks: ['camp_id', 'cohort_id', 'name', 'start_time', 'end_time', 'part_of_day', 'sort_order'],
  tiers: ['camp_id', 'cohort_id', 'name', 'sort_order'],
  activities: [
    'camp_id',
    'name',
    'location',
    'is_outdoor',
    'is_locked',
    'max_groups_per_slot',
    'min_per_week',
    'max_per_week',
    'same_tier_only',
    'priority',
    'eligible_tier_ids',
    'eligible_group_ids',
    'prefer_before_day',
    'prefer_before_day_min',
    'weather_alternative_id',
    'notes',
    'span_blocks',
    'location_id',
    'recurrence_truth_status',
    // v75 (T266) — mirrors PROJECTIONS.activities.fields.
    'catalog_role',
  ],
  // Mirrors PROJECTIONS.locations.fields (kept honest by ipcSurfaceParity). map_id
  // is the v50 indoor/outdoor pair field; grid_x/grid_y ride along for op-log replay
  // of retired grid-builder writes.
  locations: ['camp_id', 'name', 'capacity', 'notes', 'sort_order', 'map_geometry', 'kind', 'grid_x', 'grid_y', 'map_id'],
  // M6 (docs/adr/2026-08-16-locations-optional-map.md D1) — hand-transcribed
  // mirror of PROJECTIONS.camp_maps.fields, per this file's "do not import
  // from electron/" rule (kept honest by electron/ipcSurfaceParity.test.js).
  // v50 pair extension adds `kind` (docs/adr/2026-08-26-indoor-outdoor-map-pair-and-sim-seed.md D1).
  camp_maps: ['camp_id', 'image_data', 'image_mime', 'image_width', 'image_height', 'kind'],
  // kind (v51, docs/adr/2026-08-28-fixed-vs-recurring-events.md §6) — mirror
  // of PROJECTIONS.fixed_events.fields, kept honest by
  // electron/ipcSurfaceParity.test.js's drift check like every other entry
  // in this allowlist.
  fixed_events: ['camp_id', 'cohort_id', 'day_id', 'time_block_id', 'name', 'is_all_groups', 'group_ids', 'notes', 'schedule_week_id', 'location_id', 'span_blocks', 'kind', 'unit_ids', 'activity_id'],
  week_activity_exclusions: ['week_id', 'activity_id'],
  week_group_exclusions: ['week_id', 'group_id'],
  week_location_exclusions: ['week_id', 'location_id'],
  // T40 slice 1 (docs/work/specs/2026-08-20-special-days-data-shape-design.md)
  // — hand-transcribed mirror of PROJECTIONS.special_days/
  // special_day_time_blocks/special_day_slots.fields, per this file's
  // "do not import from electron/" rule (kept honest by
  // electron/ipcSurfaceParity.test.js's drift check).
  special_days: ['camp_id', 'name', 'sort_order', 'notes'],
  special_day_time_blocks: ['special_day_id', 'name', 'sort_order', 'start_time', 'end_time'],
  special_day_slots: ['special_day_id', 'group_id', 'time_block_id', 'activity_id', 'location_id'],
  special_day_placements: ['week_id', 'day_id', 'special_day_id'],
  // T41 slice 1 (docs/work/specs/2026-08-20-group-electives-design.md) —
  // hand-transcribed mirror of PROJECTIONS.elective_sets/
  // elective_set_activities.fields, same discipline as T40 above.
  // day_id/time_block_id/is_all_groups/group_ids/schedule_week_id
  // (v43, Slice 3a) — recurring-event binding shape,
  // mirroring fixed_events' allowlist entry.
  elective_sets: [
    'camp_id', 'name', 'sort_order', 'is_reusable',
    'day_id', 'time_block_id', 'is_all_groups', 'group_ids', 'schedule_week_id',
  ],
  // Per-offering capacity. camper_headcount (v39, Electives Slice 1) was the
  // original single-number field and is deliberately ABSENT from this list.
  // v66 (T194, ADR D3): camper_headcount is RETIRED FROM THE WRITE PATH — the
  // column stays in the table but no write may reach it. capacity_mode is the
  // authority; capacity_limit is ignored entirely when mode is 'unlimited'.
  // min_mode/min_to_run (v80, T265): the minimum headcount to run, kept in
  // lockstep with PROJECTIONS.elective_set_activities.fields — a field this list
  // omits is rejected by the mock, so the browser-dev path would refuse a write
  // the real app accepts.
  elective_set_activities: [
    'elective_set_id', 'activity_id', 'capacity_mode', 'capacity_limit', 'status',
    'min_mode', 'min_to_run',
  ],
  // T301 (docs/adr/2026-09-29-linked-elective-bundles.md) — hand-transcribed
  // mirror of PROJECTIONS.elective_bundles/elective_bundle_periods/
  // elective_bundle_tiers.fields, same discipline as elective_sets above.
  elective_bundles: ['elective_set_id', 'activity_id', 'name', 'scope_mode', 'sort_order'],
  elective_bundle_periods: ['bundle_id', 'day_id', 'time_block_id'],
  elective_bundle_tiers: ['bundle_id', 'tier_id'],
  // T108 (day-overrides re-point, ADR 2026-08-21-day-overrides-repoint-
  schedule_weeks: ['camp_id', 'name', 'sort_order', 'is_archived'],
  schedule_templates: ['kind', 'camp_id', 'week_id', 'name'],
  // PROJECTIONS.schedule_snapshots.fields.
  schedule_snapshots: ['template_id', 'name', 'is_auto', 'created_at', 'slots'],
  template_slots: [
    'template_id',
    'group_id',
    'activity_id',
    'day_id',
    'time_block_id',
    'fixed_event_id',
    'is_fixed_event',
    'is_span_head',
    'is_released',
    'flags',
    // v35 (T41 slice 1, docs/work/specs/2026-08-20-group-electives-design.md)
    'elective_set_id',
    // v40 (Events overlay placement Slice 1, docs/adr/2026-08-22-events-
    // overlay-placement.md)
    'event_id',
  ],
  // Events overlay placement Slice 1 — hand-transcribed mirror of
  // PROJECTIONS.events.fields, same discipline as T40/T41 above.
  events: ['camp_id', 'name', 'sort_order', 'notes', 'location_id'],
  // Events internal sub-schedule Slice 2 (docs/adr/2026-08-22-event-
  // internal-subschedule.md) — hand-transcribed mirror of
  // PROJECTIONS.event_time_blocks/event_groups/event_slots.fields, same
  // discipline as T40/T41 above.
  event_time_blocks: ['event_id', 'name', 'sort_order', 'start_time', 'end_time'],
  event_groups: ['event_id', 'name', 'sort_order'],
  event_slots: ['event_id', 'event_group_id', 'time_block_id', 'activity_id', 'location_id'],
  // T194 participant substrate (v66). Registered here because write() THROWS on
  // an unregistered entity or field and electron/ipcSurfaceParity.test.js fails
  // on any drift from PROJECTIONS. This is a PARITY MIRROR, not a UI list — the
  // absence of a screen in this slice is not a reason to skip it.
  campers: [
    'camp_id', 'display_name', 'group_id', 'external_id', 'is_active', 'division_label',
    'is_unattributed',
  ],
  elective_assignment_runs: [
    'camp_id', 'schedule_week_id', 'schedule_template_id', 'tier_id', 'name', 'status',
    'source_filename', 'source_sha256', 'solver_version', 'solver_generation',
    // v74 (T243, docs/adr/2026-09-23-elective-run-lifecycle-and-remaining-slices.md)
    'finalized_at', 'finalized_by',
    // v83 (T320, docs/adr/2026-09-30-elective-run-durability.md item 1)
    'snapshot_expected_rows', 'snapshot_digest',
  ],
  elective_occurrences: ['run_id', 'elective_set_id', 'day_id', 'time_block_id', 'tier_id'],
  camp_seedlings: ['camp_id', 'kind', 'match_key', 'payload', 'status', 'confirmed_by', 'confirmed_at'],
  // camper_identity_keys (T321, docs/adr/2026-10-01-camper-id-high-entropy-format.md): the
  // name/external-id -> camper_id lookup table, mirrored verbatim from
  // PROJECTIONS.camper_identity_keys.fields (electron/ops/projections.js) — see
  // electron/ipcSurfaceParity.test.js for the drift check this entry satisfies.
  camper_identity_keys: ['camp_id', 'key_mode', 'key_value', 'camper_id'],
  elective_choices: ['run_id', 'label', 'is_linked'],
  elective_choice_offerings: ['choice_id', 'occurrence_id', 'activity_id'],
  // occurrence_id added v78 (T265) — a preference is per (day, period) cell.
  elective_preferences: [
    'run_id', 'camper_id', 'occurrence_id', 'choice_id', 'rank', 'rank_kind',
    'coordinate_day_label', 'coordinate_period_label',
  ],
  elective_assignments: [
    'run_id', 'occurrence_id', 'camper_id', 'activity_id', 'choice_id', 'preference_rank',
    'source', 'is_locked', 'solver_generation',
  ],
  // T243 (v74) + v76 (T197, F8 round-2 parity fix). Mirrors
  // PROJECTIONS.elective_run_outer_snapshots.fields — no write path exists yet
  // (T244+), but ipcSurfaceParity.test.js requires this parity mirror to exist
  // regardless of whether any UI writes to it today.
  elective_run_outer_snapshots: [
    'run_id', 'camper_id', 'day_id', 'time_block_id', 'activity_id',
    'activity_name', 'location_id', 'location_name', 'span_blocks', 'solver_generation',
    'cell_kind', 'choice_id', 'is_linked_choice', 'choice_label',
  ],
  // T320 (v83, docs/adr/2026-09-30-elective-run-durability.md item 4). Mirrors
  // PROJECTIONS.elective_run_findings.fields — no write path exists in the
  // mock (the mock's own commitElectiveRun degrades `findings: []`, see
  // below), but ipcSurfaceParity.test.js requires this parity mirror to
  // exist regardless.
  elective_run_findings: ['run_id', 'solver_generation', 'kind', 'camper_id', 'choice_id', 'occurrence_id', 'message', 'label_key'],
  conflicts: [],
}

// F8 (round 2): shared by finalizeElectiveRun (snapshot write) and getElectiveRunOuterSchedule's
// draft branch — mirrors electron/ops/electiveRunOuterSchedule.js's deriveElectiveRunOuterRows
// closely enough for the dev mock's OWN purpose (visual verification under `npm run dev` per
// TESTING_STANDARD; anything touching real persistence is verified under `electron:dev` instead).
// Simplifications versus the real function, both acceptable for a browser-mock fixture layer: no
// span-collapsing of adjacent inherited template_slots rows (one row per raw slot instead), and no
// F4 elective-wins-over-inherited exclusion (the mock's own seed data never creates that overlap).
function deriveMockOuterRows(state, run) {
  if (!run) return { rows: [] }
  const activityById = new Map((state.activities || []).map((a) => [a.id, a]))
  const locationById = new Map((state.locations || []).map((l) => [l.id, l]))
  const occurrenceById = new Map((state.elective_occurrences || []).map((o) => [o.id, o]))
  const choiceById = new Map((state.elective_choices || []).map((c) => [c.id, c]))

  // Mirrors electron/ops/electiveGenerationPredicate.js's electiveGenerationVisibleFragment —
  // that module is the authority; if its rule changes, this filter must change alongside it.
  const electiveRows = (state.elective_assignments || [])
    .filter((a) => a.run_id === run.id && (a.source === 'manual' || a.solver_generation === run.solver_generation))
    .map((a) => {
      const occurrence = occurrenceById.get(a.occurrence_id)
      const activity = activityById.get(a.activity_id)
      const choice = a.choice_id != null ? choiceById.get(a.choice_id) : null
      return {
        camper_id: a.camper_id,
        day_id: occurrence?.day_id ?? null,
        time_block_id: occurrence?.time_block_id ?? null,
        cell_kind: 'elective',
        activity_id: a.activity_id,
        activity_name: activity?.name ?? null,
        location_id: activity?.location_id ?? null,
        location_name: activity?.location_id != null ? locationById.get(activity.location_id)?.name ?? null : null,
        span_blocks: activity?.span_blocks ?? null,
        solver_generation: run.solver_generation ?? null,
        choice_id: a.choice_id ?? null,
        is_linked_choice: !!choice?.is_linked,
        choice_label: choice?.label ?? null,
      }
    })

  // Inherited: each camper's group's non-elective template_slots, one row per raw slot (no
  // span-collapsing — see the function comment above).
  const inheritedRows = []
  if (run.schedule_template_id != null) {
    for (const slot of state.template_slots || []) {
      if (slot.template_id !== run.schedule_template_id || slot.elective_set_id != null) continue
      const activity = slot.activity_id != null ? activityById.get(slot.activity_id) : null
      const campersInGroup = (state.campers || []).filter((c) => c.group_id === slot.group_id)
      for (const camper of campersInGroup) {
        inheritedRows.push({
          camper_id: camper.id,
          day_id: slot.day_id,
          time_block_id: slot.time_block_id,
          cell_kind: 'inherited',
          activity_id: slot.activity_id ?? null,
          activity_name: activity?.name ?? null,
          location_id: activity?.location_id ?? null,
          location_name: activity?.location_id != null ? locationById.get(activity.location_id)?.name ?? null : null,
          span_blocks: activity?.span_blocks ?? 1,
          solver_generation: null,
          choice_id: null,
          is_linked_choice: false,
          choice_label: null,
        })
      }
    }
  }

  return { rows: [...electiveRows, ...inheritedRows] }
}

export const mockShoresh = {
  async chooseMode() {
    return { mode: 'host' }
  },
  async login({ name, pin }) {
    const state = loadState()
    const user = state.users.find((u) => u.name === name && u.pin === pin)
    if (!user) return null
    return { token: `mock.${user.id}`, userId: user.id, role: user.role }
  },
  async createUser({ name, pin, role }) {
    const state = loadState()
    const user = { id: randomId(), name, pin, role }
    state.users.push(user)
    saveState(state)
    return { id: user.id, name, role }
  },
  // T163 — hand-transcribed mirror of electron/ops/promoteToAdmin.js's rule
  // (admin PINs need 6+ digits), so a dev-mode `npm run dev` session sees the
  // same refusal a real Electron session would rather than silently
  // succeeding. See that file for why this must reset the PIN, not just the
  // role.
  async promoteToAdmin({ userId, newPin } = {}) {
    if (typeof newPin !== 'string' || !/^\d{6,32}$/.test(newPin)) {
      throw new Error('PIN must be at least 6 digits for this role')
    }
    const state = loadState()
    const user = state.users.find((u) => u.id === userId)
    if (!user) throw new Error('user not found')
    user.role = 'admin'
    user.pin = newPin
    saveState(state)
    return { userId, role: 'admin' }
  },
  async bootstrapCamp({ campName, adminName, adminPin }) {
    const state = loadState()
    state.camp = { id: randomId(), name: campName }
    state.users.push({ id: randomId(), name: adminName, pin: adminPin, role: 'admin' })
    saveState(state)
    return { campId: state.camp.id, userId: state.users[state.users.length - 1].id }
  },
  // Field-level write, mirroring the real op-log/projection contract
  // (electron/ops/projections.js): each call creates-or-updates a single
  // field on one row, building a row up field-by-field. Without this the mock
  // was write-blind — `write` returned {status:'applied'} but never persisted,
  // so `list` (below) always came back empty, making it impossible to create
  // a Program/Age Division/Group/etc. in a plain `npm run dev` browser and blocking
  // Camp Setup end-to-end outside Electron.
  async write({ entity, entity_id, field, value } = {}) {
    if (!entity || !entity_id) return { status: 'applied' }

    // Mirror the real write() guard (electron/main.js): credential fields are Host-signed and must
    // only change via createUser / promoteToAdmin (Q1 fix). A generic write() to one of them would
    // produce an unsigned change the real app refuses on the merge path — reject it here too so dev
    // mode surfaces the same boundary rather than silently diverging.
    if (entity === 'users' && (field === 'pin_hash' || field === 'pin_salt' || field === 'role')) {
      throw new Error(`mockShoresh.write: users.${field} cannot be changed via write() — credential fields are Host-signed; use createUser or promoteToAdmin`)
    }
    // Mirrors main.js write() (T350): placements are written only by bindSpecialDay/unbindSpecialDay.
    if (entity === 'special_day_placements') {
      throw new Error('mockShoresh.write: special_day_placements cannot be written via write() — use the bind/unbind special day path')
    }

    // Enforcement is stricter than the real path, deliberately. The real path
    // is asymmetric: appendOp (electron/ops/operations.js) THROWS for a
    // registered entity with a bad field, but applyProjection SILENTLY
    // returns for an unregistered entity/field (electron/ops/projections.js).
    // Reproducing that silent swallow here would defeat the entire point of
    // an allowlist meant to catch dev-mode writes that would go nowhere in
    // the real app — so the mock throws for BOTH cases.
    if (field !== '__deleted__') {
      const allowedFields = MOCK_WRITE_ALLOWLIST[entity]
      if (!allowedFields) {
        throw new Error(
          `mockShoresh.write: entity '${entity}' is not in MOCK_WRITE_ALLOWLIST — register it in electron/ops/projections.js and transcribe it here (see electron/ipcSurfaceParity.test.js for the drift check).`
        )
      }
      if (!allowedFields.includes(field)) {
        throw new Error(
          `mockShoresh.write: field '${entity}.${field}' is not in MOCK_WRITE_ALLOWLIST — register it in electron/ops/projections.js and transcribe it here (see electron/ipcSurfaceParity.test.js for the drift check).`
        )
      }
    }

    const state = loadState()

    // `camps` is the singleton stored as state.camp (read by getCamp), not an
    // array — keep it consistent so a camp rename reflects everywhere.
    if (entity === 'camps') {
      if (state.camp && state.camp.id === entity_id && field !== '__deleted__') {
        state.camp = { ...state.camp, [field]: value }
        saveState(state)
      }
      return { status: 'applied' }
    }

    if (!Array.isArray(state[entity])) state[entity] = []
    const rows = state[entity]
    const idx = rows.findIndex((r) => r.id === entity_id)

    // Row-delete sentinel — see DELETE_FIELD in electron/ops/operations.js.
    if (field === '__deleted__') {
      if (idx !== -1) rows.splice(idx, 1)
      saveState(state)
      return { status: 'applied' }
    }

    // Build the candidate row. New rows get camp_id stamped from the singleton
    // camp, mirroring ensureExists (electron/ops/projections.js), so the
    // UNIQUE(camp_id, name) tuple is complete on the very first (`name`) write
    // — matching how a real collision fails atomically before an orphan row
    // exists.
    const uniqueKey = UNIQUE_KEYS[entity]
    const isNew = idx === -1
    // T205: mirror electron/ops/projections.js's days_of_operation.ensureExists
    // — stamp day_of_week at row-creation time when entity_id is a
    // deterministic day id, so the mock's UNIQUE(camp_id, day_of_week)
    // emulation is complete from the first write, exactly like camp_id above.
    // A non-deterministic (legacy) id yields null here, same as the real path.
    const base = isNew
      ? {
          id: entity_id,
          ...(SCHEMA_DEFAULTS[entity] ?? {}),
          ...(uniqueKey?.includes('camp_id') && state.camp ? { camp_id: state.camp.id } : {}),
          ...(entity === 'days_of_operation' ? { day_of_week: parseDayOfWeek(entity_id) } : {}),
        }
      : rows[idx]
    const candidate = { ...base, [field]: coerceIntegerAffinity(entity, field, value) }

    // Emulate the UNIQUE constraint: once every key field is present, reject a
    // write that would duplicate another row's key tuple. Entities registered
    // in UNIQUE_FIELD_ENTITIES (D2) get the real app-level structured
    // rejection; every other entity throws a better-sqlite3-shaped message
    // the app already matches on with /UNIQUE/i (see writeErrorMessage.js).
    if (uniqueKey && uniqueKey.every((k) => candidate[k] != null && candidate[k] !== '')) {
      const collisionRow = rows.find(
        (r) => r.id !== entity_id && uniqueKey.every((k) => r[k] === candidate[k])
      )
      if (collisionRow) {
        if (UNIQUE_FIELD_ENTITIES[entity] === field) {
          const rejection = {
            status: 'rejected',
            reason: 'unique_field',
            existing: { id: collisionRow.id, name: collisionRow.name, capacity: collisionRow.capacity, notes: collisionRow.notes },
          }
          opRejectedListeners.forEach((cb) => cb({ type: 'op_rejected', op: { entity, entity_id, field, value }, reason: rejection.reason, field, existing: rejection.existing }))
          return rejection
        }
        throw new Error(`UNIQUE constraint failed: ${entity}.${uniqueKey.join(', ' + entity + '.')}`)
      }
    }

    if (isNew) rows.push(candidate)
    else rows[idx] = candidate
    // T74: an ordinary edit is human-authored provenance (the real op-log leaves
    // source NULL for these; the mock records 'human'). This is what makes the
    // import Policy-A gate protect a hand-edited field from a re-import.
    markSource(state, entity, entity_id, field, 'human')
    saveState(state)
    return { status: 'applied' }
  },
  // T701 part 2 — the atomic setup-import primitive (electron/ops/importSetupRows.js).
  // All-or-none: apply every row's fields through the same write() path (so the
  // allowlist and UNIQUE emulation still apply), and on any failure restore the
  // pre-import snapshot so dev mode shows the same byte-identical rollback the
  // real runAtomic frame gives. Returns the primitive's result shape.
  async importSetupRows({ rows } = {}) {
    const snapshot = JSON.stringify(loadState())
    let created = 0
    let updated = 0
    let i = 0
    let row = null
    try {
      for (i = 0; i < rows.length; i++) {
        row = rows[i]
        if (row.action !== 'create' && row.action !== 'update') {
          throw new Error(`unknown action "${row.action}"`)
        }
        for (const [field, value] of Object.entries(row.fields ?? {})) {
          if (value === undefined) continue
          const res = await this.write({ entity: row.entity, entity_id: row.entity_id, field, value })
          if (res && res.status === 'rejected') {
            throw new Error('UNIQUE constraint — a record with this value already exists')
          }
        }
        if (row.action === 'create') created++
        else updated++
      }
    } catch (err) {
      saveState(JSON.parse(snapshot))
      return {
        ok: false,
        failedRow: { number: i + 1, name: row?.name ?? row?.fields?.name ?? row?.fields?.label ?? row?.entity_id, entity: row?.entity, entity_id: row?.entity_id },
        reason: err.message,
        created: 0,
        updated: 0,
      }
    }
    return { ok: true, created, updated, rowCount: created + updated }
  },
  // Wholesale delete-and-reinsert of one scope, mirroring the real
  // bulk_replace primitive (electron/ops/operations.js). The registered
  // bulk_replace entity (template_slots) is scoped
  // by template_id, so replace every row in that scope with the new set.
  async bulkReplace({ entity, scope_id, rows } = {}) {
    if (!entity) return { status: 'applied' }
    const state = loadState()
    if (!Array.isArray(state[entity])) state[entity] = []
    state[entity] = state[entity].filter((r) => r.template_id !== scope_id)
    // T102 — same INTEGER-affinity emulation as write(). bulkReplace is the
    // path a schedule REBUILD takes, so without this the grid comes back empty
    // after every generate, which is exactly how the defect presented.
    for (const row of rows || []) {
      const coerced = { ...row }
      for (const f of INTEGER_AFFINITY_FIELDS[entity] ?? []) {
        coerced[f] = coerceIntegerAffinity(entity, f, coerced[f])
      }
      state[entity].push(coerced)
    }
    saveState(state)
    return { status: 'applied' }
  },
  async verifySession({ token } = {}) {
    if (typeof token === 'string' && token.startsWith('mock.')) {
      const state = loadState()
      const userId = token.slice('mock.'.length)
      const user = state.users.find((u) => u.id === userId)
      if (user) return { valid: true, userId: user.id, role: user.role }
    }
    return { valid: false }
  },
  // Deploy smoke-test heartbeat — a no-op in the browser mock. The real marker
  // is only ever written by the packaged main process during `deploy:local`.
  async reportSmokeReady() {
    return { ok: true }
  },
  // Browser preview of the boot-recovery screen: ?bootFailure=<code>[&backupPath=<path>].
  async getBootFailure() {
    if (typeof window === 'undefined') return null
    const q = new URLSearchParams(window.location.search)
    const code = q.get('bootFailure')
    if (!code) return null
    const backupPath = q.get('backupPath')
    return backupPath ? { code, backupPath } : { code }
  },
  async quitApp() {
    return undefined
  },
  // Import committed into the localStorage-backed mock state. T74 brought this to
  // PARITY with the real committer (electron/ops/ingest.js commitIngest/commitPlan)
  // for the reconciliation flow: it builds the SAME pure ReconciliationPlan via the
  // shared `buildPlan`, then applies that plan against the mock store mirroring
  // commitPlan — recognition (name-match → unchanged, no duplicate), field diff →
  // update under the Policy-A hand-edit gate (against the mock's `__fieldSource`
  // marker), the HELD outcome `{ held, conflicts }` on any conflict (writing
  // nothing), and the T73 `resolutions` re-commit (ambiguous existing/create,
  // stale accept/keep). This lets the whole reconciliation UI — including the held
  // resolution queue — be exercised at :5200. It writes to mock state, NOT the op
  // log, so it proves the UI flow, not the real persistence/sync path (that stays
  // electron:dev): no transaction/atomicity, no seq clock.
  // D1: `dryRun` is an internal-only flag, not part of the real ingestCommit
  // IPC surface — ingestReconcile below is the only caller that passes it.
  // `state` comes from loadState(), which already deserializes a fresh copy
  // off localStorage on every call (never a live reference), so skipping the
  // final saveState() is sufficient to discard every mutation this run made —
  // CLONE-RUN-DISCARD without a second copy step.
  async ingestCommit({ approved, links, cohort_id, fixedEvents, activityRules, mode, resolutions, base_generation, dryRun = false, seenCounts, pinOnlyActivityNames, captureInverse = false, electiveHeaderFindings, activityPeriods, confirmedElectiveSets, multiBlockEvents, placements, compoundCellDecisions } = {}) {
    const state = loadState()
    if (!state.camp) throw new Error('ingest: no camp')
    // U1 Invariant 3 (docs/adr/2026-08-17-onescreen-reconciliation-undo.md) —
    // same guard as the real commitPlan, kept in parity.
    if (captureInverse && mode === 'replace') {
      throw new Error('ingestCommit: captureInverse is only supported for mode "add"')
    }
    const campId = state.camp.id
    const cohortId = cohort_id ?? null
    for (const entity of INGESTIBLE_ENTITIES) if (!Array.isArray(state[entity])) state[entity] = []
    if (!Array.isArray(state.fixed_events)) state.fixed_events = []

    // U1 mock parity. The mock has no op log, so it cannot capture opId/seq
    // the way the real committer does — instead it snapshots every row
    // BEFORE this commit runs and diffs against the after-state below: a
    // changed field on a row that existed before is an "update"
    // (invertibleOps); a row present after but absent before is a
    // "creation" (createdEntityIds). Sufficient to drive :5200's undo UI —
    // NOT a substitute for the real seq-gated "touched since" mechanism,
    // which only exists under electron:dev (CLAUDE.md's dev/mock split).
    const captureEntities = [...INGESTIBLE_ENTITIES, 'fixed_events', 'events']
    const beforeSnapshot = captureInverse
      ? Object.fromEntries(captureEntities.map((e) => [e, new Map((state[e] ?? []).map((r) => [r.id, { ...r }]))]))
      : null

    // T61 replace mode. The mock has no transaction and no op log, so this
    // simulates only the VISIBLE outcome — the old setup and everything
    // hanging off it are gone before the new records land — so that :5200 does
    // not show a camp with two of everything where Electron shows one.
    // Atomicity and rollback are the real thing's job and are verified under
    // Electron only (CLAUDE.md). cohorts is never cleared, matching
    // replaceScope's REPLACEABLE set.
    let replaced = null
    if (mode === 'replace') {
      const entityTables = ['activities', 'groups', 'time_blocks', 'days_of_operation', 'tiers']
      const dependentTables = [
        'template_slots', 'week_activity_exclusions',
        'week_group_exclusions', 'week_location_exclusions', 'fixed_events',
      ]
      replaced = { entities: {}, dependents: {} }
      for (const table of dependentTables) {
        replaced.dependents[table] = (state[table] ?? []).length
        state[table] = []
      }
      for (const table of entityTables) {
        replaced.entities[table] = (state[table] ?? []).length
        state[table] = []
      }
    }

    // The `existing` snapshot buildPlan recognizes against, mirroring the real
    // buildExistingSnapshot: names (label aliased AS name for days), comparable
    // VALUES for the field diff, tiers/time_blocks cohort-filtered. Replace mode
    // passes null so recognition is skipped and every approved name is a blind
    // create — exactly the real committer (its pre-teardown rows are gone anyway).
    // S2c §3: live id->name maps so enrichSnapshotRow can carry the FK LABEL
    // forms buildPlan compares against (shared with electron's snapshot).
    const groupNameById = new Map()
    for (const g of state.groups ?? []) groupNameById.set(g.id, g.name)
    const tierNameById = new Map()
    for (const t of state.tiers ?? []) tierNameById.set(t.id, t.name)
    // M4 §D4: locations' own id->name map, mirroring tierNameById/groupNameById.
    const locationNameById = new Map()
    for (const l of state.locations ?? []) locationNameById.set(l.id, l.name)
    // M4 §D2: locations is durable camp infrastructure — always scanned live,
    // never blind-created in replace mode (mirrors electron's
    // ALWAYS_SCANNED_ENTITIES carve-out). The six schedule-content entities
    // keep the pre-M4 behavior: skipped entirely in replace mode.
    const entitiesToScan = mode === 'replace' ? ['locations'] : INGESTIBLE_ENTITIES
    const buildSnapshot = () => {
      const existing = {}
      for (const entity of entitiesToScan) {
        const scoped = MOCK_COHORT_SCOPED.has(entity)
        const rows = (state[entity] ?? []).map((r) => {
          const row = { id: r.id, name: r[mockNameColumnFor(entity)] }
          if (scoped) row.cohort_id = r.cohort_id ?? null
          for (const c of MOCK_COMPARABLE_COLUMNS[entity]) row[c] = r[c]
          return enrichSnapshotRow(entity, row, groupNameById, tierNameById, locationNameById)
        })
        existing[entity] = scoped && cohortId ? rows.filter((r) => r.cohort_id === cohortId) : rows
      }
      return existing
    }
    const existing = buildSnapshot()

    // S2c §1: fold the rule/unit side-channels into per-row records at this
    // boundary (shared with electron), so buildPlan sees only records. `links`/
    // `activityRules` still pass through for the create path's back-compat fallback.
    const recordApproved = foldApprovedToRecords(approved, activityRules, links)

    // The PURE decision layer — the SAME buildPlan the real commitIngest uses.
    // buildPlan consumes the ambiguous_identity resolutions itself (pin identity /
    // force create); the stale resolutions are honored below in the Policy-A gate.
    const plan = buildPlan(
      { approved: recordApproved, links, activityRules, fixedEvents, camp_id: campId, cohort_id: cohortId, mode, base_generation: base_generation ?? 0, seenCounts: seenCounts ?? null, pinOnlyActivityNames: pinOnlyActivityNames ?? [], electiveHeaderFindings: electiveHeaderFindings ?? [], activityPeriods: activityPeriods ?? {} },
      existing,
      Array.isArray(resolutions) ? resolutions : [],
    )

    // Resolutions index for the stale gate (keyed entity|normalizeName|field,
    // exactly as commitPlan), plus the collision-bypass the ambiguous 'create'
    // pick needs at apply time.
    const resIndex = new Map()
    for (const r of Array.isArray(resolutions) ? resolutions : []) {
      if (!r || !r.entity) continue
      resIndex.set(`${r.entity}|${recognitionKey(r.entity, r.name)}|${r.field ?? ''}`, r)
    }
    const resolutionFor = (entity, name, field = '') => resIndex.get(`${entity}|${recognitionKey(entity, name)}|${field ?? ''}`)

    // Live-store re-resolution helpers, mirroring commitPlan.
    const liveName = (entity, id) => {
      const r = (state[entity] ?? []).find((x) => x.id === id)
      return r ? r[mockNameColumnFor(entity)] : null
    }
    const idExists = (entity, id) => (state[entity] ?? []).some((x) => x.id === id)
    const makeConflict = (item, candidateIds) => ({
      op: 'conflict', entity: item.entity, entity_id: null, reason: 'ambiguous_identity', fields: {},
      evidence: { tier: 'exact_name', candidates: candidateIds.map((id) => ({ id, name: liveName(item.entity, id) })) },
      _name: item._name,
    })
    // Stale FieldConflict shape (RECONCILIATION_PLAN_TYPE §2e). The mock has no op
    // log, so field_last_seq is null (the real committer carries latestOp.seq);
    // the director-observable shape the held UI reads (from/to/field) is identical.
    const makeStaleConflict = (item, field, delta) => ({
      op: 'conflict', entity: item.entity, entity_id: item.entity_id, reason: 'stale',
      fields: {
        [field]: {
          from: delta.from ?? null, to: delta.to, source: 'import',
          conflict: {
            reason: 'stale',
            clock: { field_last_seq: null, source_base_seq: plan.base_generation ?? 0 },
            competing: [{ value: delta.from ?? null, source: 'human' }, { value: delta.to, source: 'import' }],
          },
        },
      },
      evidence: { tier: 'exact_name', matched_name: item.evidence?.matched_name ?? item._name },
      _name: item._name,
    })
    // docs/adr/2026-09-05-unresolved-location-remembered-decisions-and-held-
    // conflict-triage-coverage.md §2 — same normalization
    // electron/ops/locationWordDecisions.js's normalizeWordKey applies
    // (duplicated here rather than imported: that module also imports
    // node:crypto for its db-writing half, which this browser-mock file
    // must not pull in).
    const normalizeLocationWordKey = (word) => String(word ?? '').trim().replace(/\s+/g, ' ').toLowerCase()
    // S2c §4: a held field conflict from the update path (validation /
    // eligibility_unresolved / unit_unresolved), same shape the real committer
    // builds. resolveFieldWrite (shared) produces the reason + detail.
    const makeFieldConflict = (item, reason, field, delta, detail) => ({
      op: 'conflict', entity: item.entity, entity_id: item.entity_id, reason,
      fields: { [field]: { from: delta.from ?? null, to: delta.to, source: 'import', conflict: { reason, ...detail } } },
      evidence: { tier: 'exact_name', matched_name: item.evidence?.matched_name ?? item._name },
      _name: item._name,
    })

    // T252: sort by id ASC and use first-write-wins, so a duplicated name (now
    // possible post-merge, schema v73) always resolves to the lowest id
    // regardless of array order — mirrors electron's seedNameMaps `ORDER BY id
    // ASC` over the in-memory arrays this mock holds instead of SQL rows.
    const byIdAsc = (rows) => [...rows].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))

    // S2c §4: name->id maps for the DECIDE-phase FK resolution (eligibility/unit),
    // seeded from existing rows exactly as commitPlan's seedNameMaps. Reused (and
    // extended) by the apply phase below, so a group created this run also resolves.
    const tierIdByName = new Map()
    for (const t of byIdAsc(state.tiers ?? [])) {
      if (t.name && (t.cohort_id ?? null) === cohortId) {
        const key = String(t.name).trim().toLowerCase()
        if (!tierIdByName.has(key)) tierIdByName.set(key, t.id)
      }
    }
    const groupIdByNameRun = new Map()
    for (const g of byIdAsc(state.groups ?? [])) {
      if (g.name) {
        const key = normalizeName(g.name)
        if (!groupIdByNameRun.has(key)) groupIdByNameRun.set(key, g.id)
      }
    }
    // M4 §D1b/§13: TRIM-only, case-sensitive keys — NOT normalizeName — matching
    // deriveLocationId's own normalization contract, mirroring electron's
    // seedNameMaps locationIdByName exactly.
    const locationIdByNameRun = new Map()
    for (const l of byIdAsc(state.locations ?? [])) {
      if (l.name) {
        const key = String(l.name).trim()
        if (!locationIdByNameRun.has(key)) locationIdByNameRun.set(key, l.id)
      }
    }

    // Recognition maps for commit-time re-resolution (normalized-name → set of
    // live ids), cohort-scoped for tiers/time_blocks exactly as the snapshot.
    // M4 §D3: recognitionKey, not bare normalizeName — case-sensitive/exact
    // for locations, mirroring electron's seedRecognitionMaps.
    const recognition = {}
    for (const entity of INGESTIBLE_ENTITIES) {
      recognition[entity] = new Map()
      const scoped = MOCK_COHORT_SCOPED.has(entity)
      for (const r of state[entity] ?? []) {
        if (scoped && cohortId && (r.cohort_id ?? null) !== cohortId) continue
        const key = recognitionKey(entity, r[mockNameColumnFor(entity)])
        if (!key) continue
        if (!recognition[entity].has(key)) recognition[entity].set(key, new Set())
        recognition[entity].get(key).add(r.id)
      }
    }

    // Decide every item and collect conflicts BEFORE writing anything (mirrors
    // commitPlan's run loop): nothing is created until we know the import isn't held.
    const created = {}
    for (const entity of INGESTIBLE_ENTITIES) created[entity] = 0
    let total = 0
    let updated = 0
    const conflicts = []
    const toCreate = []
    const toUpdate = []
    // D1c parity with ingest.js — see its own comment for why this can't just
    // be a locationIdByNameRun lookup: a location approved as its own
    // `locations` create/unchanged item THIS SAME import hasn't populated
    // locationIdByNameRun yet (that happens in commitCreate, below, after
    // this decide phase).
    const approvedLocationNames = new Set(locationIdByNameRun.keys())
    for (const it of plan.items) {
      if (it.entity === 'locations' && (it.op === 'create' || it.op === 'unchanged')) {
        approvedLocationNames.add(String(it._name).trim())
      }
    }
    for (const item of plan.items) {
      switch (item.op) {
        case 'create': {
          // Mirrors electron/ops/ingest.js's create-path location_unresolved
          // check: a brand-new activity naming a location that isn't already
          // live or approved this import must hold, not silently create
          // without it.
          if (item.entity === 'activities' && item._rule?.location != null && item._rule.location !== '') {
            const locationName = String(item._rule.location).trim()
            const declined = Array.isArray(state.__locationWordDecisions)
              && state.__locationWordDecisions.some((d) => d.word_key === normalizeLocationWordKey(locationName) && d.decision === 'not_a_place')
            if (locationName && !approvedLocationNames.has(locationName) && !declined) {
              conflicts.push(makeFieldConflict(
                item, 'location_unresolved', 'location',
                { from: null, to: item._rule.location },
                { unresolved: [item._rule.location] },
              ))
              break
            }
          }
          const ids = recognition[item.entity].get(recognitionKey(item.entity, item._name))
          if (ids && ids.size >= 1) {
            const res = resolutionFor(item.entity, item._name)
            const pinnedCreate = res?.reason === 'ambiguous_identity' && res.choice === 'create'
            const rawDuplicate = pinnedCreate && [...ids].some((id) => liveName(item.entity, id) === item._name)
            if (pinnedCreate && !rawDuplicate) toCreate.push(item)
            else conflicts.push(makeConflict(item, [...ids]))
          } else {
            toCreate.push(item)
          }
          break
        }
        case 'unchanged': {
          if (!idExists(item.entity, item.entity_id)) {
            const ids = recognition[item.entity].get(recognitionKey(item.entity, item._name))
            conflicts.push(makeConflict(item, ids ? [...ids] : []))
          }
          break
        }
        case 'update':
        case 'clear': {
          if (!idExists(item.entity, item.entity_id)) {
            if (item.evidence?.tier === 'uuid') {
              conflicts.push({ op: 'conflict', entity: item.entity, entity_id: item.entity_id ?? null, reason: 'missing_target', fields: {}, evidence: { tier: 'uuid' }, _name: item._name })
              break
            }
            const ids = recognition[item.entity].get(recognitionKey(item.entity, item._name))
            conflicts.push(makeConflict(item, ids ? [...ids] : []))
            break
          }
          // Policy-A protection gate, per FieldDelta, against the mock's
          // `__fieldSource` marker: protected iff a marker EXISTS and is not
          // 'import' (i.e. a hand-edit). A never-written or import-authored field
          // writes freely. S2c: provenance is read against the STORED column
          // (eligible_groups -> eligible_group_ids, unit -> tier_id), and the
          // value is validated/resolved via the shared resolveFieldWrite.
          for (const [field, delta] of Object.entries(item.fields)) {
            const isClear = delta.to === CLEAR
            const dbField = dbFieldFor(field)
            const row = (state[item.entity] ?? []).find((x) => x.id === item.entity_id)
            const src = getSource(state, item.entity, item.entity_id, dbField)
            // S4b §3: a clear on a never-set field (no provenance, no live value)
            // is a no-op — nothing to remove.
            if (isClear && src === undefined && (row?.[dbField] == null)) continue
            const isProtected = src !== undefined && src !== 'import'
            const res = resolutionFor(item.entity, item._name, field)
            // ADR 2026-09-05 §4 — mirrors electron/ops/ingest.js's generic
            // fallback "skip this field" action.
            if (['validation', 'eligibility_unresolved', 'unit_unresolved'].includes(res?.reason) && res.choice === 'skip') continue
            const enqueue = () => {
              if (isClear) { toUpdate.push({ item, field: dbField, value: null }); return }
              const resolved = resolveFieldWrite(field, delta.to, { groupIdByName: groupIdByNameRun, tierIdByName, locationIdByName: locationIdByNameRun })
              // docs/adr/2026-09-05-unresolved-location-remembered-decisions-and-
              // held-conflict-triage-coverage.md §3 — mirrors electron/ops/ingest.js's
              // resolution-consumption + pre-flight consult, so the mock's held
              // behavior cannot drift from the real committer's.
              if (!resolved.ok && resolved.reason === 'location_unresolved') {
                if (res?.reason === 'location_unresolved' && res.choice === 'existing' && res.location_id) {
                  toUpdate.push({ item, field: 'location_id', value: res.location_id })
                  return
                }
                if (res?.reason === 'location_unresolved' && res.choice === 'not_a_place') {
                  if (!Array.isArray(state.__locationWordDecisions)) state.__locationWordDecisions = []
                  const wordKey = normalizeLocationWordKey(delta.to)
                  if (!state.__locationWordDecisions.some((d) => d.word_key === wordKey)) {
                    state.__locationWordDecisions.push({ word_key: wordKey, raw_word: String(delta.to ?? '').trim(), decision: 'not_a_place' })
                  }
                  toUpdate.push({ item, field: 'location_id', value: null })
                  return
                }
                const declined = Array.isArray(state.__locationWordDecisions)
                  && state.__locationWordDecisions.some((d) => d.word_key === normalizeLocationWordKey(delta.to) && d.decision === 'not_a_place')
                if (declined) {
                  toUpdate.push({ item, field: 'location_id', value: null })
                  return
                }
              }
              if (!resolved.ok) conflicts.push(makeFieldConflict(item, resolved.reason, field, delta, resolved.detail))
              else toUpdate.push({ item, field: resolved.field, value: resolved.value })
            }
            if (isProtected) {
              if (res?.reason === 'stale' && res.choice === 'accept') enqueue()
              else if (res?.reason === 'stale' && res.choice === 'keep') { /* dropped — hand-edit kept */ }
              else conflicts.push(makeStaleConflict(item, field, delta))
            } else {
              enqueue()
            }
          }
          break
        }
        case 'conflict':
          if (['ambiguous_identity', 'stale', 'validation', 'eligibility_unresolved', 'unit_unresolved', 'location_unresolved', 'missing_target', 'duplicate_id', 'possible_lost_id'].includes(item.reason)) conflicts.push(item)
          else throw new Error(`mock ingestCommit: conflict reason "${item.reason}" is not implemented`)
          break
        default:
          throw new Error(`mock ingestCommit: unknown op "${item.op}"`)
      }
    }

    // Hold-the-whole-import: any conflict means the whole commit writes nothing
    // (mirrors commitPlan's HELD sentinel). Return the held outcome — clearly NOT
    // a thrown error — for the director to resolve; created counts stay zero.
    if (conflicts.length > 0) {
      return { held: true, conflicts, created, total: 0, updated: 0, fixedEvents: { created: 0, skipped: [], partial: [], moved: [] }, ...(dryRun ? { dryRun: true } : {}) }
    }

    // No conflicts — apply the plan. tierIdByName / groupIdByNameRun were seeded
    // from existing rows above (for the decide-phase FK resolution) and are
    // extended here as tiers/groups are created, so a group created this run files
    // under a unit created moments earlier — commitPlan's seedNameMaps discipline.

    // M4 §D1c mirror, corrected. An activity's location resolves ONLY
    // against a location already approved: already live, or approved as its
    // own `locations` create item THIS import (locations precedes activities
    // in INGESTIBLE_ENTITIES order, so that create already ran and populated
    // locationIdByNameRun). Mirrors electron/ops/ingest.js's
    // resolveApprovedLocationId — a lookup only, never a mint, so an
    // activity naming a location the director declined or left unresolved
    // cannot resurrect it.
    const resolveApprovedLocationId = (name) => {
      const trimmed = String(name ?? '').trim()
      if (!trimmed) return null
      return locationIdByNameRun.get(trimmed) ?? null
    }

    // commitCreate mirror: extract each FieldDelta's `to`, resolve group tier_id
    // and activity rules against the live/run name maps, insert the row, and mark
    // every written field 'import' provenance.
    const commitCreate = (item) => {
      const entity = item.entity
      const name = item._name
      // M4 §D1a mirror: deriveLocationId, never randomId, so the mock's
      // location ids agree with the real ingest path's (a director might
      // move between :5200 and electron:dev, or diff their outputs).
      const id = entity === 'locations' ? deriveLocationId(campId, name) : randomId()
      const fields = {}
      for (const [field, delta] of Object.entries(item.fields)) fields[field] = delta.to
      // T252 round 2: guarded with the SAME `if (!map.has(key))` first-write-wins
      // rule the seeding block above uses. An unconditional `.set()` here would
      // evict an already-established lowest-id winner the moment this run
      // creates another row of that name — mirrors electron/ops/ingest.js's
      // commitCreate fix.
      if (entity === 'tiers') {
        const key = name.toLowerCase()
        if (!tierIdByName.has(key)) tierIdByName.set(key, id)
      }
      if (entity === 'groups') {
        const key = normalizeName(name)
        if (!groupIdByNameRun.has(key)) groupIdByNameRun.set(key, id)
        // T257 — mirrors electron/ops/ingest.js's commitCreate: `unit` may be a
        // bare string or a discriminated token; an existing-tier token's id is
        // used directly rather than re-resolved by name.
        const unit = item._link_unit
        const unitToken = unit && typeof unit === 'object' ? unit : null
        const unitName = unitToken ? unitToken.name : unit
        const tierId = unitToken?.kind === 'existing' && unitToken.id
          ? unitToken.id
          : (unitName ? tierIdByName.get(String(unitName).trim().toLowerCase()) : null)
        if (tierId) fields.tier_id = tierId
      }
      // M4 §D1a/§D2 mirror: registered before any activities create runs.
      if (entity === 'locations') {
        const key = String(name).trim()
        if (!locationIdByNameRun.has(key)) locationIdByNameRun.set(key, id)
      }
      if (entity === 'activities') {
        // T35 — inferred/edited rules, with the same round-2 validation the real
        // write boundary applies (priority exactly 'high'/'low'; min/max positive
        // integers), resolved against the groups this same import created.
        const rule = item._rule
        if (rule) {
          if (Number.isInteger(rule.min_per_week) && rule.min_per_week >= 1) fields.min_per_week = rule.min_per_week
          if (Number.isInteger(rule.max_per_week) && rule.max_per_week >= 1) fields.max_per_week = rule.max_per_week
          if (rule.priority === 'high' || rule.priority === 'low') fields.priority = rule.priority
          const groupIds = Array.isArray(rule.eligible_group_names)
            ? rule.eligible_group_names.map((n) => groupIdByNameRun.get(normalizeName(n))).filter(Boolean)
            : []
          if (groupIds.length > 0) fields.eligible_group_ids = JSON.stringify(groupIds)
          // T61 — an eligible activity runs at least once a week or the engine
          // places it zero times. Floored on both paths, matching commitCreate.
          if (groupIds.length > 0 && !(Number.isInteger(fields.min_per_week) && fields.min_per_week >= 1)) fields.min_per_week = 1
          // M4 §D1c mirror, corrected.
          if (rule.location != null && rule.location !== '') {
            const locationId = resolveApprovedLocationId(rule.location)
            if (locationId) fields.location_id = locationId
          }
          // T114 follow-up — co-schedule parity with commitCreate
          // (electron/ops/ingest.js). Same validation: a capacity of 1 is the
          // real finding "never seen sharing a slot", so the floor is 1; and
          // same_tier_only stays OMITTED when membership was unknown rather
          // than defaulting to false, because "we could not tell" and "no,
          // groups mixed" are different answers.
          const cs = rule.co_schedule
          if (cs && Number.isInteger(cs.max_groups_per_slot) && cs.max_groups_per_slot >= 1) {
            fields.max_groups_per_slot = cs.max_groups_per_slot
          }
          if (cs && typeof cs.same_tier_only === 'boolean') {
            fields.same_tier_only = cs.same_tier_only ? 1 : 0
          }
        }
      }
      const row = { id }
      // ADR 2026-08-09 Decision 2 parity: a field the director hand-edited in
      // review is marked 'human' (from its first write) so a later re-import's
      // Policy-A gate protects it. `item._humanFields` is already stored-column
      // names (buildPlan normalized them). Everything else stays 'import'.
      const humanFields = new Set(item._humanFields ?? [])
      for (const [field, value] of Object.entries(fields)) {
        if (value === null || value === undefined) continue
        row[field] = value
        markSource(state, entity, id, field, humanFields.has(field) ? 'human' : 'import')
      }
      // M4 §D1a mirror: buildPlan never sets capacity for a locations create
      // (left to the schema's own DEFAULT 1, real ingest.js never emits a
      // capacity op either); the mock has no SQL default to fall back on, so
      // it must set the same value inline or a location created straight from
      // a `locations` create item (not the resolve-or-create branch above)
      // reads back `capacity: undefined` at :5200. Left untracked in
      // __fieldSource, same as the real path leaves it untracked in the op log.
      if (entity === 'locations' && row.capacity === undefined) row.capacity = 1
      state[entity].push(row)
      created[entity] += 1
      total += 1
    }

    // S2c §4: `field`/`value` are already the STORED column and the
    // validated/resolved value (resolveFieldWrite), so this stays a thin writer.
    const commitUpdate = ({ item, field, value }) => {
      const row = (state[item.entity] ?? []).find((x) => x.id === item.entity_id)
      if (!row) return
      row[field] = value
      // ADR 2026-08-09 Decision 2 parity (as commitCreate): a hand-edited field is
      // marked 'human'. `field` is the stored column, matching _humanFields.
      markSource(state, item.entity, item.entity_id, field, (item._humanFields ?? []).includes(field) ? 'human' : 'import')
      updated += 1
    }

    // Items are emitted in INGESTIBLE_ENTITIES order, so tiers land before groups
    // (tier_id resolvable) and groups before activities (group ids resolvable).
    for (const item of toCreate) commitCreate(item)
    for (const u of toUpdate) commitUpdate(u)

    // Recurring events (T34) — resolve by name against the rows now in state, then
    // fan out one fixed_events row per day. Mirrors commitPlan's fixed-event
    // loop so the whole import flow, recurring events included, works at :5200.
    const norm = (s) => normalizeName(s)
    const targetCohort = cohortId ?? 'main'
    // T252: sort by id ASC, first-write-wins — see byIdAsc above. time_blocks
    // and days_of_operation are never created by this run (not in
    // INGESTIBLE_ENTITIES), so rebuilding fresh here is safe for them.
    const blockIdByName = new Map()
    for (const b of byIdAsc(state.time_blocks ?? [])) {
      if (b.name && (b.cohort_id ?? null) === cohortId) {
        const key = norm(b.name)
        if (!blockIdByName.has(key)) blockIdByName.set(key, b.id)
      }
    }
    const dayIdByName = new Map()
    for (const d of byIdAsc(state.days_of_operation ?? [])) {
      if (d.label) {
        const key = norm(d.label)
        if (!dayIdByName.has(key)) dayIdByName.set(key, d.id)
      }
    }
    // Groups CAN be created by this same run (commitCreate above, entity ===
    // 'groups'), so rebuilding from `state.groups` here — post-commitCreate —
    // would re-sort a set that now includes the newly-created row, and a
    // freshly minted id that happens to sort below an already-established
    // winner would evict it. groupIdByNameRun (built before commitCreate ran,
    // seeded first-write-wins from pre-existing rows, then only ever extended
    // behind an `if (!map.has(key))` guard in commitCreate) already carries
    // the correct, eviction-proof resolution — reuse it instead of rebuilding.
    const groupIdByName = groupIdByNameRun

    if (!Array.isArray(state.fixed_events)) state.fixed_events = []
    const fixedCreatedIds = []
    const fixedSkipped = []
    const fixedPartial = []
    for (const fe of Array.isArray(fixedEvents) ? fixedEvents : []) {
      const tbId = blockIdByName.get(norm(fe.time_block))
      const requestedDays = (fe.days ?? []).length
      const dayIds = (fe.days ?? []).map((d) => dayIdByName.get(norm(d))).filter(Boolean)
      if (!tbId || dayIds.length === 0) { fixedSkipped.push({ name: fe.name, reason: 'time block or day not created' }); continue }
      const kindValue = fe.kind ?? (fe.scope?.is_all_groups ? 'fixed' : 'recurring')
      const isAll = fe.scope?.is_all_groups ? 1 : 0
      let groupIds = []
      const requestedGroups = isAll ? 0 : (fe.scope?.groups ?? []).length
      if (!isAll) {
        groupIds = (fe.scope?.groups ?? []).map((g) => groupIdByName.get(norm(g))).filter(Boolean)
        if (groupIds.length === 0) { fixedSkipped.push({ name: fe.name, reason: 'groups not created' }); continue }
      }
      // Partial resolution is written but surfaced, never silently claimed as full (ADR §1).
      const droppedDays = requestedDays - dayIds.length
      const droppedGroups = requestedGroups - groupIds.length
      if (droppedDays > 0 || droppedGroups > 0) {
        const bits = []
        if (droppedDays > 0) bits.push(`${droppedDays} of ${requestedDays} day${requestedDays === 1 ? '' : 's'}`)
        if (droppedGroups > 0) bits.push(`${droppedGroups} of ${requestedGroups} group${requestedGroups === 1 ? '' : 's'}`)
        fixedPartial.push({ name: fe.name, reason: `${bits.join(' and ')} not imported` })
      }
      for (const dayId of dayIds) {
        const id = randomId()
        state.fixed_events.push({
          id, camp_id: campId, cohort_id: targetCohort, day_id: dayId, time_block_id: tbId,
          name: String(fe.name ?? '').trim(), is_all_groups: isAll, group_ids: JSON.stringify(isAll ? [] : groupIds),
          kind: kindValue,
          // Slice B (docs/adr/2026-08-24-merged-cell-multiblock-ingest.md
          // addendum): mirrors the real commitPlan's `fe.span_blocks ?? 1`
          // default — a no-op for every fixedEvents caller that predates it.
          span_blocks: fe.span_blocks ?? 1,
        })
        fixedCreatedIds.push(id)
      }
    }

    // Slice B one-off path: ingest's first-ever `events` writer. Catalog row
    // only (surface-then-fill) — no template_slots placement, mirroring the
    // real commitPlan's dedicated multiBlockEvents block below. Red Hat HIGH
    // #1 — recognize-then-skip against any events row already live (by
    // normalized name), same as the real ingest.js's liveEventNames scan, so
    // re-confirming the same candidate on a re-import at :5200 does not mint
    // a duplicate either.
    if (!Array.isArray(state.events)) state.events = []
    const liveEventNames = new Set((state.events ?? []).map((e) => norm(e.name)))
    const multiBlockEventCreatedIds = []
    const seenEventNames = new Set()
    for (const ev of Array.isArray(multiBlockEvents) ? multiBlockEvents : []) {
      const key = norm(ev.name)
      if (!ev.name || seenEventNames.has(key)) continue
      seenEventNames.add(key)
      if (liveEventNames.has(key)) continue
      const id = randomId()
      state.events.push({ id, camp_id: campId, name: String(ev.name).trim(), notes: ev.notes ?? '' })
      multiBlockEventCreatedIds.push(id)
    }

    let invertibleOps = null
    let createdEntityIds = null
    if (captureInverse) {
      invertibleOps = []
      createdEntityIds = []
      for (const entity of captureEntities) {
        const beforeMap = beforeSnapshot[entity]
        for (const row of state[entity] ?? []) {
          const priorRow = beforeMap.get(row.id)
          if (!priorRow) {
            createdEntityIds.push({ entity, entity_id: row.id })
            continue
          }
          for (const field of Object.keys(row)) {
            if (field === 'id') continue
            const priorValue = field in priorRow ? priorRow[field] : null
            if (JSON.stringify(row[field]) !== JSON.stringify(priorValue)) {
              invertibleOps.push({
                entity, entity_id: row.id, field,
                opId: `mock:${entity}:${row.id}:${field}:${invertibleOps.length}`,
                seq: invertibleOps.length,
                priorValue,
                prior_source: state.__fieldSource?.[entity]?.[row.id]?.[field] ?? null,
              })
            }
          }
        }
      }
    }

    // Slice 3a — same authored-create shape every other mock entity uses
    // (push a plain row), never elective_set_activities. Idempotent by
    // verbatim name, same guard the real committer applies.
    const electiveSetsCreated = []
    if (!dryRun) {
      if (!Array.isArray(state.elective_sets)) state.elective_sets = []
      for (const candidate of Array.isArray(confirmedElectiveSets) ? confirmedElectiveSets : []) {
        const name = String(candidate?.name ?? '').trim()
        if (!name) continue
        if (state.elective_sets.some((r) => r.camp_id === campId && r.name === name)) continue
        const id = randomId()
        state.elective_sets.push({ id, camp_id: campId, name })
        electiveSetsCreated.push({ id, name })
      }
    }

    // T117 slice 2 — same resolveImportedPlacements pure fn the real
    // materializeImportedVersion.js calls, run against the mock's own
    // in-memory catalog + its existing schedule_snapshots/schedule_templates
    // store, so :5200 can prove a version got created. Mirrors the real
    // orchestrator's shape exactly (no schedule_weeks row -> created:false;
    // 0 resolved -> no snapshot written) but writes straight to mock state,
    // matching every other mutation in this function.
    let version = { created: false, snapshotId: null, unresolvedCount: 0, unresolvedNames: [] }
    if (!dryRun && Array.isArray(placements) && placements.length > 0) {
      const week = (state.schedule_weeks || [])
        .filter((w) => w.camp_id === campId && !w.is_archived)
        .sort((a, b) => (a.sort_order ?? 0) - (b.sort_order ?? 0))[0]
      if (!week) {
        version = { created: false, snapshotId: null, unresolvedCount: placements.length, unresolvedNames: [] }
      } else {
        if (!Array.isArray(state.schedule_templates)) state.schedule_templates = []
        if (!Array.isArray(state.schedule_snapshots)) state.schedule_snapshots = []
        let template = state.schedule_templates.find((t) => t.week_id === week.id && t.kind === 'manual')
        if (!template) {
          template = { id: deriveScheduleTemplateId(week.id, 'manual'), camp_id: campId, week_id: week.id, name: '', kind: 'manual' }
          state.schedule_templates.push(template)
        }
        // T252: sort by id ASC, first-write-wins — mirrors
        // electron/ops/materializeImportedVersion.js's nameMap() exactly, so
        // an ambiguous name resolves to the same row on :5200 as it would
        // under electron:dev.
        const nameMap = (entity) => {
          const map = new Map()
          for (const r of byIdAsc((state[entity] ?? []).filter((row) => row.camp_id === campId))) {
            const key = normalizeName(r[mockNameColumnFor(entity)])
            if (!map.has(key)) map.set(key, r.id)
          }
          return map
        }
        const maps = {
          activityIdByName: nameMap('activities'),
          fixedEventIdByName: nameMap('fixed_events'),
          groupIdByName: nameMap('groups'),
          dayIdByName: nameMap('days_of_operation'),
          blockIdByName: nameMap('time_blocks'),
        }
        const { slots, unresolved } = resolveImportedPlacements(placements, maps)
        const unresolvedItems = describeUnresolved(unresolved, (state.time_blocks ?? []).filter((b) => b.camp_id === campId))
        if (slots.length > 0) {
          const snapshotId = randomId()
          state.schedule_snapshots.push({
            id: snapshotId,
            template_id: template.id,
            name: 'Imported schedule',
            is_auto: false,
            created_at: new Date().toISOString(),
            slots: JSON.stringify(slots),
          })
          version = { created: true, snapshotId, unresolvedCount: unresolved.length, unresolvedNames: unresolved.map((u) => u.activityName), unresolvedItems }
        } else {
          version = { created: false, snapshotId: null, unresolvedCount: unresolved.length, unresolvedNames: unresolved.map((u) => u.activityName), unresolvedItems }
        }
      }
    }

    // T118 slice 4 mock parity — record confirmed compound-cell-pattern
    // decisions the same way __aliases/__declinedTwoRowSplits are recorded:
    // a plain array on mock state, no transaction/atomicity, proves the UI
    // toggle rather than real persistence (that stays electron:dev).
    let compoundCellDecisionsWritten
    if (!dryRun && Array.isArray(compoundCellDecisions) && compoundCellDecisions.length > 0) {
      if (!Array.isArray(state.__compoundCellDecisions)) state.__compoundCellDecisions = []
      let written = 0
      for (const decision of compoundCellDecisions) {
        const existingIdx = state.__compoundCellDecisions.findIndex((d) => d.pattern === decision.pattern)
        const row = {
          pattern: decision.pattern,
          interpretation: decision.interpretation,
          base_name: decision.base_name ?? null,
          wrapper_name: decision.wrapper_name ?? null,
        }
        if (existingIdx >= 0) state.__compoundCellDecisions[existingIdx] = row
        else state.__compoundCellDecisions.push(row)
        written += 1
      }
      compoundCellDecisionsWritten = { count: written, failed: [] }
    }

    if (!dryRun) saveState(state)
    const outcome = { held: false, conflicts: [], created, total, updated, fixedEvents: { created: fixedCreatedIds.length, skipped: fixedSkipped, partial: fixedPartial, moved: [] } }
    if (electiveSetsCreated.length > 0) outcome.electiveSetsCreated = electiveSetsCreated
    if (replaced) outcome.replaced = replaced
    if (dryRun) { outcome.dryRun = true; outcome.planItems = plan.items; outcome.electiveCandidates = plan.electiveCandidates }
    if (captureInverse) { outcome.invertibleOps = invertibleOps; outcome.createdEntityIds = createdEntityIds }
    if (!dryRun && Array.isArray(placements) && placements.length > 0) outcome.version = version
    if (compoundCellDecisionsWritten) outcome.compoundCellDecisionsWritten = compoundCellDecisionsWritten
    return outcome
  },

  // U1+U2 — mock parity (docs/adr/2026-08-17-onescreen-reconciliation-undo.md).
  // No op log here, so no real "touched since" gate — this applies every
  // captured field back to its priorValue unconditionally, and deletes every
  // captured creation unconditionally (no full-field gate, no referential
  // check). Good enough to drive :5200's undo affordance; the real
  // seq-gated skip / edited-since / still-referenced behavior is proven only
  // under electron:dev (CLAUDE.md's dev/mock split).
  async ingestUndo({ invertibleOps, createdEntityIds } = {}) {
    const state = loadState()
    const reverted = []
    for (const entry of Array.isArray(invertibleOps) ? invertibleOps : []) {
      const { entity, entity_id, field, priorValue } = entry
      const row = (state[entity] ?? []).find((r) => r.id === entity_id)
      if (row) {
        row[field] = priorValue
        reverted.push({ entity, entity_id, field })
      }
    }
    const deleted = []
    for (const entry of Array.isArray(createdEntityIds) ? createdEntityIds : []) {
      const { entity, entity_id } = entry
      const rows = state[entity]
      if (!Array.isArray(rows)) continue
      const idx = rows.findIndex((r) => r.id === entity_id)
      if (idx >= 0) {
        rows.splice(idx, 1)
        deleted.push({ entity, entity_id })
      }
    }
    saveState(state)
    return { ok: true, reverted, skipped: [], deleted, kept: [] }
  },

  // D1 — read-only dry run for the reconciliation summary. Runs the SAME
  // mutation logic as ingestCommit against a state object that is never
  // persisted (see the comment on ingestCommit's `dryRun` param), so :5200
  // never writes anything for this call. fieldProvenance/legacyPriorityActivities
  // are Phase C signals the mock cannot compute faithfully (no op log, no
  // import_evidence table here) — returned empty, same disclosure style as the
  // ingestCommit comment above. This is a recorded Governor/owner decision for
  // D1 (MOCK FIDELITY, docs/adr/2026-08-10-ingestion-phaseD-experience.md sub-
  // ADR), not an unqualified assertion made here.
  // clears/humanEditedFields are accepted by the real IPC surface but, like
  // ingestCommit above, the mock's decide layer doesn't consume them.
  async ingestReconcile({ approved, links, cohort_id, fixedEvents, activityRules, mode, resolutions, base_generation, seenCounts, pinOnlyActivityNames, electiveHeaderFindings, activityPeriods, multiBlockEvents } = {}) {
    const outcome = await this.ingestCommit({ approved, links, cohort_id, fixedEvents, activityRules, mode, resolutions, base_generation, seenCounts, pinOnlyActivityNames, electiveHeaderFindings, activityPeriods, multiBlockEvents, dryRun: true })
    return {
      dryRun: true,
      held: outcome.held,
      conflicts: outcome.conflicts,
      planItems: outcome.planItems ?? [],
      electiveCandidates: outcome.electiveCandidates ?? [],
      fixedEventsReport: outcome.fixedEvents,
      fieldProvenance: {},
      legacyPriorityActivities: [],
      // D3: not computed by the mock (same additive-degradation stub as
      // fieldProvenance/legacyPriorityActivities above) — the mock's ingestCommit
      // is its own reimplementation, not electron/ops/ingest.js's writeEvidence
      // path, so there is no support object to collect here.
      evidenceSupport: {},
      // 2026-08-20 ADR (per-field UNKNOWN): same stub discipline — the mock has
      // no import_evidence table, so there is nothing to read tag:'unknown'
      // rows from. buildReconciliationReport degrades additively to "nothing
      // unknown" on an empty map, matching every other Phase C/D signal above.
      unknownFieldEvidence: {},
    }
  },
  // S1b — mock stand-in for confirmAlias (electron/ops/confirmAlias.js), mirroring
  // its OBSERVABLE contract (T74 fidelity discipline) against mock state instead
  // of source_aliases: scope key is (entity_type, cohort_id, normalizeName(label))
  // among active rows; re-confirming the same scope key to a DIFFERENT target
  // supersedes the prior active row; re-confirming to the SAME target is a no-op.
  // No transaction/atomicity — proves the UI toggle, not real persistence (that
  // stays electron:dev, per this file's header discipline).
  async confirmAlias({ entity_type, cohort_id, source_label, entity_id } = {}) {
    const state = loadState()
    if (!Array.isArray(state.__aliases)) state.__aliases = []
    const scopedCohortId = MOCK_COHORT_SCOPED.has(entity_type) ? (cohort_id ?? null) : null
    const normalized = normalizeName(source_label)
    const active = state.__aliases.find(
      (a) =>
        a.status === 'active' &&
        a.entity_type === entity_type &&
        (a.cohort_id ?? null) === scopedCohortId &&
        normalizeName(a.source_label) === normalized
    )
    if (active && active.entity_id === entity_id) {
      return { id: active.id, superseded: null }
    }
    let supersededId = null
    const newId = randomId()
    if (active) {
      active.status = 'superseded'
      active.superseded_by = newId
      supersededId = active.id
    }
    state.__aliases.push({
      id: newId,
      entity_type,
      cohort_id: scopedCohortId,
      source_label,
      entity_id,
      status: 'active',
    })
    saveState(state)
    return { id: newId, superseded: supersededId }
  },
  // Slice 2a — mock stand-in for recordDeclinedSplit/listDeclinedSplitNames
  // (electron/ops/declinedSplits.js), mirroring the OBSERVABLE contract:
  // normalized names, idempotent record. No transaction/atomicity — proves
  // the UI, not real persistence (that stays electron:dev).
  async recordDeclinedSplit({ activityName } = {}) {
    const state = loadState()
    if (!Array.isArray(state.__declinedTwoRowSplits)) state.__declinedTwoRowSplits = []
    const normalized = normalizeName(activityName)
    if (!normalized) return { ok: true }
    if (!state.__declinedTwoRowSplits.includes(normalized)) {
      state.__declinedTwoRowSplits.push(normalized)
      saveState(state)
    }
    return { ok: true }
  },
  async listDeclinedSplitNames() {
    const state = loadState()
    return Array.isArray(state.__declinedTwoRowSplits) ? state.__declinedTwoRowSplits.slice() : []
  },
  // T173 slice 1 — mock stand-in for recordImportDecisions
  // (electron/ops/decisionJournal.js). Ships dark: nothing reads this back
  // yet, so the mock only proves the call is wired, not real persistence.
  async recordImportDecisions() {
    return { ok: true }
  },
  // T312 — mock stand-in for rememberColumnMapping
  // (electron/ops/rememberColumnMapping.js). Unlike recordImportDecisions above,
  // this one PERSISTS: the browser-dev path is where the import panel is
  // actually exercised, and a mock that returned ok without storing would make
  // the recall look broken on the only surface it can be demonstrated on --
  // which is the mock-stub trap this file's own header warns about.
  async rememberColumnMapping({ matchKey, payload } = {}) {
    if (!matchKey || !payload) return { ok: false, error: 'MISSING_ARGUMENT' }
    const state = loadState()
    const camp = (state.camps || [])[0]
    if (!camp) return { ok: false, error: 'NO_CAMP' }
    const id = `seed1:mock.${matchKey}`
    state.camp_seedlings = (state.camp_seedlings || []).filter((s) => s.id !== id)
    state.camp_seedlings.push({
      id,
      camp_id: camp.id,
      kind: 'preference_column_roles',
      match_key: matchKey,
      payload: JSON.stringify(payload),
      status: 'active',
      confirmed_by: null,
      confirmed_at: new Date().toISOString(),
    })
    saveState(state)
    return { ok: true, id }
  },
  // T118 slice 4 — mock stand-in for listCompoundCellDecisions
  // (electron/ops/ingest.js), returning entries in the same [pattern, value]
  // shape the real IPC boundary does (localClient.js re-wraps into a Map).
  async listCompoundCellDecisions() {
    const state = loadState()
    const rows = Array.isArray(state.__compoundCellDecisions) ? state.__compoundCellDecisions : []
    return rows.map((d) => [d.pattern, { interpretation: d.interpretation, base_name: d.base_name, wrapper_name: d.wrapper_name }])
  },
  // S4b §4 — the dev mock has no op log/seq clock, so the export stamps 0 and
  // the staleness gate is inert at :5200 (the real clock lives under electron:dev).
  async latestOpSeq() { return 0 },
  // Browser preview of the can't-reach-the-camp flag: ?syncFlag=unreachable.
  async getSyncStatus() {
    if (typeof window !== 'undefined' && new URLSearchParams(window.location.search).get('syncFlag') === 'unreachable') {
      return { mode: 'client', connected: false, state: 'client-disconnected', unsharedWrites: 0, lowDisk: false, otherDeviceCount: 1, peersUnreachable: true }
    }
    return { mode: null, connected: false, state: 'standalone' }
  },
  // T359 slice 4 - browser preview of the router-opening flag: ?portMapping=<status> (null otherwise,
  // which is also what the real getter returns while SHORESH_PUNCH_ENABLED is off).
  async getPortMappingStatus() {
    if (typeof window === 'undefined') return null
    const status = new URLSearchParams(window.location.search).get('portMapping')
    if (!status) return null
    return status === 'permanent-lease'
      ? { status, reason: 'this router keeps the opening after Shoresh quits' }
      : { status }
  },
  // T275 — mock stand-in for the retry affordance. The mock's getSyncStatus
  // above is a fixed 'standalone' with no starter to re-invoke, so this is a
  // no-op ack, matching the real handler's shape when no starter is wired.
  async retrySync() {
    return { ok: true }
  },
  onSyncStatusChanged() {
    return () => {}
  },
  onOpApplied(cb) {
    if (typeof cb === 'function') opAppliedListeners.push(cb)
    return () => { opAppliedListeners = opAppliedListeners.filter((l) => l !== cb) }
  },
  onOpConflict(cb) {
    if (typeof cb === 'function') opConflictListeners.push(cb)
    return () => { opConflictListeners = opConflictListeners.filter((l) => l !== cb) }
  },
  // docs/adr/2026-08-15-locations-concurrent-create-collision.md — mirrors
  // onOpConflict's exact shape.
  onOpRejected(cb) {
    if (typeof cb === 'function') opRejectedListeners.push(cb)
    return () => { opRejectedListeners = opRejectedListeners.filter((l) => l !== cb) }
  },
  // Test/dev-only helpers — not part of the real window.shoresh contract,
  // used to synthesize events for manual/automated UI verification of
  // screens like ConflictsScreen outside Electron.
  _triggerOpApplied(op) {
    opAppliedListeners.forEach((cb) => cb(op))
  },
  // Persists the conflict into localStorage-backed mock state (mirroring the
  // real app's `conflicts` sqlite table, per Fix 3) in addition to firing the
  // live listener, so a page reload with no listener attached yet still sees
  // it via listPendingConflicts() below — this is what lets the restart/
  // rehydration scenario be exercised outside Electron.
  _triggerOpConflict(msg) {
    const state = loadState()
    state.conflicts.push(msg)
    saveState(state)
    opConflictListeners.forEach((cb) => cb(msg))
  },
  async getCamp() {
    return loadState().camp
  },
  // Mirrors electron/main.js's 'shoresh:camp-has-setup-data' handler — same
  // required-area table set (docs/adr/2026-08-28-stage-aware-nav-landing.md
  // Decision 1: tiers/groups/days_of_operation/time_blocks), so the browser-
  // mock dev path (localhost:5200) lands on the same screen the real app
  // would for the same camp state.
  async campHasSetupData() {
    const state = loadState()
    return REQUIRED_SETUP_TABLES.some((table) => Array.isArray(state[table]) && state[table].length > 0)
  },
  // token param intentionally unnamed — the mock has no role model to check
  // against, but the real preload bridge (electron/preload.js) always sends
  // token as the first arg now that these are authorize()-gated in
  // electron/main.js, so the signature still accepts (and ignores) it.
  async listUsers() {
    return loadState().users.map((u) => ({ id: u.id, name: u.name, role: u.role }))
  },
  async list(_token, entity) {
    const state = loadState()
    if (!Array.isArray(state[entity])) return []
    return state[entity]
  },
  async listByScope(_token, entity, scopeId) {
    const state = loadState()
    const key = MOCK_SCOPE_KEYS[entity]
    if (!key || !Array.isArray(state[entity])) return []
    return state[entity].filter((row) => row[key] === scopeId)
  },
  // T105 §2 — mirrors listDurableElectiveSetsHandler (electron/main.js):
  // is_reusable = 1 rows only, never the unfiltered list('elective_sets').
  async listDurableElectiveSets() {
    const state = loadState()
    return (state.elective_sets || []).filter((s) => s.is_reusable === 1)
  },
  // T227 — mirrors commitElectiveRunHandler / listElectiveRunsHandler /
  // getElectiveRunHandler (electron/main.js).
  //
  // The REFUSAL is mirrored faithfully, not stubbed away: a same-name
  // collision must block in browser-dev exactly as it blocks in the real app,
  // because that refusal is the behaviour a director will meet first and the
  // one most worth seeing while building the screen. The op-log write is what
  // degrades here (the mock has no operations table) — same additive-
  // degradation discipline as the stubs around this one.
  async commitElectiveRun({
    name, parsed, assignments = [], sourceFilename = null,
    occurrences = [], scheduleWeekId = null, scheduleTemplateId = null, runId: providedRunId = null,
    // board-freeze-residuals item 4 — accepted and ignored, same additive-
    // degradation posture as the op-log write above: the mock has no
    // elective_run_findings table to persist into, and this only needs to
    // accept the shape the real IPC call now also accepts.
    findings: _findings = [],
  } = {}) {
    const sameName = parsed?.sameNameCampers ?? []
    if (sameName.length > 0) {
      const who = sameName.map((c) => `${c.display_name} (rows ${c.rowNumbers.join(', ')})`).join('; ')
      const noun = sameName.length === 1 ? 'camper name appears' : 'camper names appear'
      return {
        ok: false,
        error:
          `${sameName.length} ${noun} on more than one row with no camper id to tell them apart: ${who}. ` +
          'Resolve these before importing — two children sharing a name would be merged into one record.',
      }
    }
    // Mirrors the real commitElectiveRunHandler's other refusal (T229 parity
    // fix): a same-rank collision must block in browser-dev exactly as it
    // blocks under electron:dev.
    if (hasContradictoryRanks(parsed)) {
      return {
        ok: false,
        error: 'a camper holds the same preference rank twice — the sheet cannot be read unambiguously.',
      }
    }
    const state = loadState()
    // M2 (Red Hat round 4) — captured BEFORE `state.campers = parsed.campers
    // ?? []` below overwrites it, so the bundle-mismatch resolution further
    // down (which runs AFTER that overwrite) can still pass the PRE-commit
    // roster to makeCamperIdentityResolver as `rosterCampers` — the same
    // argument electron/ops/commitElectiveRun.js passes. Without this, a
    // sheet with a blank Division cell for a camper who already has one on
    // the roster resolves differently here than in Electron.
    const rosterCampersForIdentity = state.campers || []
    const existing = (state.elective_assignment_runs || []).find((r) => r.id === providedRunId)
    // T320 part 2 item 2 parity — without this, browser-dev lets a regenerate
    // through that electron:dev refuses, which is the exact divergence the
    // T229 parity note above exists to prevent.
    if (existing?.status === 'final') return { ok: false, error: 'RUN_IS_FINAL' }
    const runId = providedRunId ?? `run-${(state.elective_assignment_runs || []).length + 1}`
    const distinctTierIds = new Set(occurrences.map((o) => o.tier_id).filter((t) => t != null))
    const tierId = distinctTierIds.size === 1 ? [...distinctTierIds][0] : null
    const runRow = {
      id: runId, name, status: 'draft', source_filename: sourceFilename, solver_version: 'mock',
      schedule_week_id: scheduleWeekId, schedule_template_id: scheduleTemplateId, tier_id: tierId,
    }
    // H1 parity — a retried commit of the SAME solve (same runId) replaces
    // this run's row rather than appending a second one, matching the real
    // op-log's per-field last-write-wins on one record.
    state.elective_assignment_runs = existing
      ? (state.elective_assignment_runs || []).map((r) => (r.id === runId ? runRow : r))
      : [...(state.elective_assignment_runs || []), runRow]
    state.elective_occurrences = [
      ...(state.elective_occurrences || []).filter((o) => o.run_id !== runId),
      ...occurrences.map((occ) => ({ ...occ, run_id: runId })),
    ]
    state.campers = parsed.campers ?? []
    // Declared before BOTH consumers below (the assignment rows' choice_id and the
    // preference rows' own), so the ordering cannot silently make one undefined.
    const choiceIdByKey = new Map(
      (parsed.choices ?? []).map((ch) => [ch.labelKey, deriveElectiveChoiceId(runId, ch.labelKey)])
    )
    // T297 — `choice_id` is DERIVED here, as the real commitElectiveRun derives it
    // from the solver's labelKey, because it is the only link between a placement
    // and the preference behind it. The mock previously spread the solver row
    // as-is, so `choice_id` was undefined on every assignment: the camper-week
    // panel then found no preference to correct and offered an ADD where the real
    // path performs a REPLACE. Caught by visual verification at :5241 — the two
    // paths have to agree or browser-dev shows a working screen over the wrong
    // behaviour.
    state.elective_assignments = assignments.map((a, i) => ({
      id: `${runId}-${i}`,
      run_id: runId,
      ...a,
      choice_id: a.choice_id ?? choiceIdByKey.get(a.labelKey) ?? null,
    }))
    // T297 — the mock now persists CHOICES and PREFERENCES too, using the real
    // derived ids. Before this it stored neither, so the camper-week edit
    // surface had no preference to edit and `npm run dev` could not show the
    // feature at all — the one thing browser-dev visual verification is for.
    state.elective_choices = [
      ...(state.elective_choices || []).filter((c) => c.run_id !== runId),
      ...(parsed.choices ?? []).map((ch) => ({
        id: deriveElectiveChoiceId(runId, ch.labelKey), run_id: runId, label: ch.label, is_linked: 0,
      })),
    ]
    state.elective_preferences = [
      ...(state.elective_preferences || []).filter((pr) => pr.run_id !== runId),
      ...(parsed.preferences ?? [])
        .filter((pr) => choiceIdByKey.has(pr.labelKey))
        .map((pr) => {
          const choiceId = choiceIdByKey.get(pr.labelKey)
          return {
            id: deriveElectivePreferenceId(runId, pr.camper_id, pr.occurrence_id ?? null, choiceId, pr.coordinate ?? null),
            run_id: runId,
            camper_id: pr.camper_id,
            occurrence_id: pr.occurrence_id ?? null,
            choice_id: choiceId,
            rank: pr.rank ?? null,
            rank_kind: pr.rank_kind ?? null,
            coordinate_day_label: pr.coordinate?.dayName ?? null,
            coordinate_period_label: pr.coordinate?.periodLabel ?? null,
          }
        }),
    ]
    // F8 (board item 9b round 3) — BUNDLE_TIER_NOT_COVERED parity. The mock
    // had NO concept of elective_bundles at all, so this finding (and
    // DraftRunView's whole C1 grouped-mismatch row) could never be reached
    // through browser-dev. Mirrors the ONE resolution rule
    // (camperElectiveIdentity.js's makeCamperIdentityResolver — division
    // beats the roster group's tier), deliberately scoped to scope_mode
    // 'only' (the common case this mock needs to demonstrate); 'except'
    // mode is not modeled here — a real gap worth closing if browser-dev
    // ever needs to demonstrate that scope too, not silently guessed at.
    const bundleTierMismatches = []
    const bundles = state.elective_bundles || []
    if (bundles.length > 0) {
      const identity = makeCamperIdentityResolver({
        sheetCampers: parsed.campers ?? [], rosterCampers: rosterCampersForIdentity,
        groups: state.groups || [], tiers: state.tiers || [],
      })
      const bundleTiersByBundleId = new Map()
      for (const bt of (state.elective_bundle_tiers || [])) {
        if (!bundleTiersByBundleId.has(bt.bundle_id)) bundleTiersByBundleId.set(bt.bundle_id, new Set())
        bundleTiersByBundleId.get(bt.bundle_id).add(bt.tier_id)
      }
      const bundleByLabelKey = new Map(
        bundles.filter((b) => b.scope_mode === 'only').map((b) => [electiveChoiceLabelKey(b.name), b])
      )
      for (const pr of (parsed.preferences ?? [])) {
        const bundle = bundleByLabelKey.get(pr.labelKey)
        if (!bundle) continue
        const coveredTiers = bundleTiersByBundleId.get(bundle.id) ?? new Set()
        const camperTierId = identity.tierIdOf(pr.camper_id)
        if (camperTierId != null && coveredTiers.has(camperTierId)) continue
        bundleTierMismatches.push({
          kind: 'BUNDLE_TIER_NOT_COVERED', camper_id: pr.camper_id, label: pr.label ?? pr.labelKey, tier_id: camperTierId ?? null,
          // board item 9b round 3 (item 3) parity — the SAME choice_id the
          // preference row above was bound to (choiceIdByKey.get(pr.labelKey)),
          // so the persisted finding below can carry it, mirroring
          // production's resolveWriteChoiceId/noteMismatch.
          choice_id: choiceIdByKey.get(pr.labelKey) ?? null,
        })
      }
    }
    // T320 part 2 item 3 parity — the run's camper universe. One finding row per
    // sheet camper this commit has neither a preference nor an assignment for,
    // so browser-dev's getElectiveRun widens exactly as production's does. The
    // mock has no solver_generation machinery, so the generation component is a
    // fixed literal — the roster read filters on kind, never on generation.
    const mockGeneration = 'mock'
    const placedOrRanked = new Set([
      ...(state.elective_preferences || []).filter((pr) => pr.run_id === runId).map((pr) => pr.camper_id),
      ...(state.elective_assignments || []).filter((a) => a.run_id === runId).map((a) => a.camper_id),
    ])
    // board item 9b round 3 (item 3) parity — BUNDLE_TIER_NOT_COVERED now
    // persists too, same full-replace-on-recommit treatment as
    // SHEET_CAMPER_WITHOUT_PREFERENCE below: this mock has no real per-commit
    // generation counter (a fixed 'mock' literal), so replacing every row of
    // both kinds for this runId on each commit and rewriting only the
    // CURRENT commit's set is equivalent in effect to production's
    // generation-filtered read — a regenerate shows only the current
    // mismatches, never an accumulation of stale ones. NO tier_id (no such
    // column, mirrored from production — groupBundleTierNotCoveredFindings
    // already re-derives it) and NO camper name in `message` (same privacy
    // posture as the roster kind's persisted message; the name is resolved
    // on the read side).
    state.elective_run_findings = [
      ...(state.elective_run_findings || []).filter(
        (f) => !(f.run_id === runId && (f.kind === 'SHEET_CAMPER_WITHOUT_PREFERENCE' || f.kind === 'BUNDLE_TIER_NOT_COVERED'))
      ),
      ...(parsed.campers ?? [])
        .filter((c) => !placedOrRanked.has(c.id))
        .map((c) => ({
          id: deriveElectiveRunFindingId(runId, mockGeneration, 'SHEET_CAMPER_WITHOUT_PREFERENCE', c.id, null, null),
          run_id: runId,
          solver_generation: mockGeneration,
          kind: 'SHEET_CAMPER_WITHOUT_PREFERENCE',
          message:
            'This camper was on the sheet but has no ranked choice and no placement on this run. ' +
            'They are still counted when it is regenerated.',
          camper_id: c.id,
          choice_id: null,
          occurrence_id: null,
        })),
      ...bundleTierMismatches.map((m) => ({
        id: deriveElectiveRunFindingId(runId, mockGeneration, 'BUNDLE_TIER_NOT_COVERED', m.camper_id, m.choice_id ?? null, null),
        run_id: runId,
        solver_generation: mockGeneration,
        kind: 'BUNDLE_TIER_NOT_COVERED',
        message:
          'This camper is linked to a choice that a bundle claims for specific divisions only, and ' +
          'their own division is not one of them — so it was kept as an ordinary choice for them ' +
          'instead of as part of the bundle. Their ranking still counts; nothing else on the sheet ' +
          'was affected.',
        camper_id: m.camper_id,
        choice_id: m.choice_id ?? null,
        occurrence_id: null,
      })),
    ]
    saveState(state)
    return {
      ok: true,
      runId,
      // T320 — this still degrades to [] at COMMIT time (the mock has no
      // occurrence-diff pass to compute DANGLING_MANUAL_ASSIGNMENT here), but
      // that gap is now closed one layer up: getElectiveRun's own read-time
      // filter (above) derives it from state.elective_assignments/
      // elective_occurrences, which THIS commit's full-replace of
      // elective_occurrences already produces correct input for — so the
      // mock's DraftRunView still shows the row, just not from this field.
      // F8 — BUNDLE_TIER_NOT_COVERED mismatches computed above are the one
      // kind this mock DOES compute at commit time (unlike
      // DANGLING_MANUAL_ASSIGNMENT, degraded to [] per the comment above).
      findings: bundleTierMismatches,
      counts: {
        campers: parsed.campers?.length ?? 0,
        choices: parsed.choices?.length ?? 0,
        preferences: parsed.preferences?.length ?? 0,
        assignments: assignments.length,
      },
    }
  },
  // C3 (board item 9b) — mirrors electron/main.js's listElectiveRunsHandler
  // read-side LEFT JOIN: `finalized_by_name` off `state.users`, so browser-dev
  // (what Tester drives) matches electron:dev rather than the raw id reaching
  // RunIdentity. `?? null`, never left undefined — a run naming no users row
  // (the row is gone, or this is a legacy run) resolves to null, same as the
  // real SQL LEFT JOIN's no-match NULL.
  async listElectiveRuns() {
    const state = loadState()
    const nameByUserId = new Map((state.users || []).map((u) => [u.id, u.name]))
    return (state.elective_assignment_runs || []).map((r) => ({
      ...r,
      finalized_by_name: r.finalized_by ? nameByUserId.get(r.finalized_by) ?? null : null,
    }))
  },
  // T244 — the shape changed from a bare array to an object
  // ({rows, staleCount, finalizedAgainstStaleGeneration, overCapacityOccurrences},
  // electron/main.js's getElectiveRunHandler). The mock has no
  // solver_generation/capacity machinery to mirror faithfully (no op-log,
  // no elective_set_activities capacity lookup wired here) — same additive-
  // degradation discipline as the stubs around this one: rows are still
  // real, the three new fields degrade to their "nothing to report" values
  // rather than being silently omitted, so a caller destructuring the real
  // shape doesn't crash in browser-dev.
  // T296 adds `occurrences`, and unlike the three degraded fields this one is
  // mirrored FAITHFULLY: the mock already stores elective_occurrences rows, and
  // a week that could not name its own days is the exact thing browser-dev
  // visual verification exists to catch.
  async getElectiveRun({ runId } = {}) {
    const state = loadState()
    const byId = new Map((state.campers || []).map((c) => [c.id, c.display_name]))
    const rows = (state.elective_assignments || [])
      .filter((a) => a.run_id === runId)
      .map((a) => ({ ...a, camper_name: byId.get(a.camper_id) ?? null }))
    const occurrences = (state.elective_occurrences || [])
      .filter((o) => o.run_id === runId)
      .map((o) => ({
        id: o.id, elective_set_id: o.elective_set_id, day_id: o.day_id,
        time_block_id: o.time_block_id, tier_id: o.tier_id,
      }))
    // T297 — same fold from the two coordinate COLUMNS back into the single
    // `coordinate` property the engine and resolvePreferenceCoordinates read
    // (electron/main.js's getElectiveRunHandler). Mirrored faithfully, not
    // degraded: a re-solve reads this, so an empty list here would look exactly
    // like a camp whose campers asked for nothing.
    const preferences = (state.elective_preferences || [])
      .filter((pr) => pr.run_id === runId)
      .map((pr) => ({
        id: pr.id,
        camper_id: pr.camper_id,
        choice_id: pr.choice_id,
        occurrence_id: pr.occurrence_id,
        rank: pr.rank,
        rank_kind: pr.rank_kind,
        coordinate: coordinateOf(pr),
      }))
    const choices = (state.elective_choices || [])
      .filter((c) => c.run_id === runId)
      .map((c) => ({ id: c.id, label: c.label, is_linked: c.is_linked ?? 0 }))
      .sort((a, b) => String(a.label).localeCompare(String(b.label)))
    // 1A (docs/work/specs/2026-10-02-elective-run-mismatch-null-identity-and-anchor-design.md)
    // — faithfully mirrored: the mock already stores elective_choice_offerings
    // rows (used by the bundle-tier-mismatch commit logic above), so this is
    // the same choice_id -> [occurrence_id, ...] map electron/ops/getElectiveRun.js
    // reads from the real table.
    const choiceIds = new Set(choices.map((c) => c.id))
    const offeringOccurrencesByChoiceId = {}
    for (const o of state.elective_choice_offerings || []) {
      if (!choiceIds.has(o.choice_id) || o.occurrence_id == null) continue
      (offeringOccurrencesByChoiceId[o.choice_id] ??= []).push(o.occurrence_id)
    }
    // T250 A0.2 — faithfully mirrored: every camper with a preference or an
    // assignment on this run, group name resolved.
    const groupById = new Map((state.groups || []).map((g) => [g.id, g.name]))
    // T320 part 2 item 3 — the third arm, mirrored: the universe is the SHEET's
    // own, not one derived from what the run happened to produce. NOT filtered
    // by solver_generation (a roster is cumulative), same as production.
    const sheetOnlyCampers = [...new Set(
      (state.elective_run_findings || [])
        .filter((f) => f.run_id === runId && f.kind === 'SHEET_CAMPER_WITHOUT_PREFERENCE' && f.camper_id != null)
        .map((f) => f.camper_id)
    )]
    const camperIdsWithPrefOrAssignment = new Set([
      ...(state.elective_preferences || []).filter((p) => p.run_id === runId).map((p) => p.camper_id),
      ...(state.elective_assignments || []).filter((a) => a.run_id === runId).map((a) => a.camper_id),
      ...sheetOnlyCampers,
    ])
    const campers = (state.campers || [])
      .filter((c) => camperIdsWithPrefOrAssignment.has(c.id))
      .map((c) => ({
        id: c.id, display_name: c.display_name, division_label: c.division_label ?? null,
        group_id: c.group_id ?? null, external_id: c.external_id ?? null,
        is_unattributed: c.is_unattributed ?? null, group_name: groupById.get(c.group_id) ?? null,
      }))
    // T320 (docs/adr/2026-09-30-elective-run-durability.md item 2) — the mock's
    // commitElectiveRun already fully replaces state.elective_occurrences for
    // this runId on every commit (see below), which is a STRONGER prune than
    // production needs but produces an identical end state for this filter's
    // purpose: a manual row pointing at an occurrence no longer in that set.
    const liveOccurrenceIds = new Set((state.elective_occurrences || []).filter((o) => o.run_id === runId).map((o) => o.id))
    const danglingFindings = (state.elective_assignments || [])
      .filter((a) => a.run_id === runId && a.source === 'manual' && !liveOccurrenceIds.has(a.occurrence_id))
      .map((a) => ({
        kind: 'DANGLING_MANUAL_ASSIGNMENT', assignment_id: a.id, camper_id: a.camper_id, occurrence_id: a.occurrence_id,
        message:
          'A placement made by hand sits in a period this schedule no longer has, so nobody will see ' +
          'it on the grid — move it to a period that still exists, or remove it.',
      }))
    // T320 item 4 — the mock has no generation-filter machinery wired here
    // (same additive-degradation posture as staleCount/overCapacityOccurrences
    // above); returns every persisted finding for this run rather than
    // filtering by solver_generation.
    // The roster kind is excluded so the eligibility bucket keeps its meaning,
    // exactly as production's read does; it is surfaced as sheetOnlyCampers.
    //
    // board item 9b round 3 (item 3) parity — `label` recovered via a join on
    // `choice_id` against `state.elective_choices`, mirroring getElectiveRun.js's
    // LEFT JOIN (no column stores the label; a persisted BUNDLE_TIER_NOT_COVERED
    // finding has none otherwise).
    const choiceLabelById = new Map((state.elective_choices || []).map((c) => [c.id, c.label]))
    const eligibilityFindings = (state.elective_run_findings || [])
      .filter((f) => f.run_id === runId && f.kind !== 'SHEET_CAMPER_WITHOUT_PREFERENCE')
      .map((f) => ({ ...f, label: f.choice_id != null ? choiceLabelById.get(f.choice_id) ?? null : null }))
    // T320 round 2, F1 — snapshotIncomplete: false is an HONEST value here,
    // not a degraded stand-in for the real computeSnapshotCompleteness digest
    // check: this mock's finalizeElectiveRun (below) always writes the
    // COMPLETE outer-snapshot set synchronously, in one call, with no sync
    // layer in between that could leave a row partially written — there is
    // no partial-sync state this single-device browser mock can ever be in.
    // (This is unrelated to, and was not the cause of, F1's real bug: the
    // production digest mismatched on its own is_linked_choice boolean/
    // integer type, which this mock's plain-object rows never encounter.)
    return {
      rows, occurrences, preferences, choices, offeringOccurrencesByChoiceId, campers, sheetOnlyCampers,
      staleCount: 0, finalizedAgainstStaleGeneration: false,
      overCapacityOccurrences: [], danglingFindings, eligibilityFindings, resourceConflicts: [],
      snapshotIncomplete: false, expectedSnapshotRows: null, heldSnapshotRows: null,
    }
  },
  // T244 — mirrors finalizeElectiveRunHandler's success/ALREADY_FINAL shape.
  // The mock has no template_slots-derived occurrence diff and no
  // routeConflicts pass to run, so STALE_OUTER_SCHEDULE/OUTER_RESOURCE_CONFLICT
  // never fire here (same additive-degradation posture as commitElectiveRun's
  // op-log write above) — the refusal a director actually needs to see while
  // building the screen is ALREADY_FINAL, which this does mirror faithfully.
  // F8 (round 2): brought to v76 parity — snapshot rows now carry cell_kind/choice_id/
  // is_linked_choice/choice_label, and inherited (group-template) rows are written too, mirroring
  // deriveElectiveRunOuterRows' shape closely enough for the dev-mock's own purpose (visual
  // verification under `npm run dev`), even though it does not reimplement that function's
  // span-collapsing.
  async finalizeElectiveRun({ runId } = {}) {
    const state = loadState()
    const run = (state.elective_assignment_runs || []).find((r) => r.id === runId)
    if (!run) return { ok: false, error: 'run not found' }
    if (run.status === 'final') return { ok: false, error: 'ALREADY_FINAL' }
    // F8 (board item 9b round 3) — mirrors electron/ops/
    // electiveRunResourceConflicts.js's mapTemplateSlot + findRouteConflicts
    // call: scope this run's own template_slots to its own occurrences'
    // (day, block) cells, map to the shape findRouteConflicts expects, and
    // refuse BEFORE writing 'final' when combined occupancy at any
    // location/day/block exceeds that location's capacity. Mock/seed
    // behavior only — no production (electron) code touched.
    const cellKeys = new Set(
      (state.elective_occurrences || [])
        .filter((o) => o.run_id === runId)
        .map((o) => `${o.day_id}|${o.time_block_id}`)
    )
    const scopedSlots = (run.schedule_template_id != null
      ? (state.template_slots || []).filter((s) => s.template_id === run.schedule_template_id)
      : []
    )
      .filter((s) => cellKeys.has(`${s.day_id}|${s.time_block_id}`))
      .map((s) => ({
        groupId: s.group_id, cohort_id: null, dayId: s.day_id, blockId: s.time_block_id,
        ...(s.elective_set_id != null ? { type: 'elective', electiveSetId: s.elective_set_id }
          : s.event_id != null ? { type: 'event', eventId: s.event_id }
          : s.is_fixed_event ? { type: 'fixed_event', fixedEventId: s.fixed_event_id }
          : s.activity_id != null ? { type: 'activity', activityId: s.activity_id }
          : { type: null }),
      }))
    const conflicts = findRouteConflicts({
      slots: scopedSlots,
      activities: state.activities || [],
      fixedEvents: state.fixed_events || [],
      electiveSetActivities: state.elective_set_activities || [],
      events: state.events || [],
      locations: state.locations || [],
    })
    if (conflicts.length > 0) return { ok: false, error: 'OUTER_RESOURCE_CONFLICT', findings: conflicts }
    const finalizedAt = new Date().toISOString()
    const { rows } = deriveMockOuterRows(state, run)
    state.elective_assignment_runs = (state.elective_assignment_runs || []).map((r) =>
      r.id === runId ? { ...r, status: 'final', finalized_at: finalizedAt } : r
    )
    state.elective_run_outer_snapshots = [
      ...(state.elective_run_outer_snapshots || []).filter((s) => s.run_id !== runId),
      ...rows.map((r, i) => ({ id: `${runId}-snap-${i}`, run_id: runId, ...r })),
    ]
    saveState(state)
    return { ok: true, finalizedAt, snapshotRows: rows.length }
  },
  // T245 — mirrors setElectiveAssignmentHandler's success/RUN_NOT_DRAFT shape.
  // The mock has no elective_preferences or elective_set_activities capacity
  // machinery wired here, so CAMPER_INELIGIBLE/OCCURRENCE_FULL/INVALID_CAPACITY
  // never fire (same additive-degradation posture as the stubs above); the row it writes
  // carries the real derived id, source and is_locked so the screen is not
  // built against a lie.
  // T320 (docs/adr/2026-09-30-elective-run-durability.md item 3) — mirrors
  // setElectiveAssignment.js's replacesAssignmentId contract: a move
  // tombstones (here: removes) the source row alongside the destination
  // write; a remove-only call (occurrenceId/activityId both null) just
  // removes it.
  async setElectiveAssignment({ runId, camperId, occurrenceId = null, activityId = null, locked = false, replacesAssignmentId = null } = {}) {
    const state = loadState()
    const run = (state.elective_assignment_runs || []).find((r) => r.id === runId)
    if (!run) return { ok: false, error: 'run not found' }
    if (run.status === 'final') return { ok: false, error: 'RUN_NOT_DRAFT' }

    if (replacesAssignmentId != null) {
      const owned = (state.elective_assignments || []).find((a) => a.id === replacesAssignmentId)
      if (!owned || owned.run_id !== runId || owned.camper_id !== camperId) {
        return { ok: false, error: 'ASSIGNMENT_NOT_FOUND' }
      }
    }

    if (occurrenceId == null && activityId == null && replacesAssignmentId != null) {
      state.elective_assignments = (state.elective_assignments || []).filter((a) => a.id !== replacesAssignmentId)
      saveState(state)
      return { ok: true, assignmentId: null, removed: replacesAssignmentId }
    }

    const assignmentId = deriveElectiveAssignmentId(runId, camperId, occurrenceId)
    const row = {
      id: assignmentId, run_id: runId, occurrence_id: occurrenceId, camper_id: camperId,
      activity_id: activityId, source: 'manual', is_locked: locked ? 1 : 0,
      solver_generation: run.solver_generation ?? null,
    }
    state.elective_assignments = [
      ...(state.elective_assignments || []).filter(
        (a) => a.id !== assignmentId && !(replacesAssignmentId != null && a.id === replacesAssignmentId)
      ),
      row,
    ]
    saveState(state)
    return { ok: true, assignmentId }
  },
  // T297 — mirrors setElectivePreferenceHandler. The SUPERSEDING RULE is
  // mirrored faithfully rather than degraded, and that is the point of having it
  // here: the whole hazard is that a coordinate-keyed row survives an edit and
  // ties with it, and a mock that skipped the rule would show a working screen
  // over the exact bug. The shared key helpers are the same ones the real path
  // uses, so the two cannot drift.
  async setElectivePreference({
    runId, camperId, occurrenceId, choiceId, rank = null, rankKind = null, replacesPreferenceId = null,
  } = {}) {
    const state = loadState()
    const run = (state.elective_assignment_runs || []).find((r) => r.id === runId)
    if (!run) return { ok: false, error: 'run not found' }
    if (run.status === 'final') return { ok: false, error: 'RUN_NOT_DRAFT' }
    const occ = (state.elective_occurrences || []).find((o) => o.id === occurrenceId && o.run_id === runId)
    if (!occ) return { ok: false, error: 'OCCURRENCE_NOT_IN_RUN' }
    if (!(state.elective_choices || []).some((c) => c.id === choiceId && c.run_id === runId)) {
      return { ok: false, error: 'CHOICE_NOT_IN_RUN' }
    }
    const dayLabel = (state.days_of_operation || []).find((d) => d.id === occ.day_id)?.label ?? null
    const blockName = (state.time_blocks || []).find((b) => b.id === occ.time_block_id)?.name ?? null

    // THE SCOPE IS INHERITED from the row being corrected, mirroring the real
    // op — see electron/ops/setElectivePreference.js for why imposing a cell on
    // a whole-run answer would make the correction tie with what it corrects.
    const replaced = replacesPreferenceId == null
      ? null
      : (state.elective_preferences || []).find(
        (pr) => pr.id === replacesPreferenceId && pr.run_id === runId && pr.camper_id === camperId
      )
    if (replacesPreferenceId != null && !replaced) return { ok: false, error: 'PREFERENCE_NOT_IN_RUN' }
    const scope = replaced
      ? {
        occurrence_id: replaced.occurrence_id,
        coordinate_day_label: replaced.coordinate_day_label,
        coordinate_period_label: replaced.coordinate_period_label,
      }
      : { occurrence_id: occurrenceId, coordinate_day_label: dayLabel, coordinate_period_label: blockName }

    const preferenceId = deriveElectivePreferenceId(
      runId, camperId, scope.occurrence_id, choiceId, coordinateOf(scope)
    )
    const supersedes = (pr) => {
      if (pr.run_id !== runId || pr.camper_id !== camperId) return false
      // The id being written is excluded by the filter below, not here.
      if (pr.occurrence_id != null) return pr.occurrence_id === occurrenceId
      if (pr.coordinate_day_label == null || pr.coordinate_period_label == null) return false
      return sameDayLabel(pr.coordinate_day_label, dayLabel) && samePeriodLabel(pr.coordinate_period_label, blockName)
    }
    const doomed = replaced ? (pr) => pr.id === replaced.id : supersedes
    state.elective_preferences = [
      ...(state.elective_preferences || []).filter((pr) => !doomed(pr) && pr.id !== preferenceId),
      { id: preferenceId, run_id: runId, camper_id: camperId, choice_id: choiceId, rank, rank_kind: rankKind, ...scope },
    ]
    saveState(state)
    return { ok: true, preferenceId }
  },
  // T297 — mirrors removeElectivePreferenceHandler. The mock has no op log, so
  // the human TOMBSTONE the real path writes has nothing to live in here; a
  // re-import under `npm run dev` therefore re-creates a removed row. Recorded
  // rather than papered over, same additive-degradation posture as the stubs
  // above — the provenance behaviour is asserted against the real path in
  // electron/ops/commitElectiveRun.preferenceProvenance.test.js.
  // T306 — mirrors attributeSubjectHandler (electron/main.js) and the op beneath it.
  //
  // A REAL REKEY, not a rename, using the same deriveCamperId the real path uses —
  // imported rather than re-implemented, because the whole point of the rekey is
  // that the named camper lands on the id their name derives, so a second import of
  // the same child joins them instead of forking. A mock that merely set
  // display_name would make the browser-dev path disagree with the product on the
  // one behaviour this op exists for.
  //
  // WHERE THIS MOCK IS HONESTLY THINNER, in the additive-degradation posture the
  // stubs above use: the mock has no op log, so the real path's per-row provenance
  // carry (isHumanOwned -> source 'human' | 'import') has nothing to live in here.
  // That behaviour is asserted against the real path in
  // electron/ops/commitElectiveRun.preferenceProvenance.test.js.
  async attributeSubject({ subjectId, displayName, externalId = null } = {}) {
    const state = loadState()
    const name = String(displayName ?? '').trim()
    if (!name) return { ok: false, error: 'displayName is required' }

    const campers = state.campers || []
    const subject = campers.find((c) => c.id === subjectId)
    if (!subject) return { ok: false, error: `no camper row ${subjectId} in this camp's database` }
    // The op's own guard, mirrored verbatim in meaning: only a provisional subject
    // may be attributed. Renaming an identified child would re-key a real camper's
    // identity and orphan them from their other records.
    if (subject.is_unattributed !== 1) {
      return {
        ok: false,
        error:
          `${subject.display_name || subjectId} is not an unattributed subject, so there is no name to ` +
          'fill in. Renaming a camper who is already identified would give them a new identity and ' +
          'disconnect them from their other records.',
      }
    }

    const campId = state.camp?.id ?? subject.camp_id
    // T321 (docs/adr/2026-10-01-camper-id-high-entropy-format.md): deriveCamperId
    // now computes only the camper_identity_keys LOOKUP id, never the real camper
    // id directly. Mirrors electron/ops/camperIdentityResolver.js's
    // resolveOrMintCamperId: a cache hit on `state.camper_identity_keys` reuses the
    // already-known camper id (so re-attributing the same name twice converges,
    // same as the real path); a miss mints a fresh opaque one. NO ORPHAN-REKEY
    // here — this mock is a single-process, single-device dev convenience with no
    // multi-device sync, so the cross-device orphan case this ADR names cannot
    // arise against it (same "honestly thinner" posture this function already
    // states for provenance above).
    const lookupId = deriveCamperId(campId, { externalId: externalId || null, displayName: name })
    const identityKeys = state.camper_identity_keys || (state.camper_identity_keys = [])
    const mapping = identityKeys.find((k) => k.id === lookupId)
    const camperId = mapping
      ? mapping.camper_id
      : (() => {
          const minted = mintCamperId()
          identityKeys.push({
            id: lookupId,
            camp_id: campId,
            key_mode: externalId ? 'ext' : 'name',
            key_value: externalId ? String(externalId).trim() : electiveChoiceLabelKey(name),
            camper_id: minted,
          })
          return minted
        })()

    if (camperId === subjectId) {
      // Already canonical — stop calling them provisional without deleting the row
      // being rekeyed onto.
      subject.display_name = name
      subject.is_unattributed = null
      if (externalId) subject.external_id = externalId
      saveState(state)
      return { ok: true, camperId, moved: { preferences: 0, assignments: 0 } }
    }

    const existing = campers.find((c) => c.id === camperId)
    const target = existing ?? { ...subject, id: camperId }
    target.display_name = name
    target.is_unattributed = null
    target.external_id = externalId || (existing ? target.external_id : null)
    if (!existing) campers.push(target)

    let preferences = 0
    for (const pref of state.elective_preferences || []) {
      if (pref.camper_id === subjectId) { pref.camper_id = camperId; preferences += 1 }
    }
    let assignments = 0
    for (const a of state.elective_assignments || []) {
      if (a.camper_id === subjectId) { a.camper_id = camperId; assignments += 1 }
    }

    state.campers = campers.filter((c) => c.id !== subjectId)
    saveState(state)
    return { ok: true, camperId, moved: { preferences, assignments } }
  },
  async removeElectivePreference({ runId, preferenceId } = {}) {
    const state = loadState()
    const run = (state.elective_assignment_runs || []).find((r) => r.id === runId)
    if (!run) return { ok: false, error: 'run not found' }
    if (run.status === 'final') return { ok: false, error: 'RUN_NOT_DRAFT' }
    if (!(state.elective_preferences || []).some((pr) => pr.id === preferenceId && pr.run_id === runId)) {
      return { ok: false, error: 'PREFERENCE_NOT_IN_RUN' }
    }
    state.elective_preferences = (state.elective_preferences || []).filter((pr) => pr.id !== preferenceId)
    saveState(state)
    return { ok: true }
  },
  // T248 — mirrors getElectiveRunOuterScheduleHandler (electron/main.js). For
  // a final run, reads the mock's elective_run_outer_snapshots rows (written
  // above by finalizeElectiveRun); otherwise derives live from
  // elective_assignments joined to elective_occurrences, same additive-
  // degradation posture as getElectiveRun above (activity/location name
  // lookups degrade to null rather than crashing when the mock fixture
  // hasn't seeded those tables).
  async getElectiveRunOuterSchedule({ runId } = {}) {
    const state = loadState()
    const run = (state.elective_assignment_runs || []).find((r) => r.id === runId)
    // activity_name is resolved inside deriveMockOuterRows (and copied onto the
    // snapshot rows at finalize), so only the location lookup is needed here.
    const locationById = new Map((state.locations || []).map((l) => [l.id, l]))

    let rows
    if (run?.status === 'final') {
      rows = (state.elective_run_outer_snapshots || []).filter((s) => s.run_id === runId)
    } else {
      rows = deriveMockOuterRows(state, run).rows
    }

    // Same ORDER BY camper_id, day_id, time_block_id as both real-handler
    // queries (electron/ops/electiveRunOuterSchedule.js and
    // electron/main.js), so the mock's row order matches electron:dev.
    const sortedRows = [...rows].sort((a, b) => {
      if (a.camper_id !== b.camper_id) return a.camper_id < b.camper_id ? -1 : 1
      if (a.day_id !== b.day_id) return a.day_id < b.day_id ? -1 : 1
      if (a.time_block_id !== b.time_block_id) return a.time_block_id < b.time_block_id ? -1 : 1
      return 0
    })

    return {
      rows: sortedRows.map((r) => ({
        camperId: r.camper_id,
        dayId: r.day_id,
        timeBlockId: r.time_block_id,
        activityId: r.activity_id,
        activityName: r.activity_name ?? null,
        locationId: r.location_id ?? null,
        locationName: r.location_id != null ? locationById.get(r.location_id)?.name ?? null : null,
        spanBlocks: r.span_blocks ?? null,
        solverGeneration: r.solver_generation ?? null,
        cellKind: r.cell_kind ?? 'elective',
        choiceId: r.choice_id ?? null,
        isLinkedChoice: !!r.is_linked_choice,
        choiceLabel: r.choice_label ?? null,
      })),
      runStatus: run?.status ?? null,
      // Hardcoded false: computing this honestly in the mock (comparing
      // snapshot generations, per finalizedAgainstStaleGeneration.js) is
      // disproportionate for a browser-dev-only fixture layer.
      finalizedAgainstStaleGeneration: false,
    }
  },
  // T249 — mirrors getSecurityStatusHandler (electron/main.js). Browser-dev
  // has no Electron, no OS keychain and no encrypted store, so nothing is
  // encrypted at rest here under any circumstances: reporting `false` is the
  // accurate answer for this environment, not a stub. That also keeps the D8
  // disclosure visible in `npm run dev`, which is where it gets looked at.
  async getSecurityStatus() {
    return { atRestEncryptionEnabled: false }
  },
  // Slice D — mirrors listImportEvidenceHandler's shape (electron/main.js),
  // but the mock has no import_evidence table and no op-log source per field
  // (same additive-degradation discipline as ingestReconcile's fieldProvenance
  // stub above): every activity reads as having no evidence, so the
  // provenance dot never renders in browser-dev — real fidelity for this
  // slice is `electron:dev`, per this file's own header discipline.
  async listImportEvidence() {
    return { evidence: [], fieldSources: {} }
  },
  // T114 follow-up — same additive-degradation stub for the groups counterpart:
  // no evidence in browser-dev, so the division provenance dot never renders
  // there. Real fidelity is `electron:dev`.
  async listDivisionEvidence() {
    return { evidence: [], fieldSources: {} }
  },
  // T119 — mirrors locationCapacityProvenanceHandler's shape (electron/main.js),
  // but the mock has no op-log source per field (same additive-degradation
  // discipline as listImportEvidence above): every location reads as
  // confirmed, so the provenance marker never renders in browser-dev — real
  // fidelity for this feature is `electron:dev`, per this file's own header
  // discipline.
  async locationCapacityProvenance() {
    const state = loadState()
    const result = {}
    for (const location of state.locations || []) {
      result[location.id] = 'confirmed'
    }
    return result
  },
  async getDeviceId() {
    return 'mock-device'
  },
  async resolveConflict(args = {}) {
    const state = loadState()
    state.conflicts = state.conflicts.filter(
      (msg) =>
        !(
          msg.existingOp &&
          msg.existingOp.entity === args.entity &&
          msg.existingOp.entity_id === args.entity_id &&
          msg.existingOp.field === args.field &&
          msg.existingOp.id === args.parent_op_id
        )
    )
    saveState(state)
    return { status: 'applied' }
  },
  // --- Device pairing and trust (T11) ---
  //
  // Stateful rather than stubbed: approve/deny/revoke actually move a device
  // between states and the list re-renders, so the Device Manager flow can be
  // evaluated in `npm run dev`. What this canNOT prove is anything about real
  // pairing — there is no second device, no WebSocket, and no Ed25519 minting
  // here. Per TESTING_STANDARD.md §2, device-trust behaviour is only ever
  // demonstrated under electron:dev plus the integration harness.
  async listPendingPairingRequests() {
    // Mirrors the real query: excludes denied devices so a single deny stops
    // the device re-appearing on the next poll.
    return (loadState().devices || [])
      .filter((d) => !d.authorized_at && !d.revoked_at && (d.pairing_status == null || d.pairing_status === 'pending'))
      .map(({ id, name }) => ({ id, name }))
  },
  // Connected tools: the browser mock has no keychain and no headless tools, so there is nothing to
  // authorize; an empty list keeps the panel honest in the dev preview.
  async listToolAuthorizations() {
    return []
  },
  async grantToolAuthorization() {
    throw new Error('Connected tools are only available in the desktop app')
  },
  async revokeToolAuthorization() {
    throw new Error('Connected tools are only available in the desktop app')
  },
  async listDevices() {
    return (loadState().devices || []).map(({ id, name, pairing_status, authorized_at, revoked_at, last_synced_at }) =>
      ({ id, name, pairing_status, authorized_at, revoked_at, last_synced_at, isSelf: id === 'mock-device' }))
  },
  // T322 S3b — per-peer erasure state. The browser mock has no purge-tombstones
  // and no peers reporting, so there is nothing to show: hasErasure=false keeps
  // the Device Manager column absent, which is the correct no-purge appearance.
  async listPeerErasureState() {
    return { hasErasure: false, states: {}, localDeviceId: null }
  },
  // Join flow (docs/adr/2026-09-08-libp2p-join-flow.md). The browser mock has
  // no libp2p and no second device, so these model the SHAPE the screens code
  // against — a plausible Host with a stable code, and a join that reaches
  // 'pending' and stays there, because in `npm run dev` nobody can approve it.
  // Deliberately not a fake success path: a screen that only ever sees the
  // happy case is how the timeout and denial states go unbuilt.
  // The browser mock deliberately reports the NEW flow: `npm run dev` is
  // where the join screens get looked at, and the old address picker has
  // nothing to show there anyway (no mDNS, no hosts).
  async getSyncEngine() {
    return { engine: 'automerge' }
  },
  async getJoinCode() {
    const state = loadState()
    return { code: 'K4P72MRQ', formatted: 'K4P7-2MRQ', campName: state.camp?.name ?? 'Demo Camp', open: mockJoinWindowOpen }
  },
  async handoffStatus() {
    const devices = loadState().devices || []
    const self = devices.find((d) => d.id === 'mock-device')
    const eligible = mockHandoff.isHost
      ? devices.filter((d) => d.id !== 'mock-device' && d.authorized_at && !d.revoked_at).map((d) => d.id)
      : []
    const peer = devices.find((d) => d.id === mockHandoff.handoff?.peerDeviceId)
    return {
      eligibleDeviceIds: eligible,
      selfName: self?.name ?? 'This computer (sample)',
      campName: loadState().camp?.name ?? 'Demo Camp',
      peerName: peer?.name ?? null,
      ...mockHandoff,
    }
  },
  async handoffStart(deviceId) {
    mockHandoff = { ...mockHandoff, lastResult: null, handoff: { role: 'giver', peerDeviceId: deviceId, state: 'offered' } }
    handoffListeners.forEach((cb) => cb())
    return { ok: true }
  },
  async handoffAccept() {
    return { ok: false, reason: 'peer_unreachable' }
  },
  async handoffDecline() {
    mockHandoff = { ...mockHandoff, handoff: null }
    handoffListeners.forEach((cb) => cb())
    return { ok: true }
  },
  onHandoffChanged(cb) {
    handoffListeners.push(cb)
    return () => { handoffListeners = handoffListeners.filter((f) => f !== cb) }
  },
  _setHandoff(next) {
    mockHandoff = { handoff: null, lastResult: null, isHost: true, ...next }
    handoffListeners.forEach((cb) => cb())
  },
  async setJoinWindow(open) {
    mockJoinWindowOpen = Boolean(open)
    return { open: mockJoinWindowOpen }
  },
  async joinStart({ code } = {}) {
    // Same structural check the real normalizeJoinCode makes, so the screen's
    // typo path is exercised in the browser.
    const cleaned = String(code ?? '').toUpperCase().replace(/[\s-]/g, '')
    if (cleaned.length !== 8) return { status: 'invalid_code' }
    mockJoinStarted = true
    return { status: 'started' }
  },
  async joinFindHost() {
    return { status: mockJoinStarted ? 'found' : 'not_found' }
  },
  // Browser preview of the Pair-again refusals: ?pairAgain=not_this_camp|device_revoked.
  async joinRequestPairing() {
    const outcome = typeof window === 'undefined' ? null : new URLSearchParams(window.location.search).get('pairAgain')
    if (outcome === 'not_this_camp') return { status: 'not_this_camp' }
    if (outcome === 'device_revoked') return { status: 'denied', reason: 'device_revoked' }
    return { status: 'pending' }
  },
  async joinAwaitPairingDecision() {
    // Never resolves in the mock: there is no director to approve. The screen
    // must stay usable (and cancellable) while this is outstanding.
    return new Promise(() => {})
  },
  async joinLogin() {
    return { status: 'failed' }
  },
  async joinAwaitData() {
    return { status: 'timeout' }
  },
  async joinCancel() {
    mockJoinStarted = false
    return { status: 'cancelled' }
  },
  async approveDevice(deviceId) {
    // Mock-only switch so the joiner-gone flag can be screenshotted in the browser preview.
    if (deviceId === 'mock-device-pending') return { deviceId, authorized: false, reason: 'joiner_disconnected' }
    const now = new Date().toISOString()
    updateDevice(deviceId, { pairing_status: 'authorized', authorized_at: now, revoked_at: null })
    return { deviceId, authorized: true }
  },
  async denyDevice(deviceId) {
    updateDevice(deviceId, { pairing_status: 'denied' })
    return { deviceId, denied: true }
  },
  async renameDevice(deviceId, name) {
    // eslint-disable-next-line no-control-regex
    const clean = String(name ?? '').replace(/[\u0000-\u001f\u007f-\u009f]/g, '').trim()
    if (!clean) throw new Error('A device name cannot be empty.')
    if (clean.length > 40) throw new Error('A device name can be at most 40 characters.')
    updateDevice(deviceId, { name: clean })
    return { deviceId, name: clean }
  },
  async revokeDevice(deviceId, reason = null) {
    updateDevice(deviceId, { revoked_at: new Date().toISOString(), revocation_reason: reason })
    return { deviceId, revoked: true }
  },
  async getDevicePairingStatus() {
    const self = (loadState().devices || []).find((d) => d.id === 'mock-device')
    return { isPaired: !!(self && self.authorized_at), pairing_status: self ? self.pairing_status : null }
  },
  // Event subscriptions. Registered rather than dropped so a dev session can
  // synthesize one from the console, matching the onOpApplied pattern above.
  onPairingRequest(cb) { pairingRequestListeners.push(cb); return () => { pairingRequestListeners = pairingRequestListeners.filter((f) => f !== cb) } },
  // docs/adr/2026-08-16-client-reauth-on-restart.md (T87 Part 3)
  onAuthRejected(cb) { authRejectedListeners.push(cb); return () => { authRejectedListeners = authRejectedListeners.filter((f) => f !== cb) } },
  _triggerPairingRequest(payload) { pairingRequestListeners.forEach((cb) => cb(payload)) },
  _triggerAuthRejected(payload) { authRejectedListeners.forEach((cb) => cb(payload)) },

  // Rehydration query stand-in (Fix 3): returns the conflicts persisted in
  // mock state, mirroring the real listPendingConflicts() IPC handler so the
  // Conflicts screen shows pending conflicts immediately on mount even
  // outside Electron.
  async listPendingConflicts() {
    return loadState().conflicts
  },

  // Trash and record history have no meaningful stand-in outside Electron:
  // the mock has no op log, which is the only place a deleted record lives.
  // Empty results keep the screens renderable for layout work at :5200 and
  // make it obvious that persistence checks belong under electron:dev.
  async listDeleted() {
    return []
  },
  async getEntityHistory() {
    return []
  },
  async restoreEntity() {
    return { error: 'no-history' }
  },

  // Deleting a record a schedule uses. The mock has no schedule to count, so
  // the preview reports a real zero rather than an invented number — the count
  // is the whole basis on which a director decides, and a made-up one at :5200
  // would make the dialog look verified when it is not. Persistence checks for
  // this belong under electron:dev.
  async previewDelete({ entity, entity_id }) {
    // The NAME is real: it is sitting in the same state the list renders from,
    // and returning null made every confirmation read 'Delete “this record”?'
    // — which is exactly the kind of thing this surface exists to catch. The
    // COUNTS stay zero because they are honestly zero here.
    const state = loadState()
    const row = Array.isArray(state[entity]) ? state[entity].find((r) => r.id === entity_id) : null
    const name = row ? (row[mockNameColumnFor(entity)] ?? null) : null

    // M3c: locations get their own shape (ref_count + activities), never
    // the schedule-shaped slot_count/routes/unprotected_count fields — see
    // electron/ops/deleteRecord.js's previewDelete.
    if (entity === 'locations') {
      const usedBy = (Array.isArray(state.activities) ? state.activities : [])
        .filter((a) => a.location_id === entity_id)
      return {
        ok: true, entity, entity_id, name,
        ref_count: usedBy.length,
        activities: usedBy.map((a) => ({ id: a.id, name: a.name })),
        fixed_event_count: 0, event_count: 0, special_day_slot_count: 0, event_slot_count: 0,
      }
    }
    return {
      ok: true,
      entity,
      entity_id,
      name,
      destructive: entity === 'groups' || entity === 'days_of_operation',
      slot_count: 0,
      routes: [],
      unprotected_count: 0,
      fixed_event_count: 0,
      weather_dependent_count: 0,
    }
  },
  // The mock has no schedule or op-log, so there is nothing to clear and no
  // version to save — but the RECORD is real, and it lives in the same state
  // the list reads from. Returning { error: 'no-record' } (as this did) made
  // the confirm dialog refuse every delete at :5200, so Delete simply did not
  // work on the dev surface even though the Electron path was fine.
  //
  // Deleting soft-deletes exactly the way write() does, via the __deleted__
  // field, so the row leaves the list and Trash still knows about it. Counts
  // stay zero because they are honestly zero here — previewDelete above says
  // the same, and inventing them would make the dialog look verified when it
  // is not. Anything that depends on a real op-log belongs under electron:dev.
  async deleteRecord({ entity, entity_id } = {}) {
    if (!entity || !entity_id) return { error: 'no-record' }
    const state = loadState()
    const rows = state[entity]
    if (!Array.isArray(rows)) return { error: 'no-record' }
    const row = rows.find((r) => r.id === entity_id)
    if (!row) return { error: 'no-record' }
    const name = row[mockNameColumnFor(entity)] ?? null
    state[entity] = rows.filter((r) => r.id !== entity_id)
    saveState(state)
    return {
      ok: true,
      entity,
      entity_id,
      name,
      destructive: entity === 'groups' || entity === 'days_of_operation',
      cleared: 0,
      routes: [],
      snapshots: [],
      ops: [],
    }
  },
  // M3c — merging two locations. Like deleteRecord above, this used to refuse
  // unconditionally, which meant "merge into this location" did nothing at
  // :5200 however the director reached it (the duplicate dot, the near-
  // duplicate gate, or the migration review).
  //
  // The mock has no op-log, but it does have locations and the activities that
  // point at them, so the merge itself is real: every activity on the loser is
  // repointed at the winner, the winner can take the surviving capacity, and
  // the loser goes. That is the whole observable effect of a merge on this
  // surface.
  // docs/adr/2026-08-15-locations-merge-and-delete-rehome.md
  // Mock stand-in for the Activities duplicate-catcher merge. Mirrors the real
  // op's OBSERVABLE contract (loser gone, referrers re-pointed, ref_count
  // reported) without the op log — the mock has no operations table. The real
  // referrer sweep and its completeness guard live in
  // electron/ops/mergeActivity.test.js; this exists so the browser-mock dev
  // path renders the same flow rather than throwing on a missing method.
  async previewActivityMerge({ loser_id } = {}) {
    const state = loadState()
    const slots = Array.isArray(state.template_slots) ? state.template_slots : []
    return { ok: true, ref_count: slots.filter((s) => s.activity_id === loser_id).length }
  },

  async mergeActivity({ loser_id, winner_id } = {}) {
    if (!loser_id || !winner_id || loser_id === winner_id) return { error: 'invalid-winner' }
    const state = loadState()
    const activities = Array.isArray(state.activities) ? state.activities : []
    if (!activities.some((a) => a.id === loser_id)) return { error: 'no-record' }
    if (!activities.some((a) => a.id === winner_id)) return { error: 'no-winner' }

    let ref_count = 0
    const repoint = (rows) =>
      (Array.isArray(rows) ? rows : []).map((r) => {
        if (r?.activity_id !== loser_id) return r
        ref_count += 1
        return { ...r, activity_id: winner_id }
      })
    state.template_slots = repoint(state.template_slots)
    state.special_day_slots = repoint(state.special_day_slots)
    state.event_slots = repoint(state.event_slots)
    state.week_activity_exclusions = repoint(state.week_activity_exclusions)
    state.activities = activities
      .filter((a) => a.id !== loser_id)
      .map((a) => (a.weather_alternative_id === loser_id
        ? { ...a, weather_alternative_id: a.id === winner_id ? null : winner_id }
        : a))
    saveState(state)
    return { ok: true, ref_count, ops_written: ref_count + 1, alias_remembered: true }
  },

  async mergeLocation({ loser_id, winner_id, winner_capacity } = {}) {
    if (!loser_id || !winner_id || loser_id === winner_id) return { error: 'no-record' }
    const state = loadState()
    const locations = Array.isArray(state.locations) ? state.locations : []
    const loser = locations.find((l) => l.id === loser_id)
    const winner = locations.find((l) => l.id === winner_id)
    if (!loser || !winner) return { error: 'no-record' }

    const activities = Array.isArray(state.activities) ? state.activities : []
    let moved = 0
    state.activities = activities.map((a) => {
      if (a.location_id !== loser_id) return a
      moved += 1
      return { ...a, location_id: winner_id }
    })
    state.locations = locations
      .filter((l) => l.id !== loser_id)
      .map((l) => (l.id === winner_id && winner_capacity != null ? { ...l, capacity: winner_capacity } : l))
    saveState(state)
    return { ok: true, loser_id, winner_id, moved, ref_count: moved, ops: [] }
  },
  // The mock has no migration journal (it never ran the v32 migration) — a
  // real empty result, not an invented fixture, so the review region
  // correctly renders nothing at :5200. Persistence checks for this belong
  // under electron:dev.
  async listMigrationReviews() {
    return []
  },
  async dismissMigrationReviews() {
    return { ok: true, dismissed: 0 }
  },

  // The mock has no import/commitPlan pipeline (docs/adr/2026-08-28-
  // persisted-reconciliation-decisions.md) — a real empty result, same
  // posture as listMigrationReviews above. Persistence is only verifiable
  // under electron:dev.
  async listOpenReconciliationDecisions() {
    return []
  },
  async dismissOpenReconciliationDecisions() {
    return { ok: true, dismissed: 0 }
  },

  // Duplicate a week in mock state, mirroring duplicateWeek.js's contract:
  // a new schedule_weeks row, new schedule_templates rows, copies of slots/
  // overlays/exclusions with fresh ids, appended last. Operates on
  // localStorage state — no op-log, no broadcast. For layout work at :5200;
  // persistence/sync is only verifiable under electron:dev.
  async duplicateWeek({ sourceWeekId } = {}) {
    const state = loadState()
    const sourceWeek = (state.schedule_weeks || []).find((w) => w.id === sourceWeekId)
    if (!sourceWeek) return { error: 'no-source-week' }

    const newWeekId = randomId()

    const existingNames = new Set((state.schedule_weeks || []).map((w) => w.name))
    let newName = `${sourceWeek.name} copy`
    if (existingNames.has(newName)) {
      let n = 2
      while (existingNames.has(`${sourceWeek.name} copy (${n})`)) n++
      newName = `${sourceWeek.name} copy (${n})`
    }

    const maxSort = Math.max(0, ...(state.schedule_weeks || []).map((w) => w.sort_order ?? 0))

    if (!Array.isArray(state.schedule_weeks)) state.schedule_weeks = []
    if (!Array.isArray(state.schedule_templates)) state.schedule_templates = []
    if (!Array.isArray(state.template_slots)) state.template_slots = []

    for (const kind of ['generated', 'manual']) {
      const srcTemplate = state.schedule_templates.find(
        (t) => t.week_id === sourceWeekId && t.kind === kind
      )
      if (!srcTemplate) continue

      const newTemplateId = randomId()
      state.schedule_templates.push({
        id: newTemplateId,
        camp_id: srcTemplate.camp_id,
        name: srcTemplate.name,
        kind,
        week_id: newWeekId,
      })

      const srcSlots = state.template_slots.filter((s) => s.template_id === srcTemplate.id)
      for (const s of srcSlots) {
        state.template_slots.push({ ...s, id: randomId(), template_id: newTemplateId })
      }
    }

    if (!Array.isArray(state.week_activity_exclusions)) state.week_activity_exclusions = []
    if (!Array.isArray(state.week_group_exclusions)) state.week_group_exclusions = []
    if (!Array.isArray(state.week_location_exclusions)) state.week_location_exclusions = []

    for (const e of state.week_activity_exclusions.filter((e) => e.week_id === sourceWeekId)) {
      state.week_activity_exclusions.push({ id: randomId(), week_id: newWeekId, activity_id: e.activity_id })
    }
    for (const e of state.week_group_exclusions.filter((e) => e.week_id === sourceWeekId)) {
      state.week_group_exclusions.push({ id: randomId(), week_id: newWeekId, group_id: e.group_id })
    }
    for (const e of state.week_location_exclusions.filter((e) => e.week_id === sourceWeekId)) {
      state.week_location_exclusions.push({ id: randomId(), week_id: newWeekId, location_id: e.location_id })
    }
    // T350: derived id for the new week, like duplicateWeek.js.
    state.special_day_placements = state.special_day_placements || []
    for (const p of state.special_day_placements.filter((p) => p.week_id === sourceWeekId)) {
      state.special_day_placements.push({ id: deriveSpecialDayPlacementId(newWeekId, p.day_id), week_id: newWeekId, day_id: p.day_id, special_day_id: p.special_day_id })
    }

    state.schedule_weeks.push({
      id: newWeekId,
      camp_id: sourceWeek.camp_id,
      name: newName,
      sort_order: maxSort + 1,
      is_archived: 0,
    })

    saveState(state)
    return { ok: true, newWeekId, newName }
  },

  // Permanently delete a week and all its scoped rows, mirroring deleteWeek.js's
  // contract: last-week guard, full cascade, no raw deletes outside the log.
  // Operates on localStorage state — no op-log, no broadcast. For layout work at
  // :5200; persistence/sync is only verifiable under electron:dev.
  async deleteWeek({ weekId } = {}) {
    const state = loadState()
    const allWeeks = state.schedule_weeks || []
    const week = allWeeks.find(w => w.id === weekId)
    if (!week) return { error: 'no-week' }

    if (allWeeks.length <= 1) return { error: 'last-week' }

    const templates = (state.schedule_templates || []).filter(t => t.week_id === weekId)
    const templateIds = new Set(templates.map(t => t.id))

    state.schedule_snapshots = (state.schedule_snapshots || []).filter(s => !templateIds.has(s.template_id))
    state.template_slots = (state.template_slots || []).filter(s => !templateIds.has(s.template_id))
    state.week_activity_exclusions = (state.week_activity_exclusions || []).filter(e => e.week_id !== weekId)
    state.week_group_exclusions = (state.week_group_exclusions || []).filter(e => e.week_id !== weekId)
    state.week_location_exclusions = (state.week_location_exclusions || []).filter(e => e.week_id !== weekId)
    state.special_day_placements = (state.special_day_placements || []).filter(p => p.week_id !== weekId)
    state.schedule_templates = (state.schedule_templates || []).filter(t => t.week_id !== weekId)
    state.schedule_weeks = allWeeks.filter(w => w.id !== weekId)

    saveState(state)
    return { ok: true }
  },

  // Permanently delete an elective set and its member rows, mirroring
  // deleteElectiveSet.js's cascade (T110, docs/adr/2026-08-20-electives-
  // authoring.md): elective_set_activities before elective_sets, no touch to
  // template_slots (a dangling elective_set_id renders empty, same as the
  // real cascade). Operates on localStorage state — no op-log, no broadcast.
  async deleteElectiveSet({ electiveSetId } = {}) {
    const state = loadState()
    const set = (state.elective_sets || []).find((s) => s.id === electiveSetId)
    if (!set) return { error: 'not-found' }

    state.elective_set_activities = (state.elective_set_activities || []).filter(
      (m) => m.elective_set_id !== electiveSetId
    )
    state.elective_sets = (state.elective_sets || []).filter((s) => s.id !== electiveSetId)

    saveState(state)
    return { ok: true }
  },

  // T250 A4 — permanently delete an elective run and every row scoped to it,
  // mirroring deleteElectiveRun.js's cascade. Operates on localStorage state
  // — no op-log, no broadcast.
  async deleteElectiveRun({ runId } = {}) {
    const state = loadState()
    const run = (state.elective_assignment_runs || []).find((r) => r.id === runId)
    if (!run) return { error: 'not-found' }

    const choiceIds = new Set(
      (state.elective_choices || []).filter((c) => c.run_id === runId).map((c) => c.id)
    )
    state.elective_run_outer_snapshots = (state.elective_run_outer_snapshots || []).filter((s) => s.run_id !== runId)
    // T320 (docs/adr/2026-09-30-elective-run-durability.md item 4).
    state.elective_run_findings = (state.elective_run_findings || []).filter((f) => f.run_id !== runId)
    state.elective_assignments = (state.elective_assignments || []).filter((a) => a.run_id !== runId)
    state.elective_preferences = (state.elective_preferences || []).filter((p) => p.run_id !== runId)
    state.elective_choice_offerings = (state.elective_choice_offerings || []).filter((o) => !choiceIds.has(o.choice_id))
    state.elective_choices = (state.elective_choices || []).filter((c) => c.run_id !== runId)
    state.elective_occurrences = (state.elective_occurrences || []).filter((o) => o.run_id !== runId)
    state.elective_assignment_runs = (state.elective_assignment_runs || []).filter((r) => r.id !== runId)

    saveState(state)
    return { ok: true, ops_written: 1 }
  },

  // T343 — elective purge, mirroring purgeElectiveSeason.js: season = every run
  // (incl. schedule_week_id NULL); week = runs with that exact schedule_week_id.
  // Only the in-scope runs' run-scoped rows go; the offerings setup is untouched.
  async purgeElectiveSeason({ scope = 'season', weekId } = {}) {
    if (scope === 'week' && !weekId) return { ok: false, error: 'weekId is required for a by-week purge' }
    const state = loadState()
    const runs = state.elective_assignment_runs || []
    const gone = new Set(runs.filter((r) => scope !== 'week' || r.schedule_week_id === weekId).map((r) => r.id))
    const inRun = (r) => !gone.has(r.run_id)
    const goneChoiceIds = new Set((state.elective_choices || []).filter((c) => gone.has(c.run_id)).map((c) => c.id))
    state.elective_choice_offerings = (state.elective_choice_offerings || []).filter((o) => !goneChoiceIds.has(o.choice_id))
    for (const t of [
      'elective_run_outer_snapshots', 'elective_run_findings', 'elective_assignments', 'elective_preferences',
      'elective_choices', 'elective_occurrences',
    ]) state[t] = (state[t] || []).filter(inRun)
    state.elective_assignment_runs = runs.filter((r) => !gone.has(r.id))
    saveState(state)
    return { ok: true, runsDeleted: gone.size, ops_written: gone.size }
  },

  // Permanently delete a special day and its scoped rows, mirroring
  // deleteSpecialDay.js's cascade (T106, docs/adr/2026-08-20-special-days-
  // authoring-and-day-override-repoint.md D1): special_day_slots and
  // special_day_time_blocks before special_days. Operates on localStorage
  // state — no op-log, no broadcast.
  async deleteSpecialDay({ specialDayId } = {}) {
    const state = loadState()
    const day = (state.special_days || []).find((d) => d.id === specialDayId)
    if (!day) return { error: 'not-found' }

    state.special_day_placements = (state.special_day_placements || []).filter(
      (p) => p.special_day_id !== specialDayId
    )
    state.special_day_slots = (state.special_day_slots || []).filter(
      (s) => s.special_day_id !== specialDayId
    )
    state.special_day_time_blocks = (state.special_day_time_blocks || []).filter(
      (b) => b.special_day_id !== specialDayId
    )
    state.special_days = (state.special_days || []).filter((d) => d.id !== specialDayId)

    saveState(state)
    return { ok: true }
  },

  // T350: mirrors electron/ops/specialDayPlacements.js — same refusals, derived id, replace only
  // with an explicit confirm. localStorage state, no op-log.
  async bindSpecialDay({ weekId, dayId, specialDayId, replace = false } = {}) {
    const state = loadState()
    if (!(state.schedule_weeks || []).some((w) => w.id === weekId)) return { ok: false, reason: 'unknown-week' }
    if (!(state.days_of_operation || []).some((d) => d.id === dayId)) return { ok: false, reason: 'unknown-day' }
    if (!(state.special_days || []).some((d) => d.id === specialDayId)) return { ok: false, reason: 'unknown-special-day' }
    const id = deriveSpecialDayPlacementId(weekId, dayId)
    const rows = state.special_day_placements || []
    const current = rows.find((p) => p.id === id)
    if (current && current.special_day_id !== specialDayId && !replace) {
      return { ok: false, reason: 'occupied', currentSpecialDayId: current.special_day_id }
    }
    state.special_day_placements = [...rows.filter((p) => p.id !== id), { id, week_id: weekId, day_id: dayId, special_day_id: specialDayId }]
    saveState(state)
    return { ok: true, ops_written: 3 }
  },

  async unbindSpecialDay({ weekId, dayId } = {}) {
    const state = loadState()
    const id = deriveSpecialDayPlacementId(weekId, dayId)
    const rows = state.special_day_placements || []
    state.special_day_placements = rows.filter((p) => p.id !== id)
    saveState(state)
    return { ok: true, ops_written: rows.length - state.special_day_placements.length }
  },

  // Permanently delete an event and its scoped rows, mirroring
  // deleteEvent.js's cascade (Events internal sub-schedule Slice 2,
  // docs/adr/2026-08-22-event-internal-subschedule.md §3): event_slots
  // before event_time_blocks/event_groups, before events. Not wired to any
  // UI in this slice (see restore.js's "no delete UI yet" note) — exists for
  // registry parity, mirroring deleteSpecialDay above. Operates on
  // localStorage state — no op-log, no broadcast.
  async deleteEvent({ eventId } = {}) {
    const state = loadState()
    const event = (state.events || []).find((e) => e.id === eventId)
    if (!event) return { error: 'not-found' }

    state.event_slots = (state.event_slots || []).filter((s) => s.event_id !== eventId)
    state.event_time_blocks = (state.event_time_blocks || []).filter((b) => b.event_id !== eventId)
    state.event_groups = (state.event_groups || []).filter((g) => g.event_id !== eventId)
    state.events = (state.events || []).filter((e) => e.id !== eventId)
    // Mirrors deleteEvent.js's template_slots clearing (Red Hat LOW, round 2):
    // a Slice-1 campwide placement referencing this event must not dangle.
    // DOCUMENTED DIVERGENCE: the real cascade is the shared clearSlotOccupant
    // (electron/ops/slotOccupants.js, event_id policy 'clear'), which cannot be
    // reused here — it writes op-log rows against a SQLite handle, and this
    // mock has neither. The mirror stays hand-maintained; the policy it mirrors
    // is declared and guarded in SLOT_OCCUPANT_CASCADES.
    state.template_slots = (state.template_slots || []).map((ts) =>
      ts.event_id === eventId ? { ...ts, event_id: null } : ts
    )

    saveState(state)
    return { ok: true }
  },

  // No-op subscribe — the mock has no real full-sync event to fire; mirrors
  // onOpApplied/onOpConflict's registered-but-inert shape for parity.
  onFullSyncApplied() {
    return () => {}
  },

  // §9 project-file lifecycle stand-ins. Sidebar.jsx actually calls
  // getCurrentProject and backupProject, so those return a plausible dev
  // shape; the other six exist only to keep the IPC surface honest in a
  // plain browser dev server — there is no real filesystem to simulate here.
  async getCurrentProject() {
    return { path: '(mock)', isDev: true, build: null }
  },
  async backupProject() {
    return { status: 'ok' }
  },
  async showBackupInFolder() {
    return { shown: true }
  },
  async createProject() {
    return { status: 'not-supported-in-browser-dev' }
  },
  async openProject() {
    return { status: 'not-supported-in-browser-dev' }
  },
  async exportProject() {
    return { status: 'not-supported-in-browser-dev' }
  },
  async pickRestoreBackup() {
    return { status: 'not-supported-in-browser-dev' }
  },
  async restoreProject() {
    return { status: 'not-supported-in-browser-dev' }
  },
  async listRecentProjects() {
    return { status: 'not-supported-in-browser-dev' }
  },
  async openRecentProject() {
    return { status: 'not-supported-in-browser-dev' }
  },
}

// Dev-only: expose the mock on window so a manual/automated browser session
// (e.g. via the devtools console) can synthesize op-applied/op-conflict
// events without monkey-patching this file, per Fix 7.
if (typeof window !== 'undefined') {
  window.__mockShoresh = mockShoresh

  // Load a ready-to-review demo camp so the generated flag review can be tested
  // at :5200 with hot-reload. `__seedDemo()` writes the state + a signed-in
  // host session and reloads; `__clearDemo()` wipes it back to a blank dev
  // server. Visiting `?demo=schedule` runs the seed once and strips the param.
  window.__seedDemo = () => {
    saveState(seedDemoCamp())
    localStorage.setItem('shoresh-mode', 'host')
    localStorage.setItem('shoresh-token', 'mock.demo-admin')
    localStorage.setItem('shoresh-role', 'admin')
    window.location.replace(window.location.pathname)
  }
  window.__clearDemo = () => {
    for (const k of [STORE_KEY, 'shoresh-mode', 'shoresh-token', 'shoresh-role']) {
      localStorage.removeItem(k)
    }
    window.location.replace(window.location.pathname)
  }
  if (window.location.search.includes('demo=schedule')) window.__seedDemo()
}
