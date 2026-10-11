// Multi-block spans read from a TEXT grid (scorecard F5,
// docs/work/evidence/2026-10-11-synthetic-15-scorecard.md).
//
// A text grid has no merge metadata (that is the XLSX `row.blockSpans` path,
// multiBlockCandidates.js), so a double or triple period shows up in one of two
// shapes:
//   "repeat" — the name printed in every block of the span;
//   "blank"  — the name printed once, the later blocks blank (how a merged cell
//              extracts to text).
//
// The rule is per ACTIVITY and deliberately all-or-nothing, because a wrong
// span is silent (the engine reserves blocks nobody asked for) while a missed
// span is today's behaviour:
//   repeat: EVERY run of the name, in every (group, day), is exactly N
//           consecutive blocks, N >= 2.
//   blank:  the name is never repeated, has at least 2 occurrences, and EVERY
//           occurrence is a single-name cell followed by exactly k >= 1 blank
//           cells (then a non-blank cell or the end of the day). N = k + 1.
// A name printed sometimes as a single block and sometimes as a run, or whose
// following blanks vary, is not a span. "Blank" is otherwise indistinguishable
// from a free/unfilled cell, which is why it needs the per-occurrence
// consistency and more than one occurrence: a stray empty cell after one
// activity once is noise, the same gap after every occurrence is a shape.
//
// Pure. Walks the same pages/proposal shape as capturePlacements.js and reads
// cells through the same canonical spellings.

import { isDayName } from './textGrid.js'
import { activityNamesFromCell, canonicalDay, dayNameFromTitle, cleanTitle } from './extractEntities.js'
import { normalizeName } from './preview.js'

// (group, day) -> ordered [{ blockLabel, names }] in the page's row order.
function groupDaySequences(parsed, proposal) {
  const pages = parsed?.pages ?? []
  const orientation = proposal?.orientation ?? {}
  const groupNameByTitle = proposal?.groupNameByTitle ?? {}
  const canonicalMap = proposal?.canonicalMap
  const compoundCellDecisions = proposal?.compoundCellDecisions
  const blockByKey = new Map((proposal?.entities?.time_blocks ?? []).map((b) => [normalizeName(b), b]))
  const seqs = new Map()
  const push = (groupName, dayName, blockLabel, cell) => {
    const key = JSON.stringify([groupName, dayName])
    if (!seqs.has(key)) seqs.set(key, { groupName, dayName, cells: [] })
    seqs.get(key).cells.push({ blockLabel, names: activityNamesFromCell(cell, canonicalMap, compoundCellDecisions) })
  }
  for (const page of pages) {
    if (orientation.columns === 'days') {
      const groupName = groupNameByTitle[cleanTitle(page.title)]
      if (!groupName) continue
      const dayCols = []
      page.columns.forEach((c, i) => { if (isDayName(c)) dayCols.push({ i, day: canonicalDay(c) }) })
      for (const row of page.rows ?? []) {
        const blockLabel = blockByKey.get(normalizeName(row.label))
        if (!blockLabel) continue
        for (const { i, day } of dayCols) push(groupName, day, blockLabel, row.cells?.[i])
      }
    } else {
      const dayName = dayNameFromTitle(cleanTitle(page.title))
      if (!dayName) continue
      for (const row of page.rows ?? []) {
        const blockLabel = blockByKey.get(normalizeName(row.label))
        if (!blockLabel) continue
        page.columns.forEach((rawGroupName, i) => {
          if (!rawGroupName) return
          push(groupNameByTitle[rawGroupName] ?? rawGroupName, dayName, blockLabel, row.cells?.[i])
        })
      }
    }
  }
  return [...seqs.values()]
}

/**
 * @returns {{
 *   spans: Map<string, { name, span_blocks: number, sessions: number, form: 'repeat'|'blank' }>,
 *          keyed by normalizeName(activity name);
 *   continuations: Array<{ groupName, dayName, blockLabel, activityName }>
 *          the blank cells a "blank" span covers, as placements.
 * }}
 */
export function inferTextSpans(parsed, proposal = {}) {
  const seqs = groupDaySequences(parsed, proposal)
  const occ = new Map() // norm -> { name, list: [{ run, blanks, singleCell, seq, i }] }
  for (const seq of seqs) {
    const { cells } = seq
    cells.forEach((cell, i) => {
      for (const name of cell.names) {
        const norm = normalizeName(name)
        if (i > 0 && cells[i - 1].names.some((n) => normalizeName(n) === norm)) continue // mid-run
        let run = 1
        while (i + run < cells.length && cells[i + run].names.some((n) => normalizeName(n) === norm)) run += 1
        let blanks = 0
        while (i + run + blanks < cells.length && cells[i + run + blanks].names.length === 0) blanks += 1
        if (!occ.has(norm)) occ.set(norm, { name, list: [] })
        occ.get(norm).list.push({ run, blanks, singleCell: cell.names.length === 1, seq, i })
      }
    })
  }

  // A block that is blank in most (group, day) sequences that have it is a
  // structural free period (or past the end of most groups' day), not a span
  // tail: whatever is scheduled before it would otherwise read as a span.
  const cellCount = new Map()
  const blankCount = new Map()
  for (const seq of seqs) {
    for (const cell of seq.cells) {
      const k = JSON.stringify([seq.dayName, cell.blockLabel])
      cellCount.set(k, (cellCount.get(k) ?? 0) + 1)
      if (cell.names.length === 0) blankCount.set(k, (blankCount.get(k) ?? 0) + 1)
    }
  }
  const structurallyFree = (seq, cell) => {
    const k = JSON.stringify([seq.dayName, cell.blockLabel])
    return (blankCount.get(k) ?? 0) * 2 > cellCount.get(k)
  }

  const spans = new Map()
  const continuations = []
  for (const [norm, { name, list }] of occ) {
    const run = list[0].run
    if (run >= 2 && list.every((o) => o.run === run)) {
      spans.set(norm, { name, span_blocks: run, sessions: list.length, form: 'repeat' })
      continue
    }
    const k = list[0].blanks
    if (list.length >= 2 && k >= 1 && list.every((o) => o.run === 1 && o.singleCell && o.blanks === k)
      && !list.some((o) => o.seq.cells.slice(o.i + 1, o.i + 1 + k).some((c) => structurallyFree(o.seq, c)))) {
      spans.set(norm, { name, span_blocks: k + 1, sessions: list.length, form: 'blank' })
      for (const o of list) {
        for (let j = 1; j <= k; j++) {
          continuations.push({
            groupName: o.seq.groupName, dayName: o.seq.dayName,
            blockLabel: o.seq.cells[o.i + j].blockLabel, activityName: name,
          })
        }
      }
    }
  }
  return { spans, continuations }
}
