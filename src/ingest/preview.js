// What an import would actually do, said before it does it.
//
// docs/adr/2026-08-01-ingesting-a-prior-year-schedule.md §1, §5.
//
// Duplicates are skipped rather than merged or renamed (product owner,
// 2026-07-30), which means a normal import is *silently partial*. The ADR is
// explicit that the preview must therefore name what will be skipped and what
// it matched, before the confirm — "skipped 12 rows" is not something a
// director can check, and finding out afterwards is not a preview at all.

import { INGESTIBLE_ENTITIES } from './extractEntities.js'

// The same rule the per-screen imports use. Both paths must agree, or the same
// file imported two ways gives two different camps.
export function normalizeName(name) {
  return String(name ?? '').trim().toLowerCase().replace(/\s+/g, ' ')
}

/**
 * Compare a proposal against what the camp already has.
 *
 * `existing` is `{ [entity]: [{ id, name }] }`. Returns, per entity:
 *   `create` — names that would be added
 *   `skip`   — `{ name, matched }` pairs, so a director can see the record
 *              each skipped row collided with rather than a bare count
 *
 * Rows the proposal repeats internally are also skipped, against the first
 * spelling seen. A source grid naming the same activity twice is normal.
 */
export function buildPreview(proposal, existing) {
  const entities = proposal?.entities ?? {}
  const have = existing ?? {}
  const perEntity = {}
  let createTotal = 0
  let skipTotal = 0

  for (const entity of INGESTIBLE_ENTITIES) {
    const proposed = Array.isArray(entities[entity]) ? entities[entity] : []
    const already = new Map(
      (Array.isArray(have[entity]) ? have[entity] : [])
        .filter((r) => r && r.name)
        .map((r) => [normalizeName(r.name), r])
    )

    const create = []
    const skip = []
    const seen = new Set()

    for (const name of proposed) {
      const key = normalizeName(name)
      if (!key) continue
      if (already.has(key)) {
        skip.push({ name, matched: already.get(key).name, reason: 'already-in-camp' })
      } else if (seen.has(key)) {
        skip.push({ name, matched: name, reason: 'repeated-in-file' })
      } else {
        seen.add(key)
        create.push(name)
      }
    }

    perEntity[entity] = { create, skip }
    createTotal += create.length
    skipTotal += skip.length
  }

  return {
    orientation: proposal?.orientation ?? null,
    perEntity,
    createTotal,
    skipTotal,
    // Nothing to do is a real outcome and must read as one, not as an error.
    // Importing the same file twice lands here, which is the common case.
    isNoOp: createTotal === 0,
  }
}

/**
 * One sentence a director can act on, for above the table.
 */
export function describePreview(preview) {
  if (!preview || preview.createTotal === 0) {
    return preview && preview.skipTotal > 0
      ? 'Everything in this file is already in your camp. Nothing would be added.'
      : 'Nothing was found in this file to add.'
  }
  const parts = []
  for (const entity of INGESTIBLE_ENTITIES) {
    const n = preview.perEntity[entity]?.create.length ?? 0
    if (n > 0) parts.push(`${n} ${ENTITY_WORD[entity][n === 1 ? 0 : 1]}`)
  }
  const list = parts.length === 1 ? parts[0] : `${parts.slice(0, -1).join(', ')} and ${parts[parts.length - 1]}`
  const skipped = preview.skipTotal > 0
    ? ` ${preview.skipTotal} ${preview.skipTotal === 1 ? 'row is' : 'rows are'} already in your camp and will be left alone.`
    : ''
  return `This would add ${list}.${skipped}`
}

const ENTITY_WORD = {
  cohorts: ['program', 'programs'],
  tiers: ['unit', 'units'],
  groups: ['group', 'groups'],
  days_of_operation: ['day', 'days'],
  time_blocks: ['time block', 'time blocks'],
  activities: ['activity', 'activities'],
}
