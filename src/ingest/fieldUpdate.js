// S2c — the SHARED, pure field-update helpers the real committer
// (electron/ops/ingest.js) and the dev mock (src/localClient.mock.js) both use,
// so the two field-update paths cannot drift.
//
// docs/adr/2026-08-08-s2c-activity-and-group-field-update.md
//
// All three functions are pure and DB-agnostic: they take plain data (records,
// snapshot rows, and pre-built name->id / id->name maps) and return decisions.
// Each caller owns its own persistence (op-log vs localStorage) and wraps the
// conflict DECISIONS below into its own conflict object shape.

import { normalizeName } from './preview.js'

// Int fields validated as positive integers on the update path (create parity).
export const INT_FIELDS = new Set(['min_per_week', 'max_per_week', 'sort_order'])

// A record field name that maps to a DIFFERENT stored column: the source speaks
// FK LABELS (`eligible_groups`, `unit`); the columns are `eligible_group_ids` /
// `tier_id`. Provenance (Policy A) and the write both target the stored column.
export const DB_FIELD = Object.freeze({ eligible_groups: 'eligible_group_ids', unit: 'tier_id' })
export const dbFieldFor = (field) => DB_FIELD[field] ?? field

/**
 * S2c §1. Fold the schedule/clipboard side-channels into the per-row record
 * shape buildPlan consumes: a bare string -> `{ name }`; `activityRules[name]`
 * -> `fields.{min_per_week,max_per_week,priority,eligible_groups,location}`;
 * `links.groups[name]` -> `fields.unit`. Mirrors the create path's own guards
 * (positive-int min/max, high/low priority, non-empty eligibility) so an
 * unchanged rule set produces no delta — F4, including a 0/no-minimum activity.
 * Any `fields` the caller already supplied on a record win (not overwritten).
 */
export function foldApprovedToRecords(approved, activityRules, links) {
  const groupUnits = links?.groups ?? {}
  const out = {}
  for (const [entity, list] of Object.entries(approved ?? {})) {
    if (!Array.isArray(list)) { out[entity] = list; continue }
    out[entity] = list.map((el) => {
      const record = el && typeof el === 'object' ? { ...el } : { name: el }
      const name = String(record.name ?? '').trim()
      if (!name) return record
      const fields = { ...(record.fields ?? {}) }
      if (entity === 'groups' && groupUnits[name] != null && !('unit' in fields)) {
        fields.unit = groupUnits[name]
      }
      if (entity === 'activities') {
        const rule = activityRules?.[name]
        if (rule) {
          if (Number.isInteger(rule.min_per_week) && rule.min_per_week >= 1 && !('min_per_week' in fields)) {
            fields.min_per_week = rule.min_per_week
          }
          if (Number.isInteger(rule.max_per_week) && rule.max_per_week >= 1 && !('max_per_week' in fields)) {
            fields.max_per_week = rule.max_per_week
          }
          if ((rule.priority === 'high' || rule.priority === 'low') && !('priority' in fields)) {
            fields.priority = rule.priority
          }
          if (Array.isArray(rule.eligible_group_names) && rule.eligible_group_names.length > 0
              && !('eligible_groups' in fields)) {
            fields.eligible_groups = rule.eligible_group_names
          }
          if (rule.location != null && rule.location !== '' && !('location' in fields)) {
            fields.location = rule.location
          }
        }
      }
      record.fields = fields
      return record
    })
  }
  return out
}

/**
 * S2c §3. Enrich a snapshot row IN PLACE with the FK LABEL forms buildPlan
 * compares against (it holds no DB handle and cannot resolve ids): activities'
 * `eligible_group_ids` (JSON id array) -> `eligible_group_names` (set of live
 * group names); groups' `tier_id` -> `unit_name` (the live unit name). The
 * caller supplies id->name maps built its own way (SQL vs localStorage).
 */
export function enrichSnapshotRow(entity, row, groupNameById, tierNameById) {
  if (entity === 'activities') {
    let ids = []
    try { ids = JSON.parse(row.eligible_group_ids ?? '[]') } catch { ids = [] }
    row.eligible_group_names = (Array.isArray(ids) ? ids : [])
      .map((id) => groupNameById.get(id))
      .filter((n) => n != null)
  }
  if (entity === 'groups') {
    row.unit_name = row.tier_id != null ? (tierNameById.get(row.tier_id) ?? null) : null
  }
  return row
}

/**
 * S2c §4. Validate + resolve ONE FieldDelta's proposed value on the update path,
 * matching the create path's guards. Returns a DECISION:
 *   { ok: true,  field, value }              — the stored column + value to write
 *   { ok: false, reason, detail }            — a held conflict (no op)
 * where `reason` is one of 'validation' | 'eligibility_unresolved' |
 * 'unit_unresolved'. The caller wraps a failure into its own conflict object.
 * `maps` carries the pre-built `groupIdByName` / `tierIdByName` (normalized-name
 * keys for groups; lower-cased trimmed keys for tiers, matching seedNameMaps).
 */
export function resolveFieldWrite(field, rawTo, { groupIdByName, tierIdByName }) {
  if (INT_FIELDS.has(field)) {
    const n = Number(String(rawTo).trim())
    if (!Number.isInteger(n) || n < 1) {
      return { ok: false, reason: 'validation', detail: { value: rawTo, expected: 'positive integer' } }
    }
    return { ok: true, field, value: n }
  }
  if (field === 'priority') {
    if (rawTo !== 'high' && rawTo !== 'low') {
      return { ok: false, reason: 'validation', detail: { value: rawTo, expected: 'high|low' } }
    }
    return { ok: true, field, value: rawTo }
  }
  if (field === 'eligible_groups') {
    const labels = Array.isArray(rawTo) ? rawTo : []
    const ids = []
    const unresolved = []
    for (const lbl of labels) {
      const id = groupIdByName.get(normalizeName(lbl))
      if (id) ids.push(id)
      else unresolved.push(lbl)
    }
    if (unresolved.length > 0) {
      // Never silently drop a director-typed eligibility (RISK N) — surface it.
      return { ok: false, reason: 'eligibility_unresolved', detail: { unresolved } }
    }
    // Canonical (sorted) id list so an idempotent re-write is byte-identical.
    return { ok: true, field: 'eligible_group_ids', value: JSON.stringify([...ids].sort()) }
  }
  if (field === 'unit') {
    const id = tierIdByName.get(String(rawTo).trim().toLowerCase())
    if (!id) return { ok: false, reason: 'unit_unresolved', detail: { unresolved: [rawTo] } }
    return { ok: true, field: 'tier_id', value: id }
  }
  // Free-text / other fields (location, day_of_week, availability, times, name)
  // write as-is, exactly as the pre-S2c update path did.
  return { ok: true, field, value: rawTo }
}
