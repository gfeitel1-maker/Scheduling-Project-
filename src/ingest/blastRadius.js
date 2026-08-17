// buildBlastRadiusIndex — Seam 2 gap fix, docs/adr/2026-08-17-onescreen-reconciliation-projection.md.
//
// PURE. No IO, no DB, no clock/random. Counts, per (entity, entityId), how
// many OTHER plan items reference it, given only the planItems the dry-run
// already returns. O(planItems).
//
// Gap this fills: buildPlan's items carry FK-shaped references as NAME
// labels, not resolved ids (buildPlan is DB-agnostic — see buildPlan.js's
// SNAPSHOT_KEY comment). The two concretely wired label->entity references
// visible on activities plan items today are:
//   - `location` (a single name string) -> a locations plan item
//   - `eligible_groups` (an array of name strings) -> groups plan items
// Both travel on `item.fields.<field>.to` for update/clear items, and on
// `item._rule.location` / `item._rule.eligible_group_names` for create items
// (buildPlan.js's activities create arm, the side-channel commitCreate
// already consumes). anchor_activities/week_location_exclusions references
// named in the ADR as a forward example are NOT counted here — they are not
// INGESTIBLE_ENTITIES and never appear in planItems, so there is nothing to
// derive them from without a DB read, which this function must not do.
//
// Key shape: a matched/unchanged/updated target (real entity_id) keys as
// `${entity}:${entityId}`. A target that is itself a `create` in this same
// commit has no entity_id yet (buildPlan never resolves one — the ADR's own
// "no new DB read" constraint), so it keys as `${entity}:name:${normalizedName}`
// — a synthetic, deterministic stand-in id so a create-referencing-create
// commit (e.g. a brand-new location used by a brand-new activity) still
// produces a countable blast radius. This is a Maker-level design decision,
// not spelled out verbatim in the ADR — flagged in the R2'a handoff.

import { normalizeName } from './preview.js'

// REFERENCE_FIELDS/nameToKey below is a hardcoded allowlist, not derived from
// a schema — a new referencable entity/field added later (e.g. a fresh FK-
// shaped field on some other entity) contributes 0 to blast radius silently,
// with no exhaustiveness throw here (unlike reportToLanes.laneFor's switch).
// Known, compounding gap on the already-documented undercount; not fixed here.
const REFERENCE_FIELDS = Object.freeze({
  location: 'locations',
  eligible_groups: 'groups',
})

function targetKeyOf(entity, entityId, name) {
  return entityId != null
    ? `${entity}:${entityId}`
    : `${entity}:name:${normalizeName(String(name ?? ''))}`
}

function namesFrom(value) {
  if (value == null || typeof value === 'symbol') return []
  return Array.isArray(value) ? value.filter((v) => typeof v === 'string') : [String(value)]
}

export function buildBlastRadiusIndex(planItems) {
  const index = new Map()
  const items = Array.isArray(planItems) ? planItems : []

  // Name -> target key, per referenced entity type, built once up front so
  // reference resolution below is a plain lookup.
  const nameToKey = { locations: new Map(), groups: new Map() }
  for (const item of items) {
    const bucket = nameToKey[item.entity]
    if (!bucket || item._name == null) continue
    bucket.set(normalizeName(String(item._name)), targetKeyOf(item.entity, item.entity_id, item._name))
  }

  const bump = (key) => index.set(key, (index.get(key) ?? 0) + 1)

  const resolveAndCount = (targetEntity, rawValue) => {
    for (const name of namesFrom(rawValue)) {
      const key = nameToKey[targetEntity]?.get(normalizeName(name))
      if (key) bump(key)
    }
  }

  for (const item of items) {
    // update/clear: references live on item.fields.<field>.to
    for (const [field, targetEntity] of Object.entries(REFERENCE_FIELDS)) {
      const delta = item.fields?.[field]
      if (delta && delta.to !== undefined) resolveAndCount(targetEntity, delta.to)
    }
    // create (activities only): references live on the _rule side-channel
    if (item.op === 'create' && item.entity === 'activities' && item._rule) {
      resolveAndCount('locations', item._rule.location)
      resolveAndCount('groups', item._rule.eligible_group_names)
    }
  }

  return index
}
