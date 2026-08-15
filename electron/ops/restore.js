import { appendOp, DELETE_FIELD, BULK_REPLACE_FIELD } from './operations.js'
import { PROJECTIONS } from './projections.js'
import { deriveLocationId } from './locationId.js'

// Which projected entities may be restored, and — for the ones that may not —
// why. Every key of PROJECTIONS must appear here; restore.test.js fails if a
// new entity joins the registry without a deliberate decision, which is the
// guard docs/adr/2026-07-30-restore-deleted-records-from-the-op-log.md §4 asks
// for by name.
//
// The refusal that matters most is `users`. It is a writable projection, so a
// deleted user's ops include pin_hash and pin_salt, and a restore re-emits
// last-known field values through the ORDINARY write path — meaning those two
// ops would replicate to every device, resurrecting a deliberately-removed
// account with its old PIN intact. main.js's IPC_PIN_FIELDS guard does not
// help: it filters what reaches the RENDERER, not what is written to the log.
// Account recovery is a separate concern with different rules and must not
// arrive as a side effect of a trash can.
export const RESTORE_DECISIONS = Object.freeze({
  cohorts: 'restorable',
  tiers: 'restorable',
  groups: 'restorable',
  activities: 'restorable',
  days_of_operation: 'restorable',
  time_blocks: 'restorable',
  anchor_activities: 'restorable',
  day_override_templates: 'restorable',
  locations: 'restorable',

  users: 'refused: a restore would re-emit pin_hash and pin_salt as replicating ops',
  camps: 'refused: singleton identity row, created only by bootstrapCamp',
  devices: 'refused: device trust is granted by pairing, never rebuilt from a log',
  schedule_templates: 'refused: a route, not a record — recreated by opening the route',
  schedule_weeks: 'refused: weeks are archived (reversible), never trashed, in this slice — a later delete slice decides restorability',
  template_slots: 'refused: schedule edits already have snapshots on ScheduleScreen',
  template_overlays: 'refused: schedule edits already have snapshots on ScheduleScreen',
  schedule_snapshots: 'refused: a snapshot is itself the undo story; nesting one is confusing',
  day_override_template_slots: 'refused: rebuilt with its parent override, not on its own',
  week_activity_exclusions: 'refused: rebuilt by toggling the exclusion UI or duplicating the week',
  week_group_exclusions: 'refused: rebuilt by toggling the exclusion UI or duplicating the week',
  week_location_exclusions: 'refused: rebuilt by toggling the exclusion UI or duplicating the week',
  conflicts: 'refused: conflicts are closed by resolution or by a week delete, never by trash',
})

export const RESTORABLE_ENTITIES = Object.freeze(
  new Set(Object.keys(RESTORE_DECISIONS).filter((e) => RESTORE_DECISIONS[e] === 'restorable'))
)

// Which restorable entity points at which, and through which column. Used
// only to REPORT a restored parent's deleted children — never to restore
// them. A cascade cannot distinguish "deleted along with the parent" from
// "deleted deliberately, earlier", and would silently resurrect the second
// kind (ADR §3). Orphans are permitted; the app already renders a missing
// parent as an em dash.
const CHILD_LINKS = {
  cohorts: [
    { entity: 'tiers', field: 'cohort_id' },
    { entity: 'time_blocks', field: 'cohort_id' },
    { entity: 'anchor_activities', field: 'cohort_id' },
    { entity: 'day_override_templates', field: 'cohort_id' },
  ],
  tiers: [{ entity: 'groups', field: 'tier_id' }],
  days_of_operation: [{ entity: 'anchor_activities', field: 'day_id' }],
  time_blocks: [{ entity: 'anchor_activities', field: 'time_block_id' }],
}

// days_of_operation has no `name` column; its human label lives in `label`.
// A trash row showing a bare uuid is useless to a director (Art. V), so every
// restorable entity needs a field that reads as a name.
export const NAME_FIELD = {
  days_of_operation: 'label',
}

export function nameFieldFor(entity) {
  return NAME_FIELD[entity] ?? 'name'
}

export function latestOpForEntity(db, entity, entity_id) {
  return db
    .prepare('SELECT * FROM operations WHERE entity = ? AND entity_id = ? ORDER BY seq DESC LIMIT 1')
    .get(entity, entity_id)
}

// Last value written for each field of one record, sentinels excluded and
// anything the projection does not own excluded. Ordered by seq, so the last
// row for a field wins.
export function lastKnownFields(db, entity, entity_id) {
  const projection = PROJECTIONS[entity]
  const allowed = new Set(projection ? projection.fields : [])
  const values = new Map()
  const rows = db
    .prepare('SELECT field, value FROM operations WHERE entity = ? AND entity_id = ? ORDER BY seq ASC')
    .all(entity, entity_id)
  for (const row of rows) {
    if (row.field === DELETE_FIELD || row.field === BULK_REPLACE_FIELD) continue
    if (!allowed.has(row.field)) continue
    values.set(row.field, row.value)
  }
  return values
}

// S2a: the provenance (`source`) of the last op that wrote each field — same
// last-write-wins scan as lastKnownFields. restoreEntity carries this forward
// so a trash->restore cycle does not LAUNDER an import-owned field into a
// human-owned (NULL) one, which would silently convert Policy A into Policy B
// for any restored entity (ADR §2, R2). A field whose last op has no recorded
// source (all pre-v29 history) maps to NULL — the documented, deliberate
// over-protection (a false "protect" costs a review click, never a lost edit).
export function lastKnownFieldSources(db, entity, entity_id) {
  const projection = PROJECTIONS[entity]
  const allowed = new Set(projection ? projection.fields : [])
  const sources = new Map()
  const rows = db
    .prepare('SELECT field, source FROM operations WHERE entity = ? AND entity_id = ? ORDER BY seq ASC')
    .all(entity, entity_id)
  for (const row of rows) {
    if (row.field === DELETE_FIELD || row.field === BULK_REPLACE_FIELD) continue
    if (!allowed.has(row.field)) continue
    sources.set(row.field, row.source ?? null)
  }
  return sources
}

export function isDeleted(db, entity, entity_id) {
  const latest = latestOpForEntity(db, entity, entity_id)
  return !!latest && latest.field === DELETE_FIELD
}

function deletedChildrenOf(db, entity, entity_id) {
  const children = []
  for (const link of CHILD_LINKS[entity] ?? []) {
    const candidates = db
      .prepare(
        `SELECT DISTINCT entity_id FROM operations WHERE entity = ? AND field = ? AND value = ?`
      )
      .all(link.entity, link.field, entity_id)
    for (const { entity_id: childId } of candidates) {
      const fields = lastKnownFields(db, link.entity, childId)
      // A child that was re-parented away since is not this parent's child.
      if (fields.get(link.field) !== entity_id) continue
      if (!isDeleted(db, link.entity, childId)) continue
      children.push({
        entity: link.entity,
        entity_id: childId,
        name: fields.get(nameFieldFor(link.entity)) ?? null,
      })
    }
  }
  return children
}

// Re-emit a deleted record's last-known field values as ordinary ops.
// `ensureExists` on the projection re-inserts the row; the field ops
// repopulate it. There is no `__restored__` sentinel by design: a sentinel
// asks every device to rebuild the row from its own local history, and a
// device that paired after the record was created does not have that history.
//
// HOST ONLY. This reads the op log, and only the Host is guaranteed to hold
// it — a first-pairing Client receives materialized rows, not op history, and
// its watermark starts at the then-current max. A Client sends a
// restore_request over the existing WebSocket instead (syncServer.js) and
// queues it when the Host is unreachable (pendingRestores.js).
//
// Returns { ok, restored_fields, deleted_children, ops } or { error }. The ops
// are returned rather than broadcast here so the caller can broadcast AFTER
// the transaction commits — announcing ops that could still roll back would be
// worse than announcing them a moment late.
export function restoreEntity(db, { entity, entity_id, author_user_id, device_id }) {
  // Allowlist FIRST, before anything reads the log, so no path can reach the
  // history of a refused entity — `users` above all.
  if (!RESTORABLE_ENTITIES.has(entity)) return { error: 'not-restorable' }
  if (typeof entity_id !== 'string' || entity_id.length === 0) return { error: 'no-history' }

  if (!isDeleted(db, entity, entity_id)) return { error: 'not-deleted' }

  const fields = lastKnownFields(db, entity, entity_id)
  // S2a: preserve each restored field's ORIGINAL provenance (R2). Recoverable
  // here because restore already reads the op history; a field with no recorded
  // source maps to NULL (human) — the documented over-protection.
  const sources = lastKnownFieldSources(db, entity, entity_id)
  // Every restorable entity's projection registers camp_id, and every create
  // path writes it — so its absence means this device does not hold the
  // record's creation, and restoring would produce a shell.
  if (!fields.has('camp_id')) return { error: 'no-history' }

  // camp_id first: applyProjection's camp guard rejects a camp_id that does
  // not match this device's camp, and ensureExists needs the row to exist
  // before any other field can update it.
  const ordered = [['camp_id', fields.get('camp_id')], ...[...fields].filter(([f]) => f !== 'camp_id')]

  // INV-2 (v32, docs/adr/2026-08-15-camp-locations-entity.md): a pre-v32
  // activity's location_id is a MIGRATION side effect that exists nowhere in the
  // op log, so lastKnownFields cannot carry it — a naive restore would leave it
  // NULL and silently un-bind the activity from its place. Re-resolve it from
  // the frozen `location` string by the SAME TRIM-only, case-sensitive key the
  // migration used (INV-1 / deriveLocationId). If no locations row matches (the
  // place was deleted), leave location_id NULL and keep the string — the
  // coherent frozen-column-only state. If location_id was itself written via an
  // op (a post-v32 edit), it is already in `fields` and restored normally; do
  // not override it.
  let rebindLocationId = null
  if (entity === 'activities' && !fields.has('location_id')) {
    const name = String(fields.get('location') ?? '').trim()
    if (name !== '') {
      const derivedId = deriveLocationId(fields.get('camp_id'), name)
      if (db.prepare('SELECT 1 FROM locations WHERE id = ?').get(derivedId)) {
        rebindLocationId = derivedId
      }
    }
  }

  const ops = db.transaction(() => {
    const emitted = ordered.map(([field, value]) =>
      appendOp(db, { entity, entity_id, field, value, author_user_id, device_id, source: sources.get(field) ?? null })
    )
    if (rebindLocationId) {
      // A restore-time re-binding is a fresh human-authored fact, not import
      // provenance — source null (= human) protects it like any manual edit.
      emitted.push(
        appendOp(db, { entity, entity_id, field: 'location_id', value: rebindLocationId, author_user_id, device_id, source: null })
      )
    }
    return emitted
  })()

  return {
    ok: true,
    restored_fields: ops.length,
    deleted_children: deletedChildrenOf(db, entity, entity_id),
    ops,
  }
}
