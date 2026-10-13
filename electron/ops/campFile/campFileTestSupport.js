// Test support for the whole-camp file tests (not a test file). Builds a fixture camp through the REAL write
// primitives (commitIngest, appendOp, appendBulkReplaceOp) so the fixture is whatever the app would have written,
// and holds the every-table comparison helper. The comparison imports the production scope list rather than
// reimplementing it (ADR section 6).

import { createHash, randomUUID } from 'node:crypto'
import { appendOp, appendBulkReplaceOp } from '../operations.js'
import { commitIngest } from '../ingest.js'
import { PROJECTIONS } from '../projections.js'
import { deriveDayId } from '../dayId.js'
import { deriveLocationId } from '../locationId.js'
import { deriveScheduleTemplateId } from '../scheduleTemplateId.js'
import {
  deriveElectiveSetId,
  deriveSpecialDayId,
  deriveSpecialDayActivityId,
  deriveSpecialDayTimeBlockId,
  deriveSpecialDaySlotId,
  deriveSpecialDayPlacementId,
  deriveCampSeedlingId,
} from '../electiveDerivedIds.js'
import { defaultWeekId } from '../../../src/ingest/defaultWeek.js'
import { deriveMainCohortId } from '../../../src/utils/mainCohortId.js'
import { ensureHostSigningKey } from '../../auth/localAuth.js'
import { signAuthFields } from '../../auth/authSignature.js'
import {
  EXPORTED_ENTITIES,
  LEARNED_TABLES,
  STAMPED_FIELDS,
  REFERENCE_LIST_FIELDS,
} from './campFileScope.js'

const WEEKDAYS = [
  { label: 'Monday', dow: 1 }, { label: 'Tuesday', dow: 2 }, { label: 'Wednesday', dow: 3 },
  { label: 'Thursday', dow: 4 }, { label: 'Friday', dow: 5 },
]

// A bootstrapped camp as bootstrapCamp + the first-session effects (seedDays, ensureCohort) leave it:
// a camps row with its signing material, one signed admin, this device, the Mon-Fri derived day rows and the Main cohort.
export function makeFreshCamp(db, { campId = randomUUID(), name = 'Camp Probe', deviceId = `device-${randomUUID()}`, adminName = 'Ruth', seed = true } = {}) {
  db.prepare('INSERT INTO devices (id, name) VALUES (?, ?)').run(deviceId, `Device ${deviceId.slice(0, 6)}`)
  db.prepare('INSERT INTO camps (id, name, signing_secret) VALUES (?, ?, ?)').run(campId, name, randomUUID().replace(/-/g, '').padEnd(64, 'a'))
  const userId = randomUUID()
  db.prepare("INSERT INTO users (id, camp_id, name, pin_hash, pin_salt, role) VALUES (?, ?, ?, ?, ?, 'admin')").run(userId, campId, adminName, `hash-${userId}`, `salt-${userId}`)
  const hostKey = ensureHostSigningKey(db)
  db.prepare('UPDATE camps SET signing_public_key = ? WHERE id = ?').run(hostKey.public_key, campId)
  db.prepare('UPDATE users SET auth_sig = ?, cred_version = 1 WHERE id = ?')
    .run(signAuthFields(db, { id: userId, role: 'admin', pin_hash: `hash-${userId}`, pin_salt: `salt-${userId}`, cred_version: 1 }), userId)
  const camp = { campId, deviceId, userId, name }
  if (seed) seedFirstSession(db, camp)
  return camp
}

export function seedFirstSession(db, camp) {
  const put = putter(db, camp)
  for (const [i, d] of WEEKDAYS.entries()) put('days_of_operation', deriveDayId(camp.campId, d.dow), { label: d.label, day_of_week: d.dow, sort_order: i + 1 })
  put('cohorts', deriveMainCohortId(camp.campId), { name: 'Main', session_week_start: 1, session_week_end: 1, capacity_source: 'groups_per_slot', fixed_event_model: 'fixed' })
}

// Field-by-field writes through appendOp, in the declared order except `kind` first (a recurring fixed event and a
// template pair both need it before anything that depends on it).
export function putter(db, camp) {
  return (entity, id, fields) => {
    const declared = PROJECTIONS[entity].fields
    const names = Object.keys(fields)
    for (const f of names) if (f !== 'camp_id' && !declared.includes(f)) throw new Error(`fixture: ${entity}.${f} is not a declared field`)
    const all = declared.includes('camp_id') ? { camp_id: camp.campId, ...fields } : fields
    const ordered = Object.keys(all).sort((a, b) => (a === 'kind' ? -1 : b === 'kind' ? 1 : 0))
    for (const field of ordered) {
      appendOp(db, { entity, entity_id: id, field, value: all[field], device_id: camp.deviceId, author_user_id: camp.userId })
    }
    return id
  }
}

const idList = (...ids) => JSON.stringify(ids)

// Covers every entity the file exports, both schedules with slots, saved versions, a special day with a placement,
// an elective set with bundles, events with children, locations, week exclusions, a camp map, remembered answers
// and a few rows in each learned table. Returns the ids a test wants to name.
export function buildFixtureCamp(db, camp) {
  const { campId, deviceId, userId } = camp
  const put = putter(db, camp)
  const op = (entity, entity_id, field, value) => appendOp(db, { entity, entity_id, field, value, device_id: deviceId, author_user_id: userId })

  commitIngest(db, {
    approved: {
      cohorts: ['Main'], tiers: ['Aleph', 'Bet'], groups: ['Bunk 1', 'Bunk 2', 'Bunk 3'],
      days_of_operation: ['Monday', 'Tuesday', 'Wednesday'], time_blocks: ['09:00-09:40', '10:00-10:40', '11:00-11:40'],
      activities: ['Swim', 'Archery', 'Arts'],
    },
    links: { groups: { 'Bunk 1': 'Aleph', 'Bunk 2': 'Aleph', 'Bunk 3': 'Bet' } },
    activityRules: {
      Swim: { eligible_group_names: ['Bunk 1', 'Bunk 2', 'Bunk 3'], min_per_week: 2, max_per_week: 3, priority: 'high' },
      Archery: { eligible_group_names: ['Bunk 1'], min_per_week: 0, max_per_week: 1, priority: 'low' },
    },
    fixedEvents: [{ name: 'Mifkad', time_block: '09:00-09:40', days: ['Monday'], scope: { is_all_groups: true, groups: [] } }],
    camp_id: campId, cohort_id: null, author_user_id: userId, device_id: deviceId, mode: 'add',
  })

  const one = (sql, ...args) => db.prepare(sql).get(...args)
  const g1 = one("SELECT id FROM groups WHERE name = 'Bunk 1'").id
  const g2 = one("SELECT id FROM groups WHERE name = 'Bunk 2'").id
  const g3 = one("SELECT id FROM groups WHERE name = 'Bunk 3'").id
  const tierA = one("SELECT id FROM tiers WHERE name = 'Aleph'").id
  const tierB = one("SELECT id FROM tiers WHERE name = 'Bet'").id
  const swim = one("SELECT id FROM activities WHERE name = 'Swim'").id
  const archery = one("SELECT id FROM activities WHERE name = 'Archery'").id
  const arts = one("SELECT id FROM activities WHERE name = 'Arts'").id
  const mon = one('SELECT id FROM days_of_operation WHERE day_of_week = 1').id
  const tue = one('SELECT id FROM days_of_operation WHERE day_of_week = 2').id
  const blocks = db.prepare('SELECT id FROM time_blocks ORDER BY start_time').all().map((r) => r.id)
  const mifkad = one("SELECT id FROM fixed_events WHERE name = 'Mifkad'").id

  const mapId = put('camp_maps', randomUUID(), { image_data: 'data:image/jpeg;base64,/9j/4AAQSkZJRg==', image_mime: 'image/jpeg', image_width: 40, image_height: 30, kind: 'photo' })
  const lake = put('locations', deriveLocationId(campId, 'Lake'), { name: 'Lake', capacity: 3, notes: "Waterfront, shallow end", sort_order: 1, kind: 'pool', grid_x: 2, grid_y: 3, map_id: mapId })
  const gym = put('locations', deriveLocationId(campId, 'Arts & Crafts: Room 2'), { name: 'Arts & Crafts: Room 2', capacity: 2, sort_order: 2 })
  const field = put('locations', randomUUID(), { name: 'Field', capacity: 4, sort_order: 3 })

  op('activities', swim, 'location_id', lake)
  op('activities', swim, 'eligible_tier_ids', idList(tierA, tierB))
  op('activities', archery, 'eligible_group_ids', idList(g1, g2))
  op('activities', archery, 'weather_alternative_id', arts)
  op('activities', arts, 'location_id', gym)

  const recurring = put('fixed_events', randomUUID(), {
    kind: 'recurring', name: 'Davening', is_all_groups: 0, group_ids: idList(g1, g3), unit_ids: idList(tierA),
    day_id: mon, time_block_id: blocks[1], location_id: field, activity_id: arts, span_blocks: 1, notes: 'Everyone',
  })

  const week1 = put('schedule_weeks', defaultWeekId(campId), { name: 'Week 1', sort_order: 0, is_archived: 0 })
  const week2 = put('schedule_weeks', randomUUID(), { name: 'Week 2', sort_order: 1, is_archived: 0 })
  const tplGen = put('schedule_templates', deriveScheduleTemplateId(week1, 'generated'), { kind: 'generated', week_id: week1, name: 'Generated' })
  const tplMan = put('schedule_templates', deriveScheduleTemplateId(week1, 'manual'), { kind: 'manual', week_id: week1, name: 'Manual' })
  const tplWeek2 = put('schedule_templates', randomUUID(), { kind: 'manual', week_id: week2, name: 'Week 2 manual' })

  put('week_activity_exclusions', randomUUID(), { week_id: week2, activity_id: swim })
  put('week_group_exclusions', randomUUID(), { week_id: week2, group_id: g3 })
  put('week_location_exclusions', randomUUID(), { week_id: week2, location_id: lake })

  const setId = put('elective_sets', deriveElectiveSetId(campId, 'Afternoon Choice'), {
    name: 'Afternoon Choice', sort_order: 1, is_reusable: 1, day_id: mon, time_block_id: blocks[2], is_all_groups: 0,
    group_ids: idList(g1, g2), schedule_week_id: week1,
  })
  const esa = put('elective_set_activities', `elective-import:${setId}:${swim}`, { elective_set_id: setId, activity_id: swim, capacity_mode: 'limited', capacity_limit: 8, status: 'confirmed', min_mode: 'required', min_to_run: 3 })
  put('elective_set_activities', randomUUID(), { elective_set_id: setId, activity_id: archery, status: 'potential' })
  const bundle = put('elective_bundles', `elective-bundle-import:${setId}:${swim}:${mon}:${blocks[1]},${blocks[2]}`, { elective_set_id: setId, activity_id: swim, name: 'Swim - Monday', scope_mode: 'all', sort_order: 1 })
  put('elective_bundle_periods', `${bundle}:${blocks[1]}`, { bundle_id: bundle, day_id: mon, time_block_id: blocks[1] })
  put('elective_bundle_periods', `${bundle}:${blocks[2]}`, { bundle_id: bundle, day_id: mon, time_block_id: blocks[2] })
  put('elective_bundle_tiers', randomUUID(), { bundle_id: bundle, tier_id: tierA })

  const eventId = put('events', randomUUID(), { name: 'Visiting Day', sort_order: 1, notes: 'Parents arrive at ten', location_id: field })
  const evTb = put('event_time_blocks', `event-import:${eventId}:block:s1`, { event_id: eventId, name: 'Arrival', sort_order: 0, start_time: '10:00', end_time: '11:00' })
  const evGroup = put('event_groups', `event-import:${eventId}:group:s2`, { event_id: eventId, name: 'Parents', sort_order: 0 })
  put('event_slots', `event-import:${eventId}:slot:s3`, { event_id: eventId, event_group_id: evGroup, time_block_id: evTb, activity_id: arts, location_id: gym })
  const eventId2 = put('events', randomUUID(), { name: 'Color War', sort_order: 2 })
  const evTb2 = put('event_time_blocks', randomUUID(), { event_id: eventId2, name: 'Round 1', sort_order: 0 })
  const evGroup2 = put('event_groups', randomUUID(), { event_id: eventId2, name: 'Blue', sort_order: 0 })
  put('event_slots', randomUUID(), { event_id: eventId2, event_group_id: evGroup2, time_block_id: evTb2 })

  const sdId = put('special_days', deriveSpecialDayId(campId, 'Color War Day'), { name: 'Color War Day', sort_order: 1, notes: 'All day' })
  const sdAct = put('activities', deriveSpecialDayActivityId(campId, 'Relay'), { name: 'Relay', priority: 1 })
  const sdTb = put('special_day_time_blocks', deriveSpecialDayTimeBlockId(sdId, 0), { special_day_id: sdId, name: 'Morning', sort_order: 0, start_time: '09:00', end_time: '12:00' })
  put('special_day_slots', deriveSpecialDaySlotId(sdId, g1, sdTb), { special_day_id: sdId, group_id: g1, time_block_id: sdTb, activity_id: sdAct, location_id: field })
  put('special_day_placements', deriveSpecialDayPlacementId(week1, tue), { week_id: week1, day_id: tue, special_day_id: sdId })

  const slot = (extra) => ({ id: randomUUID(), is_fixed_event: '0', is_span_head: '0', is_released: '0', ...extra })
  appendBulkReplaceOp(db, {
    entity: 'template_slots', scope_id: tplGen, device_id: deviceId, author_user_id: userId,
    rows: [
      slot({ template_id: tplGen, group_id: g1, activity_id: swim, day_id: mon, time_block_id: blocks[0], flags: '["UNFILLABLE"]' }),
      slot({ template_id: tplGen, group_id: g2, activity_id: archery, day_id: mon, time_block_id: blocks[0] }),
      slot({ template_id: tplGen, group_id: g1, day_id: mon, time_block_id: blocks[1], fixed_event_id: recurring, is_fixed_event: '1' }),
      slot({ template_id: tplGen, group_id: g3, day_id: tue, time_block_id: blocks[2], elective_set_id: setId }),
    ],
  })
  appendBulkReplaceOp(db, {
    entity: 'template_slots', scope_id: tplMan, device_id: deviceId, author_user_id: userId,
    rows: [
      slot({ template_id: tplMan, group_id: g1, activity_id: arts, day_id: tue, time_block_id: blocks[0], is_span_head: '1' }),
      slot({ template_id: tplMan, group_id: g2, day_id: tue, time_block_id: blocks[1], event_id: eventId }),
      slot({ template_id: tplMan, group_id: g1, day_id: mon, time_block_id: blocks[0], fixed_event_id: mifkad, is_fixed_event: '1', activity_id: swim }),
    ],
  })

  const snapSlots = (extra = []) => JSON.stringify([
    { group_id: g1, day_id: mon, time_block_id: blocks[0], activity_id: swim, names: { group: 'Bunk 1', day: 'Monday', block: '09:00-09:40', activity: 'Swim' } },
    { group_id: g2, day_id: tue, time_block_id: blocks[1], fixed_event_id: mifkad, is_fixed_event: true, event_id: eventId, elective_set_id: setId, names: { group: 'Bunk 2' } },
    ...extra,
  ])
  const snap1 = put('schedule_snapshots', randomUUID(), { template_id: tplMan, name: 'Before camp', is_auto: 0, created_at: '2026-06-01T10:00:00.000Z', slots: snapSlots() })
  const snap2 = put('schedule_snapshots', randomUUID(), {
    template_id: tplGen, name: 'Auto', is_auto: 1, created_at: '2026-06-02T10:00:00.000Z',
    slots: snapSlots([{ group_id: randomUUID(), day_id: mon, time_block_id: blocks[0], activity_id: randomUUID(), names: { group: 'Deleted bunk' } }]),
  })

  const answerId = deriveCampSeedlingId(campId, 'import_answer', `${'a'.repeat(64)}-${randomUUID()}`)
  const vetoId = deriveCampSeedlingId(campId, 'import_rule_veto', `${'b'.repeat(64)}-${randomUUID()}`)
  put('camp_seedlings', answerId, {
    kind: 'import_answer', match_key: `${'a'.repeat(64)}-${randomUUID()}`, status: 'active', confirmed_at: '2026-06-03T10:00:00.000Z',
    payload: JSON.stringify({ v: 1, qkind: 'activity', role: 'instance', seq: 1, parts: ['swim'], refs: [swim, `alias:${randomUUID()}`, g1], supersedes: [], answer: { id: swim } }),
  })
  put('camp_seedlings', vetoId, {
    kind: 'import_rule_veto', match_key: `${'b'.repeat(64)}-${randomUUID()}`, status: 'active', confirmed_at: '2026-06-04T10:00:00.000Z',
    payload: JSON.stringify({ v: 1, qkind: 'activity', role: 'instance', seq: 2, parts: ['T1', 'x'], covers: [createHash('sha256').update(answerId).digest('hex').slice(0, 12)], supersedes: [answerId] }),
  })
  put('camp_seedlings', deriveCampSeedlingId(campId, 'preference_column_roles', `${'c'.repeat(64)}-${randomUUID()}`), {
    kind: 'preference_column_roles', match_key: `${'c'.repeat(64)}-${randomUUID()}`, confirmed_at: '2026-06-05T10:00:00.000Z', payload: JSON.stringify({ roles: ['name', 'choice1'] }),
  })

  const learned = insertLearnedRows(db, campId, userId, { swim, g1, tierA })

  return {
    g1, g2, g3, tierA, tierB, swim, archery, arts, mon, tue, blocks, mifkad, lake, gym, field, mapId, recurring, week1, week2, tplGen, tplMan, tplWeek2,
    setId, esa, bundle, eventId, eventId2, sdId, sdAct, sdTb, snap1, snap2, answerId, vetoId, learned,
  }
}

function insertLearnedRows(db, campId, userId, { swim, g1, tierA }) {
  const ins = (table, row) => {
    const cols = Object.keys(row)
    db.prepare(`INSERT INTO ${table} (${cols.join(', ')}) VALUES (${cols.map(() => '?').join(', ')})`).run(...cols.map((c) => row[c]))
    return row.id
  }
  const aliasId = randomUUID()
  return {
    alias: ins('source_aliases', { id: aliasId, camp_id: campId, entity_type: 'activities', cohort_id: null, source_label: 'Swimming', entity_id: swim, status: 'active', confirmed_by: userId, confirmed_at: '2026-06-01T00:00:00.000Z', superseded_by: null }),
    alias2: ins('source_aliases', { id: randomUUID(), camp_id: campId, entity_type: 'groups', cohort_id: null, source_label: 'Bunk One', entity_id: g1, status: 'active', confirmed_by: userId, confirmed_at: '2026-06-01T00:00:00.000Z', superseded_by: null }),
    compound: ins('compound_cell_decisions', { id: randomUUID(), camp_id: campId, pattern: 'Swim/Arts', interpretation: 'two', base_name: 'Swim', wrapper_name: 'Arts', confirmed_by: userId, confirmed_at: '2026-06-01T00:00:00.000Z' }),
    word: ins('location_word_decisions', { id: randomUUID(), camp_id: campId, word_key: 'lake', raw_word: 'Lake', decision: 'place', confirmed_by: userId, confirmed_at: '2026-06-01T00:00:00.000Z' }),
    split: ins('declined_two_row_splits', { id: randomUUID(), camp_id: campId, activity_name_normalized: 'swim', declined_at: '2026-06-01T00:00:00.000Z' }),
    decision: ins('import_decisions', { id: randomUUID(), camp_id: campId, import_id: 'imp-1', kind: 'activity', seedling_key: 'k1', lane: 'a', proposed: '{}', outcome: 'accepted', chosen: '{}', learned_from_id: null, decided_at: '2026-06-01T00:00:00.000Z', actor_user_id: userId }),
    evidence: ins('import_evidence', { id: randomUUID(), camp_id: campId, entity_type: 'activities', entity_id: swim, field: 'name', tag: 'file', confidence: 'high', support: '1', import_run_id: 'run-1', committed_at: '2026-06-01T00:00:00.000Z' }),
    reconciliation: ins('open_reconciliation_decisions', { id: randomUUID(), camp_id: campId, entity_type: 'tiers', cohort_id: null, entity_id: tierA, identity_key: 'ik', kind: 'held', domain_key: 'dk', child_key: 'ck', entity_name: 'Aleph', reason: 'because', import_run_id: 'run-1', created_at: '2026-06-01T00:00:00.000Z', payload: null }),
  }
}

// ---- the every-table comparison ------------------------------------------------------------------------------

const digest12 = (s) => createHash('sha256').update(String(s)).digest('hex').slice(0, 12)
const canonicalJson = (text) => {
  try { return JSON.stringify(JSON.parse(text)) } catch { return text }
}

function selectEntity(db, entity) {
  const p = PROJECTIONS[entity]
  const fields = PROJECTIONS[entity].fields.filter((f) => !(STAMPED_FIELDS[entity] ?? []).includes(f))
  return db.prepare(`SELECT ${p.key}, ${fields.join(', ')} FROM ${p.table} ORDER BY ${p.key}`).all()
}

// Every exported table plus the seven learned tables, as rows keyed by table, camp id replaced by a placeholder in
// every string (ids that embed the camp id compare equal to their re-derived twin), user ids replaced, digests of
// remembered-answer ids recomputed from the normalized id. Independent of the loader's own id decoding.
export function normalizedCampSnapshot(db, { campId, userId }) {
  const out = {}
  const seedlingIds = db.prepare('SELECT id FROM camp_seedlings').all().map((r) => r.id)
  const digestToNormalized = new Map(seedlingIds.map((id) => [digest12(id), `digest(${id.split(campId).join('<CAMP>')})`]))
  const norm = (v) => {
    if (typeof v !== 'string') return v
    let s = v.split(campId).join('<CAMP>').split(userId).join('<USER>')
    for (const [d, n] of digestToNormalized) if (s.includes(d)) s = s.split(d).join(n)
    return s
  }
  for (const entity of EXPORTED_ENTITIES) {
    const listFields = Object.keys(REFERENCE_LIST_FIELDS[entity] ?? {})
    const jsonFields = [...listFields, ...(entity === 'schedule_snapshots' ? ['slots'] : []), ...(entity === 'camp_seedlings' ? ['payload'] : [])]
    out[entity] = selectEntity(db, entity).map((row) => {
      const r = {}
      for (const [k, v] of Object.entries(row)) r[k] = norm(jsonFields.includes(k) && typeof v === 'string' ? canonicalJson(norm(v)) : v)
      if (STAMPED_FIELDS[entity]) for (const f of STAMPED_FIELDS[entity]) r[f] = '<stamped>'
      return r
    })
  }
  for (const [table, spec] of Object.entries(LEARNED_TABLES)) {
    out[table] = db.prepare(`SELECT ${spec.columns.join(', ')} FROM ${table} ORDER BY id`).all().map((row) => Object.fromEntries(Object.entries(row).map(([k, v]) => [k, norm(v)])))
  }
  return out
}

export function tableCounts(snapshot) {
  return Object.fromEntries(Object.entries(snapshot).map(([t, rows]) => [t, rows.length]))
}

// Everything text in every table of the database, joined: the corpus for "this string appears nowhere".
export function wholeDatabaseText(db) {
  const tables = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'").all().map((r) => r.name)
  const parts = []
  for (const t of tables) {
    for (const row of db.prepare(`SELECT * FROM ${t}`).all()) parts.push(JSON.stringify(row))
  }
  return parts.join('\n')
}
