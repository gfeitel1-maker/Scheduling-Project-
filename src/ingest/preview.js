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

// Is this name just two other proposed names stuck together?
//
// "Opening Drama" appears twice; "Opening" appears 21 times and "Drama" 36. A
// name that is far rarer than every one of its own parts is where two adjacent
// cells were read as one, not a compound the camp actually uses.
//
// The frequency guard is what keeps genuine compounds: "Instructional Swim"
// (54) is not much rarer than "Instructional" (34) or "Swim" (68), so it
// survives. Without the guard this would reject the real activity along with
// the artifact.
const MERGE_RARITY = 3

export function looksLikeAMerge(name, counts) {
  const words = String(name ?? '').trim().split(/\s+/)
  if (words.length < 2) return false
  const whole = counts[name] ?? 0
  if (whole === 0) return false

  for (let split = 1; split < words.length; split++) {
    const left = words.slice(0, split).join(' ')
    const right = words.slice(split).join(' ')
    const leftCount = counts[left]
    const rightCount = counts[right]
    if (!leftCount || !rightCount) continue
    if (leftCount >= whole * MERGE_RARITY && rightCount >= whole * MERGE_RARITY) return true
  }
  return false
}

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

    // A value seen only once across the whole document is far more likely to
    // be a parse artifact than a real activity, so it is shown — never hidden —
    // but does not start ticked. The director ticks it if it is real; they do
    // not have to untick sixty things if it is not.
    const counts = proposal?.seenCounts?.[entity] ?? {}
    const lowConfidence = create.filter(
      (name) => (counts[name] ?? 2) < 2 || looksLikeAMerge(name, counts)
    )

    perEntity[entity] = { create, skip, counts, lowConfidence }
    createTotal += create.length
    skipTotal += skip.length
  }

  return {
    orientation: proposal?.orientation ?? null,
    groupUnits: proposal?.groupUnits ?? {},
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
