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
import { normalizeName } from './ingest/preview.js'
// S2c: the SAME pure field-update helpers the real committer uses, so the mock's
// fold/snapshot/validation cannot drift from electron/ops/ingest.js.
import { foldApprovedToRecords, enrichSnapshotRow, resolveFieldWrite, dbFieldFor } from './ingest/fieldUpdate.js'

const STORE_KEY = 'shoresh-mock-state'

// Transcribed from electron/ops/ingest.js (NAME_COLUMN / COHORT_SCOPED /
// COMPARABLE_COLUMNS) so the mock builds the SAME `existing` snapshot the real
// committer feeds buildPlan: names aliased for recognition, comparable VALUES for
// the field diff, tiers/time_blocks cohort-scoped. Same src/-never-imports-electron/
// duplication discipline as MOCK_WRITE_ALLOWLIST — a verbatim copy, not shared code.
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
  activities: ['priority', 'min_per_week', 'max_per_week', 'location', 'eligible_group_ids'],
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
  const users = [{ id: 'demo-admin', name: 'Director', pin: '1234', role: 'admin' }]
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
  const blockNames = ['First Period', 'Second Period', 'Third Period', 'Fourth Period']
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
  const template_slots = []
  groups.forEach((g, gi) => {
    days.forEach((d, di) => {
      time_blocks.forEach((b, bi) => {
        const key = `${g.id}|${d.id}|${b.id}`
        const isUnfillable = unfillable.has(key)
        template_slots.push({
          id: `slot-${key}`,
          template_id: TEMPLATE,
          group_id: g.id,
          day_id: d.id,
          time_block_id: b.id,
          activity_id: isUnfillable ? null : `act-${(gi + di + bi) % activityNames.length}`,
          anchor_id: null,
          is_anchor: 0,
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
    anchor_activities: [],
    // One week; the generated schedule belongs to it (week_id). The switcher
    // renders it and "+ New Week" adds more, all in localStorage.
    schedule_weeks: [{ id: WEEK, camp_id: CAMP, name: 'Week 1', sort_order: 0, is_archived: 0 }],
    schedule_templates: [{ id: TEMPLATE, camp_id: CAMP, name: 'Generated', kind: 'generated', week_id: WEEK }],
    template_slots,
    template_overlays: [],
    schedule_snapshots: [],
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

// Mirrors the real SQLite UNIQUE(...) indexes (electron/db/schema.sql +
// migrations) so the mock reproduces the same collision behavior the app's
// write logic is built around (ensureCohort / addTier / etc. deliberately
// write `name` first and match on /UNIQUE/i errors). Without emulating these,
// StrictMode's double-invoked mount effect would create duplicate "Main"
// cohorts/days in a `npm run dev` browser that could never happen in Electron.
const UNIQUE_KEYS = {
  cohorts:     ['camp_id', 'name'],
  groups:      ['camp_id', 'name'],
  activities:  ['camp_id', 'name'],
  tiers:       ['camp_id', 'cohort_id', 'name'],
  time_blocks: ['camp_id', 'cohort_id', 'name'],
}

// Registered listeners for the mock's event-style methods (onOpApplied,
// onOpConflict). Stored here — rather than left as no-ops — so a future
// test/dev session can trigger a synthetic op-applied or conflict event
// (e.g. via mockShoresh._triggerOpConflict(msg)) without monkey-patching
// this file each time.
let opAppliedListeners = []
let pairingRequestListeners = []
let pairingApprovedListeners = []
let pairingDeniedListeners = []
let tokenRenewedListeners = []
let opConflictListeners = []

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
// electron/ops/campScopedEntities.js, for the five entities C4's
// listByScope targets (day_override_template_slots is deliberately
// excluded — it is in PARENT_SCOPED_ENTITIES but not in main.js's
// SCOPED_LIST_ENTITIES allowlist). Same duplication discipline as
// MOCK_WRITE_ALLOWLIST above: src/ never imports from electron/, so this is
// a verbatim copy kept honest by electron/ipcSurfaceParity.test.js's drift
// check rather than by sharing code.
export const MOCK_SCOPE_KEYS = {
  template_slots: 'template_id',
  template_overlays: 'template_id',
  schedule_snapshots: 'template_id',
  week_activity_exclusions: 'week_id',
  week_group_exclusions: 'week_id',
}

export const MOCK_WRITE_ALLOWLIST = {
  camps: ['name'],
  users: ['camp_id', 'name', 'pin_hash', 'pin_salt', 'role'],
  cohorts: [
    'camp_id',
    'name',
    'session_week_start',
    'session_week_end',
    'capacity_source',
    'anchor_model',
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
  ],
  anchor_activities: ['camp_id', 'cohort_id', 'day_id', 'time_block_id', 'name', 'is_all_groups', 'group_ids', 'notes'],
  day_override_templates: ['camp_id', 'cohort_id', 'name', 'frequency_mode'],
  day_override_template_slots: ['day_override_template_id', 'time_block_id', 'activity_id'],
  week_activity_exclusions: ['week_id', 'activity_id'],
  week_group_exclusions: ['week_id', 'group_id'],
  schedule_weeks: ['camp_id', 'name', 'sort_order', 'is_archived'],
  schedule_templates: ['kind', 'camp_id', 'week_id', 'name'],
  schedule_snapshots: ['template_id', 'name', 'is_auto', 'created_at', 'slots', 'overlays'],
  template_overlays: ['template_id', 'unit_id', 'day_id', 'from_block_order', 'to_block_order', 'label'],
  template_slots: [
    'template_id',
    'group_id',
    'activity_id',
    'day_id',
    'time_block_id',
    'anchor_id',
    'is_anchor',
    'is_span_head',
    'is_released',
    'flags',
  ],
  conflicts: [],
}

export const mockShoresh = {
  async chooseMode() {
    return { mode: 'host' }
  },
  async discoverHosts() {
    return [{ name: 'Camp Achva (demo)', host: '192.168.1.42', port: 7000 }]
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
  // a Program/Unit/Group/etc. in a plain `npm run dev` browser and blocking
  // Camp Setup end-to-end outside Electron.
  async write({ entity, entity_id, field, value } = {}) {
    if (!entity || !entity_id) return { status: 'applied' }

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
    const base = isNew
      ? { id: entity_id, ...(uniqueKey?.includes('camp_id') && state.camp ? { camp_id: state.camp.id } : {}) }
      : rows[idx]
    const candidate = { ...base, [field]: value }

    // Emulate the UNIQUE constraint: once every key field is present, reject a
    // write that would duplicate another row's key tuple (throwing a
    // better-sqlite3-shaped message the app already matches on with /UNIQUE/i).
    if (uniqueKey && uniqueKey.every((k) => candidate[k] != null && candidate[k] !== '')) {
      const collision = rows.some(
        (r) => r.id !== entity_id && uniqueKey.every((k) => r[k] === candidate[k])
      )
      if (collision) {
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
  // Wholesale delete-and-reinsert of one scope, mirroring the real
  // bulk_replace primitive (electron/ops/operations.js). The two registered
  // bulk_replace entities (template_slots, template_overlays) are both scoped
  // by template_id, so replace every row in that scope with the new set.
  async bulkReplace({ entity, scope_id, rows } = {}) {
    if (!entity) return { status: 'applied' }
    const state = loadState()
    if (!Array.isArray(state[entity])) state[entity] = []
    state[entity] = state[entity].filter((r) => r.template_id !== scope_id)
    for (const row of rows || []) state[entity].push({ ...row })
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
  async ingestCommit({ approved, links, cohort_id, fixedEvents, activityRules, mode, resolutions, base_generation } = {}) {
    const state = loadState()
    if (!state.camp) throw new Error('ingest: no camp')
    const campId = state.camp.id
    const cohortId = cohort_id ?? null
    for (const entity of INGESTIBLE_ENTITIES) if (!Array.isArray(state[entity])) state[entity] = []

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
        'template_slots', 'template_overlays', 'week_activity_exclusions',
        'week_group_exclusions', 'day_override_template_slots', 'anchor_activities',
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
    const buildSnapshot = () => {
      const existing = {}
      for (const entity of INGESTIBLE_ENTITIES) {
        const scoped = MOCK_COHORT_SCOPED.has(entity)
        const rows = (state[entity] ?? []).map((r) => {
          const row = { id: r.id, name: r[mockNameColumnFor(entity)] }
          if (scoped) row.cohort_id = r.cohort_id ?? null
          for (const c of MOCK_COMPARABLE_COLUMNS[entity]) row[c] = r[c]
          return enrichSnapshotRow(entity, row, groupNameById, tierNameById)
        })
        existing[entity] = scoped && cohortId ? rows.filter((r) => r.cohort_id === cohortId) : rows
      }
      return existing
    }
    const existing = mode === 'replace' ? null : buildSnapshot()

    // S2c §1: fold the rule/unit side-channels into per-row records at this
    // boundary (shared with electron), so buildPlan sees only records. `links`/
    // `activityRules` still pass through for the create path's back-compat fallback.
    const recordApproved = foldApprovedToRecords(approved, activityRules, links)

    // The PURE decision layer — the SAME buildPlan the real commitIngest uses.
    // buildPlan consumes the ambiguous_identity resolutions itself (pin identity /
    // force create); the stale resolutions are honored below in the Policy-A gate.
    const plan = buildPlan(
      { approved: recordApproved, links, activityRules, fixedEvents, camp_id: campId, cohort_id: cohortId, mode, base_generation: base_generation ?? 0 },
      existing,
      Array.isArray(resolutions) ? resolutions : [],
    )

    // Resolutions index for the stale gate (keyed entity|normalizeName|field,
    // exactly as commitPlan), plus the collision-bypass the ambiguous 'create'
    // pick needs at apply time.
    const resIndex = new Map()
    for (const r of Array.isArray(resolutions) ? resolutions : []) {
      if (!r || !r.entity) continue
      resIndex.set(`${r.entity}|${normalizeName(r.name)}|${r.field ?? ''}`, r)
    }
    const resolutionFor = (entity, name, field = '') => resIndex.get(`${entity}|${normalizeName(name)}|${field ?? ''}`)

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
    // S2c §4: a held field conflict from the update path (validation /
    // eligibility_unresolved / unit_unresolved), same shape the real committer
    // builds. resolveFieldWrite (shared) produces the reason + detail.
    const makeFieldConflict = (item, reason, field, delta, detail) => ({
      op: 'conflict', entity: item.entity, entity_id: item.entity_id, reason,
      fields: { [field]: { from: delta.from ?? null, to: delta.to, source: 'import', conflict: { reason, ...detail } } },
      evidence: { tier: 'exact_name', matched_name: item.evidence?.matched_name ?? item._name },
      _name: item._name,
    })

    // S2c §4: name->id maps for the DECIDE-phase FK resolution (eligibility/unit),
    // seeded from existing rows exactly as commitPlan's seedNameMaps. Reused (and
    // extended) by the apply phase below, so a group created this run also resolves.
    const tierIdByName = new Map()
    for (const t of state.tiers ?? []) if (t.name && (t.cohort_id ?? null) === cohortId) tierIdByName.set(String(t.name).trim().toLowerCase(), t.id)
    const groupIdByNameRun = new Map()
    for (const g of state.groups ?? []) if (g.name) groupIdByNameRun.set(normalizeName(g.name), g.id)

    // Recognition maps for commit-time re-resolution (normalized-name → set of
    // live ids), cohort-scoped for tiers/time_blocks exactly as the snapshot.
    const recognition = {}
    for (const entity of INGESTIBLE_ENTITIES) {
      recognition[entity] = new Map()
      const scoped = MOCK_COHORT_SCOPED.has(entity)
      for (const r of state[entity] ?? []) {
        if (scoped && cohortId && (r.cohort_id ?? null) !== cohortId) continue
        const key = normalizeName(r[mockNameColumnFor(entity)])
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
    for (const item of plan.items) {
      switch (item.op) {
        case 'create': {
          const ids = recognition[item.entity].get(normalizeName(item._name))
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
            const ids = recognition[item.entity].get(normalizeName(item._name))
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
            const ids = recognition[item.entity].get(normalizeName(item._name))
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
            const enqueue = () => {
              if (isClear) { toUpdate.push({ item, field: dbField, value: null }); return }
              const resolved = resolveFieldWrite(field, delta.to, { groupIdByName: groupIdByNameRun, tierIdByName })
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
          if (['ambiguous_identity', 'stale', 'validation', 'eligibility_unresolved', 'unit_unresolved', 'missing_target', 'duplicate_id', 'possible_lost_id'].includes(item.reason)) conflicts.push(item)
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
      return { held: true, conflicts, created, total: 0, updated: 0, fixedEvents: { created: 0, skipped: [], partial: [] } }
    }

    // No conflicts — apply the plan. tierIdByName / groupIdByNameRun were seeded
    // from existing rows above (for the decide-phase FK resolution) and are
    // extended here as tiers/groups are created, so a group created this run files
    // under a unit created moments earlier — commitPlan's seedNameMaps discipline.

    // commitCreate mirror: extract each FieldDelta's `to`, resolve group tier_id
    // and activity rules against the live/run name maps, insert the row, and mark
    // every written field 'import' provenance.
    const commitCreate = (item) => {
      const entity = item.entity
      const name = item._name
      const id = randomId()
      const fields = {}
      for (const [field, delta] of Object.entries(item.fields)) fields[field] = delta.to
      if (entity === 'tiers') tierIdByName.set(name.toLowerCase(), id)
      if (entity === 'groups') {
        groupIdByNameRun.set(normalizeName(name), id)
        const unit = item._link_unit
        const tierId = unit ? tierIdByName.get(String(unit).trim().toLowerCase()) : null
        if (tierId) fields.tier_id = tierId
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

    // Fixed events (T34) — resolve by name against the rows now in state, then
    // fan out one anchor_activities row per day. Mirrors commitPlan's fixed-event
    // loop so the whole import flow, fixed events included, works at :5200.
    const norm = (s) => normalizeName(s)
    const targetCohort = cohortId ?? 'main'
    const blockIdByName = new Map()
    for (const b of state.time_blocks ?? []) if (b.name && (b.cohort_id ?? null) === cohortId) blockIdByName.set(norm(b.name), b.id)
    const dayIdByName = new Map()
    for (const d of state.days_of_operation ?? []) if (d.label) dayIdByName.set(norm(d.label), d.id)
    const groupIdByName = new Map()
    for (const g of state.groups ?? []) if (g.name) groupIdByName.set(norm(g.name), g.id)

    if (!Array.isArray(state.anchor_activities)) state.anchor_activities = []
    const fixedCreatedIds = []
    const fixedSkipped = []
    const fixedPartial = []
    for (const fe of Array.isArray(fixedEvents) ? fixedEvents : []) {
      const tbId = blockIdByName.get(norm(fe.time_block))
      const requestedDays = (fe.days ?? []).length
      const dayIds = (fe.days ?? []).map((d) => dayIdByName.get(norm(d))).filter(Boolean)
      if (!tbId || dayIds.length === 0) { fixedSkipped.push({ name: fe.name, reason: 'time block or day not created' }); continue }
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
        state.anchor_activities.push({
          id, camp_id: campId, cohort_id: targetCohort, day_id: dayId, time_block_id: tbId,
          name: String(fe.name ?? '').trim(), is_all_groups: isAll, group_ids: JSON.stringify(isAll ? [] : groupIds),
        })
        fixedCreatedIds.push(id)
      }
    }

    saveState(state)
    const outcome = { held: false, conflicts: [], created, total, updated, fixedEvents: { created: fixedCreatedIds.length, skipped: fixedSkipped, partial: fixedPartial } }
    if (replaced) outcome.replaced = replaced
    return outcome
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
  // S4b §4 — the dev mock has no op log/seq clock, so the export stamps 0 and
  // the staleness gate is inert at :5200 (the real clock lives under electron:dev).
  async latestOpSeq() { return 0 },
  async getSyncStatus() {
    return { mode: null, connected: false, state: 'standalone' }
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
  async listDevices() {
    return (loadState().devices || []).map(({ id, name, pairing_status, authorized_at, revoked_at, last_synced_at }) =>
      ({ id, name, pairing_status, authorized_at, revoked_at, last_synced_at }))
  },
  async approveDevice(deviceId) {
    const now = new Date().toISOString()
    updateDevice(deviceId, { pairing_status: 'authorized', authorized_at: now, revoked_at: null })
    return { deviceId, authorized: true }
  },
  async denyDevice(deviceId) {
    updateDevice(deviceId, { pairing_status: 'denied' })
    return { deviceId, denied: true }
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
  onPairingApproved(cb) { pairingApprovedListeners.push(cb); return () => { pairingApprovedListeners = pairingApprovedListeners.filter((f) => f !== cb) } },
  onPairingDenied(cb) { pairingDeniedListeners.push(cb); return () => { pairingDeniedListeners = pairingDeniedListeners.filter((f) => f !== cb) } },
  onTokenRenewed(cb) { tokenRenewedListeners.push(cb); return () => { tokenRenewedListeners = tokenRenewedListeners.filter((f) => f !== cb) } },
  _triggerPairingRequest(payload) { pairingRequestListeners.forEach((cb) => cb(payload)) },
  _triggerPairingApproved(payload) { pairingApprovedListeners.forEach((cb) => cb(payload)) },
  _triggerPairingDenied(payload) { pairingDeniedListeners.forEach((cb) => cb(payload)) },
  _triggerTokenRenewed(payload) { tokenRenewedListeners.forEach((cb) => cb(payload)) },

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
  async listPendingRestores() {
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
    return {
      ok: true,
      entity,
      entity_id,
      name: null,
      destructive: entity === 'groups' || entity === 'days_of_operation',
      slot_count: 0,
      routes: [],
      unprotected_count: 0,
      anchor_count: 0,
      overlay_count: 0,
      weather_dependent_count: 0,
    }
  },
  async deleteRecord() {
    return { error: 'no-record' }
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
    if (!Array.isArray(state.template_overlays)) state.template_overlays = []

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

      const srcOverlays = state.template_overlays.filter((o) => o.template_id === srcTemplate.id)
      for (const o of srcOverlays) {
        state.template_overlays.push({ ...o, id: randomId(), template_id: newTemplateId })
      }
    }

    if (!Array.isArray(state.week_activity_exclusions)) state.week_activity_exclusions = []
    if (!Array.isArray(state.week_group_exclusions)) state.week_group_exclusions = []

    for (const e of state.week_activity_exclusions.filter((e) => e.week_id === sourceWeekId)) {
      state.week_activity_exclusions.push({ id: randomId(), week_id: newWeekId, activity_id: e.activity_id })
    }
    for (const e of state.week_group_exclusions.filter((e) => e.week_id === sourceWeekId)) {
      state.week_group_exclusions.push({ id: randomId(), week_id: newWeekId, group_id: e.group_id })
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
    state.template_overlays = (state.template_overlays || []).filter(o => !templateIds.has(o.template_id))
    state.template_slots = (state.template_slots || []).filter(s => !templateIds.has(s.template_id))
    state.week_activity_exclusions = (state.week_activity_exclusions || []).filter(e => e.week_id !== weekId)
    state.week_group_exclusions = (state.week_group_exclusions || []).filter(e => e.week_id !== weekId)
    state.schedule_templates = (state.schedule_templates || []).filter(t => t.week_id !== weekId)
    state.schedule_weeks = allWeeks.filter(w => w.id !== weekId)

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
  async createProject() {
    return { status: 'not-supported-in-browser-dev' }
  },
  async openProject() {
    return { status: 'not-supported-in-browser-dev' }
  },
  async exportProject() {
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
    for (const k of [STORE_KEY, 'shoresh-mode', 'shoresh-token', 'shoresh-role', 'shoresh-join-host']) {
      localStorage.removeItem(k)
    }
    window.location.replace(window.location.pathname)
  }
  if (window.location.search.includes('demo=schedule')) window.__seedDemo()
}
