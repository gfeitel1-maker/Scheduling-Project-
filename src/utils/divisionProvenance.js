// The sentence a director reads when they ask why a bunk is in the age
// division the import put it in (T114 follow-up).
//
// Separate and pure because it is the ENTIRE user-facing value of the division
// evidence: an import_evidence row nobody can read explains nothing. The data
// half is written by electron/ops/ingest.js's writeDivisionEvidence; this is
// the half a person actually sees.

function list(names) {
  const n = names.filter(Boolean)
  if (n.length === 0) return ''
  if (n.length === 1) return n[0]
  if (n.length === 2) return `${n[0]} and ${n[1]}`
  return `${n.slice(0, -1).join(', ')} and ${n[n.length - 1]}`
}

/**
 * @param {object|null} support  an import_evidence support object for groups/tier_id
 * @param {string} groupName     the group being explained, excluded from the sibling list
 * @returns {string} always a sentence, never empty — a popover that renders
 *          blank on unexpected data looks broken rather than honest.
 */
export function describeDivisionEvidence(support, groupName) {
  if (!support || typeof support !== 'object') {
    return 'This age division came from the import, but no reason was recorded.'
  }
  const siblings = (support.members ?? []).filter((m) => m !== groupName)
  const parts = []

  if (support.basis === 'split_by_co_occurrence') {
    // The honest order: what the names said FIRST, then why it was overruled.
    // Leading with the conclusion would read as the importer being arbitrary.
    parts.push(
      `The names suggested one "${support.names_proposed}" division, but on the schedule this group never shares an activity with the rest of it` +
      (siblings.length ? ` — only with ${list(siblings)}` : '') +
      `, so they were kept separate.`
    )
  } else if (support.basis === 'solo' || siblings.length === 0) {
    parts.push(`No other group's name shares a stem with this one, so it is its own age division.`)
  } else {
    parts.push(`Grouped with ${list(siblings)} because their names share "${support.stem}".`)
  }

  if (support.qualifier_stripped) {
    // Load-bearing: "Tzofim 1 (girls)" clusters ONLY because the bracket came
    // off first. Without saying so, the division looks unexplainable from the
    // names on screen.
    parts.push('The bracketed part of the name was set aside when comparing.')
  }

  const anchors = support.anchors_excluded ?? []
  if (anchors.length > 0) {
    // Also load-bearing: an all-camp activity puts every group in one slot, so
    // leaving it in would make every group look like it belongs with every
    // other and nothing could ever be separated.
    parts.push(`${list(anchors)} ${anchors.length === 1 ? 'was' : 'were'} ignored — all-camp activities put every group together, so they say nothing about who belongs with whom.`)
  }

  return parts.join(' ')
}
