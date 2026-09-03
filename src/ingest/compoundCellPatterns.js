// Splits a compound cell into candidate parts for detection only — never used
// to split real data. `w/` must be checked before the bare `/` alternative or
// "Sports w/G1" would split into "Sports w" and "G1".
const CONNECTOR_RE = /\s*(?:&|\+|w\/|\/)\s*/i

// v1 only handles two-part compounds — every real example found in pressure-
// testing (Lunch + Leave, Change/Snack, Sports w/G1...) was two parts. A
// 3+-part split is silently dropped rather than guessed at; if a real 3-part
// case turns up, extend this deliberately rather than assuming the same
// partner-diversity rule generalizes cleanly to n-way splits.
function splitParts(value) {
  const parts = String(value ?? '')
    .split(CONNECTOR_RE)
    .map((p) => p.trim())
    .filter(Boolean)
  return parts.length === 2 ? parts : null
}

/**
 * @param {string[]} cellValues  every raw cell string seen in a parsed file
 * @returns {Array<{
 *   pattern: string,
 *   occurrences: number,
 *   parts: [string, string],
 *   anchorGuess: string|null,
 *   wrapperGuess: string|null,
 * }>}
 */
export function detectCompoundCellPatterns(cellValues) {
  const values = cellValues ?? []
  const standalone = new Set(values.map((v) => String(v ?? '').trim()))

  // A compound cell's parts partnered with, across the whole file. A part
  // seen with exactly one partner (always the same pair) is a single fixed
  // name like "Arts & Crafts" — never a candidate. A part seen with ≥2
  // distinct partners is where the wrapper/rotation concept actually lives.
  const partners = new Map() // part -> Set(other part)
  const occurrences = new Map() // pattern -> count
  const patternParts = new Map() // pattern -> [a, b]

  for (const raw of values) {
    const pattern = String(raw ?? '').trim()
    const parts = splitParts(raw)
    if (!parts) continue

    occurrences.set(pattern, (occurrences.get(pattern) || 0) + 1)
    patternParts.set(pattern, parts)

    const [a, b] = parts
    if (!partners.has(a)) partners.set(a, new Set())
    if (!partners.has(b)) partners.set(b, new Set())
    partners.get(a).add(b)
    partners.get(b).add(a)
  }

  const candidates = []
  for (const [pattern, parts] of patternParts) {
    const [a, b] = parts
    const hasDiverseSide = partners.get(a).size >= 2 || partners.get(b).size >= 2
    if (!hasDiverseSide) continue // both parts have exactly one fixed partner

    let anchorGuess = null
    let wrapperGuess = null
    const aStandalone = standalone.has(a)
    const bStandalone = standalone.has(b)
    if (aStandalone && !bStandalone) {
      anchorGuess = a
      wrapperGuess = b
    } else if (bStandalone && !aStandalone) {
      anchorGuess = b
      wrapperGuess = a
    }

    candidates.push({
      pattern,
      occurrences: occurrences.get(pattern),
      parts,
      anchorGuess,
      wrapperGuess,
    })
  }

  return candidates
}
