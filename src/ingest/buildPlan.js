// buildPlan — the PURE decision layer between an import proposal and the commit.
//
// docs/adr/2026-08-08-reconciliation-plan-as-commit-input.md
// docs/work/onboarding-reconciliation/RECONCILIATION_PLAN_TYPE.md
//
// A ReconciliationPlan is serializable data describing what an import WOULD do.
// buildPlan decides; it never writes and holds no DB handle. commitPlan
// (electron/ops/ingest.js) is the single privileged committer that resolves the
// plan against the live DB and translates each FieldDelta 1:1 into an appendOp.
//
// S0 exercises only the `create` and `unchanged` arms; the type is cut wide
// enough (per the type doc) to hold update/clear/conflict on day one, but those
// arms are typed-only and rejected at commit until their later slices.

import { INGESTIBLE_ENTITIES } from './extractEntities.js'
import { normalizeName } from './preview.js'

// The tri-state CLEAR sentinel (type doc §3): a field present in the map with
// `to: CLEAR` means "remove", distinct from absent (leave untouched) and from
// `to: null` (a genuine null value). Unused by S0's create/unchanged arms; kept
// here so the `clear` arm has a real sentinel to key on in its later slice.
export const CLEAR = Symbol('clear')

const DAY_INDEX = {
  sunday: 0, monday: 1, tuesday: 2, wednesday: 3, thursday: 4, friday: 5, saturday: 6,
}

// "08:40–09:00" / "9:15-9:40" -> { start_time, end_time }. Returns nulls when
// the label is not a range, which is normal — a period may be named "Block 2".
function parseTimeRange(label) {
  const match = String(label ?? '').match(/(\d{1,2})[:.](\d{2})\s*[-–—]\s*(\d{1,2})[:.](\d{2})/)
  if (!match) return { start_time: null, end_time: null }
  const pad = (h, m) => `${String(h).padStart(2, '0')}:${m}`
  return { start_time: pad(match[1], match[2]), end_time: pad(match[3], match[4]) }
}

// The fields each entity needs beyond its name, derived rather than guessed.
// PURE: it takes only the campId, the row's index (for sort_order / a
// day-of-week fallback), and the Program the director is importing into. A null
// `cohortId` yields a null cohort_id field, which the committer skips — exactly
// the pre-T33 behaviour. Moved verbatim out of ingest.js so buildPlan (renderer
// side, no DB) can shape the field-delta; ingest.test.js's behaviour is pinned
// by the golden-ops characterization test.
export function fieldsFor(entity, name, campId, index, cohortId) {
  switch (entity) {
    case 'cohorts':
      return { camp_id: campId, name }
    case 'tiers':
      return { camp_id: campId, name, sort_order: index, cohort_id: cohortId }
    case 'groups':
      return { camp_id: campId, name, availability: 'all' }
    case 'days_of_operation': {
      const dow = DAY_INDEX[String(name).trim().toLowerCase()]
      return {
        camp_id: campId,
        label: name,
        day_of_week: dow ?? index,
        sort_order: dow ?? index,
      }
    }
    case 'time_blocks': {
      const { start_time, end_time } = parseTimeRange(name)
      return { camp_id: campId, name, start_time, end_time, sort_order: index, cohort_id: cohortId }
    }
    case 'activities':
      return { camp_id: campId, name }
    default:
      throw new Error(`ingest: ${entity} is not an ingestible entity`)
  }
}

/**
 * PURE. No DB handle, no writes. Turns a normalized import source plus a
 * read-only snapshot of what the camp already has into a ReconciliationPlan.
 *
 * S0 source shape (the importer's own inputs): the director-confirmed create
 * set plus the auxiliary payloads the committer resolves against the live DB.
 *
 *   @param {Object} source
 *     - approved:       { [entity]: string[] }  the confirmed names to create
 *     - links:          { groups: { [groupName]: unitName } }
 *     - activityRules:  { [activityName]: rule }
 *     - fixedEvents:    FixedEvent[]  (resolved by name at commit)
 *     - camp_id, cohort_id, mode
 *   @param {Object|null} existing  { [entity]: [{ id, name }] } — names already
 *     in the camp become `unchanged` items (zero ops). Null/absent => every
 *     approved name is a `create`, which preserves the importer's blind-create
 *     path (a same-name collision surfaces at the UNIQUE constraint at commit,
 *     exactly as today).
 *   @returns {ReconciliationPlan}
 */
export function buildPlan(source, existing = null) {
  const approved = source?.approved ?? {}
  const links = source?.links ?? {}
  const activityRules = source?.activityRules ?? {}
  const groupUnits = links?.groups ?? {}
  const campId = source?.camp_id ?? null
  const cohortId = source?.cohort_id ?? null
  const have = existing ?? {}

  const items = []

  for (const entity of INGESTIBLE_ENTITIES) {
    const names = Array.isArray(approved[entity]) ? approved[entity] : []
    // A LIST of rows per normalized key, not a single row (S1a §3). Two live
    // rows whose raw names differ but normalize to the same string ("Art" /
    // "art ") both legally exist under UNIQUE(camp_id, name); the old single-
    // valued Map let the last one silently overwrite the first, auto-picking an
    // identity no human saw. Keeping every colliding row makes the ambiguity a
    // detectable conflict instead.
    const already = new Map()
    for (const r of Array.isArray(have[entity]) ? have[entity] : []) {
      if (!r || !r.name) continue
      const key = normalizeName(r.name)
      if (!already.has(key)) already.set(key, [])
      already.get(key).push(r)
    }

    // `index` is the raw position in the approved array — blanks consume an
    // index but produce no item, matching commitIngest's forEach (sort_order
    // is derived from this index, so it must be the raw one).
    names.forEach((rawName, index) => {
      const name = String(rawName ?? '').trim()
      if (!name) return

      const matches = already.get(normalizeName(name)) ?? []
      if (matches.length > 1) {
        // One incoming label, more than one live row normalize-matching it.
        // Never auto-pick (§3); surface every candidate for review.
        items.push({
          op: 'conflict',
          entity,
          entity_id: null,
          reason: 'ambiguous_identity',
          fields: {},
          evidence: {
            tier: 'exact_name',
            candidates: matches.map((m) => ({ id: m.id, name: m.name })),
          },
          _name: name,
        })
        return
      }
      if (matches.length === 1) {
        const match = matches[0]
        // S2b: a recognized entity is no longer blindly `unchanged`. Diff the
        // proposed field values against the live snapshot row; a field that
        // DIFFERS becomes a FieldDelta and turns the item into an `update`,
        // carrying ONLY the changed fields. An entity all of whose comparable
        // fields equal live stays `unchanged` (zero ops), preserving F4.
        const raw = fieldsFor(entity, name, campId, index, cohortId)
        const nameCol = entity === 'days_of_operation' ? 'label' : 'name'
        const fields = {}
        for (const [field, proposed] of Object.entries(raw)) {
          // Blank/absent in the source → preserve, never diff and never clear
          // (MATCH_AND_MERGE_SEMANTICS §3): an empty cell means "I don't carry
          // this", so it stays out of the delta entirely.
          if (proposed === null || proposed === undefined || proposed === '') continue
          // Only fields the snapshot actually carries are comparable; a column
          // absent from the snapshot can't be diffed, so it is preserved.
          if (!(field in match)) continue
          const live = match[field]
          // The identity name/label matched via normalizeName, so a raw-form
          // difference ('art ' vs 'Art') is the SAME entity, not an update.
          const same = field === nameCol
            ? normalizeName(String(live)) === normalizeName(String(proposed))
            : live === proposed
          if (same) continue
          fields[field] = { from: live ?? null, to: proposed, source: 'import' }
        }

        if (Object.keys(fields).length > 0) {
          items.push({
            op: 'update',
            entity,
            entity_id: match.id,
            fields,
            evidence: { tier: 'exact_name', matched_name: match.name },
            _name: name,
          })
          return
        }

        // Resolved to a live entity, nothing differs. Zero-op arm (type doc b).
        items.push({
          op: 'unchanged',
          entity,
          entity_id: match.id,
          fields: {},
          evidence: { tier: 'exact_name', matched_name: match.name },
          // Carried so the committer can re-resolve this identity against the
          // live DB (the review window may have deleted match.id).
          _name: name,
        })
        return
      }

      const raw = fieldsFor(entity, name, campId, index, cohortId)
      const fields = {}
      for (const [field, value] of Object.entries(raw)) {
        fields[field] = { from: null, to: value, source: 'import' }
      }

      const item = {
        op: 'create',
        entity,
        entity_id: null,
        fields,
        evidence: { tier: 'new' },
        // Commit-resolution inputs — pure data the committer binds against the
        // live name->id maps (ADR §4). buildPlan cannot resolve them (no DB).
        _name: name,
      }
      if (entity === 'groups') item._link_unit = groupUnits[name]
      if (entity === 'activities') item._rule = activityRules?.[name]
      items.push(item)
    })
  }

  return {
    plan_version: 1,
    camp_id: campId,
    cohort_id: cohortId,
    base_generation: 0, // foundation D (staleness) is a later slice
    sources: [{ source: 'import', family: 'schedule' }],
    items,
    unresolved: [],
    // S0 commit directives carried as data (the plan is the whole commit input).
    mode: source?.mode ?? 'add',
    fixedEvents: Array.isArray(source?.fixedEvents) ? source.fixedEvents : [],
  }
}
