// T197 (docs/adr/2026-09-26-elective-run-outer-inheritance-and-linked-choice-export.md §2) — a
// linked elective choice's member occurrences are NOT contiguous, so they cannot be represented as
// a span (span_blocks is contiguous time occupancy by ONE row). This is a separate, pure, IO-free
// clustering step downstream of deriveElectiveRunOuterRows / the snapshot read: every export
// consumer that needs "one unit per linked choice" (child schedule, activity roster, XLSX) imports
// THIS function rather than re-implementing the grouping — the same one-definition discipline
// electiveGenerationPredicate.js established for visibility.
//
// Groups only rows where isLinkedChoice === true, by (camperId, choiceId). Every other row passes
// through unchanged, tagged { kind: 'span' }.
export function clusterLinkedElectiveRows(rows) {
  const clusters = new Map()
  const result = []

  for (const row of rows) {
    if (!row.isLinkedChoice) {
      result.push({ kind: 'span', ...row })
      continue
    }
    const key = `${row.camperId}|${row.choiceId}`
    if (!clusters.has(key)) {
      const cluster = {
        kind: 'linked_choice',
        camperId: row.camperId,
        choiceId: row.choiceId,
        label: row.choiceLabel ?? null,
        memberRows: [],
      }
      clusters.set(key, cluster)
      result.push(cluster)
    }
    clusters.get(key).memberRows.push(row)
  }

  return result
}
