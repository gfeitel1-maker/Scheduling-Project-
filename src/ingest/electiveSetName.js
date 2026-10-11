// D3 (docs/adr/2026-10-11-import-electives-keep-their-shape.md): a split list's elective set is named
// after its own choices, sorted case-insensitively and deduplicated, so the name depends on the list and
// nothing else. Shared by the review fold (which names the set) and the plan (which must recognise a set
// the camp already has, so an unchanged re-import does not propose it again).
import { normalizeName } from './preview.js'

export function uniqueChoices(choices) {
  const unique = []
  const seen = new Set()
  for (const c of choices) if (!seen.has(normalizeName(c))) { seen.add(normalizeName(c)); unique.push(c) }
  return unique
}

export function listSetName(choices) {
  const sorted = [...uniqueChoices(choices)].sort((x, y) => normalizeName(x).localeCompare(normalizeName(y)))
  return `Electives (${sorted.join(', ')})`
}

export const listKey = (choices) => [...uniqueChoices(choices)].map(normalizeName).sort().join('|')
