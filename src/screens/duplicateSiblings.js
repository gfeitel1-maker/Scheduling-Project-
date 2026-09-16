import { normalizeWordKey } from '../utils/normalizeWordKey.js'

// "Rows a director would call the same thing" — the shared half of the
// duplicate-catcher, used by Locations ("Gym"/"gym") and Activities
// ("Music"/"Musik" arriving from a re-imported file).
//
// Extracted rather than copied: the two callers' grouping code was identical
// modulo the word "location", and a second hand-maintained copy of a comparison
// rule is the drift this codebase keeps paying for.
//
// TWO STRENGTHS, because the two callers need different ones.
//
//   EXACT (default, what Locations uses) — normalizeWordKey equality: trim,
//   collapse whitespace, lowercase. A location list is short and
//   director-authored; "Gym"/"gym" is the whole failure mode.
//
//   NEAR (Activities) — exact, PLUS two rules for names that arrive from a
//   spreadsheet rather than from a person typing carefully:
//     · suffix variants, the rule scripts/ingest-sweep.mjs already uses for its
//       "human check" column ("Swim Return" / "Swim Returning");
//     · a single edit — one substituted, inserted or deleted character
//       ("Music" / "Musik").
//
// Why Activities needs more: a re-imported file with a typo'd name silently
// CREATES a second activity and the importer asks nothing — measured, not
// assumed (docs/work/evidence/2026-09-15-real-import-journal-probe.md). Exact
// matching would have missed the very case this marker exists for, which is
// how this rule was found: the first version of the marker shipped with exact
// matching and its own test for "Music"/"Musik" failed.
//
// A false positive is CHEAP here and that is the design: Art. V is FLAG, NEVER
// BLOCK. The marker is advisory, the merge needs a deliberate click, and a
// director who knows "Bunk A"/"Bunk B" are different simply ignores it. A false
// NEGATIVE is the expensive one — it is a camp quietly running two copies of
// one activity.

const WORD_ENDING = /^(s|es|ing|ed|er|ers)$/

// A NUMBERED SERIES is not a duplicate. "Lunch 1".."Lunch 5", "Tent 2"/"Tent 3",
// "CIT Block 1".."CIT Block 3", "Sports (w/G1)"/"Sports (w/G2)" — every one of
// these differs by a single character and every one is a deliberately distinct
// activity.
//
// This is not a hypothetical. Run against the eight real camp workbooks, the
// rule without this guard flagged seven groups: three real typos and FOUR
// numbered series. On the main file it was two series against one typo, which
// is the ratio at which a marker becomes something a director learns to ignore
// — and an ignored marker is worse than none, because it looks like coverage.
function isNumberedSeries(a, b) {
  if (!/\d/.test(a) || !/\d/.test(b)) return false
  return a.replace(/\d+/g, '') === b.replace(/\d+/g, '')
}

/** One substitution, insertion or deletion apart. Bails early, never builds a matrix. */
export function withinOneEdit(a, b) {
  if (a === b) return false
  const [short, long] = a.length <= b.length ? [a, b] : [b, a]
  if (long.length - short.length > 1) return false

  let i = 0
  let j = 0
  let slack = 1
  while (i < short.length && j < long.length) {
    if (short[i] === long[j]) { i += 1; j += 1; continue }
    if (slack === 0) return false
    slack = 0
    if (short.length === long.length) { i += 1; j += 1 } else { j += 1 }
  }
  return true
}

function nearlySame(a, b) {
  if (a === b) return true
  if (isNumberedSeries(a, b)) return false
  // Suffix variants — the ingest-sweep rule, kept identical on purpose.
  if (b.length > a.length && b.startsWith(a) && WORD_ENDING.test(b.slice(a.length))) return true
  if (a.length > b.length && a.startsWith(b) && WORD_ENDING.test(a.slice(b.length))) return true
  // A single typo. Guarded at 4+ characters: at three, one edit is most of the
  // word and "Art"/"Arc" are simply different activities.
  if (a.length >= 4 && b.length >= 4 && withinOneEdit(a, b)) return true
  return false
}

/** Map of group-key -> the 2+ rows sharing it, name-sorted. */
export function groupDuplicatesByName(rows, { near = false } = {}) {
  const keyed = []
  for (const row of rows ?? []) {
    const key = normalizeWordKey(row?.name)
    if (!key) continue
    keyed.push({ row, key })
  }

  const groups = new Map()
  if (!near) {
    const byKey = new Map()
    for (const { row, key } of keyed) {
      if (!byKey.has(key)) byKey.set(key, [])
      byKey.get(key).push(row)
    }
    for (const [key, matched] of byKey) {
      if (matched.length >= 2) groups.set(key, sortByName(matched))
    }
    return groups
  }

  // Near-matching is not an equivalence relation (A~B and B~C does not make
  // A~C), so rows are clustered by union-find rather than by a shared key —
  // otherwise the group a row lands in would depend on iteration order.
  const parent = keyed.map((_, i) => i)
  const find = (i) => { while (parent[i] !== i) { parent[i] = parent[parent[i]]; i = parent[i] } return i }
  const union = (i, j) => { const a = find(i); const b = find(j); if (a !== b) parent[b] = a }

  for (let i = 0; i < keyed.length; i++) {
    for (let j = i + 1; j < keyed.length; j++) {
      if (nearlySame(keyed[i].key, keyed[j].key)) union(i, j)
    }
  }
  const clusters = new Map()
  for (let i = 0; i < keyed.length; i++) {
    const root = find(i)
    if (!clusters.has(root)) clusters.set(root, [])
    clusters.get(root).push(keyed[i].row)
  }
  for (const [root, matched] of clusters) {
    if (matched.length >= 2) groups.set(keyed[root].key, sortByName(matched))
  }
  return groups
}

function sortByName(rows) {
  return [...rows].sort((a, b) => String(a.name).localeCompare(String(b.name)))
}

/** Per-row lookup of "the other rows that look like me". */
export function duplicateSiblingsByIdFor(rows, options) {
  const groups = groupDuplicatesByName(rows, options)
  const map = new Map()
  for (const matched of groups.values()) {
    for (const row of matched) map.set(row.id, matched.filter((r) => r.id !== row.id))
  }
  return map
}
