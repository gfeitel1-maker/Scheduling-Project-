// T232 — when a camper's division on the sheet matches no division in the
// camp, propose the one they probably meant.
//
// WHY A DIFFERENT RULE FROM nearDuplicateNames.js. That module is strictly
// suffix-based ("Swim Return" -> "Swim Returning") and deliberately narrow,
// because it runs against a camp's whole ACTIVITY vocabulary — an open set of
// dozens of names where a loose rule would ask a director about two things that
// were never related (T144).
//
// A division is the opposite shape: the candidate set is CLOSED and TINY — a
// camp has three or four tiers, and they are authored in the app, not typed on
// the sheet. Against three candidates, a one-or-two character edit is
// overwhelmingly a typo rather than a coincidence, so an edit-distance rule is
// high precision here and would be reckless against activities. The rule does
// not generalise and is deliberately not exported for other callers.
//
// PROPOSE, NEVER MERGE — the same standing decision as T144. Nothing here
// changes a camper's division or their attendance. It supplies a name for a
// message so a director can fix the sheet, which is the difference between
// "3 campers had no matching division" and "3 campers say 'Bogrimm' — did you
// mean 'Bogrim'?".

const fold = (s) => String(s ?? '').trim().toLowerCase().replace(/\s+/g, '')

// Damerau-Levenshtein, not plain Levenshtein — the difference is load-bearing.
// A TRANSPOSITION ('Tzeirim' -> 'Tzierim') is one of the commonest typing
// mistakes and is genuinely ONE error, but plain Levenshtein scores it as two
// (a delete plus an insert), which pushes it outside a one-edit budget on a
// seven-character name. Counting it as one is what lets the budget stay tight
// while still catching the typo a director will actually make.
//
// Full matrix rather than two rows: the transposition case needs row i-2.
function editDistance(a, b) {
  if (a === b) return 0
  const d = Array.from({ length: a.length + 1 }, (_, i) =>
    Array.from({ length: b.length + 1 }, (_, j) => (i === 0 ? j : j === 0 ? i : 0))
  )
  for (let i = 1; i <= a.length; i++) {
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1
      d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + cost)
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) {
        d[i][j] = Math.min(d[i][j], d[i - 2][j - 2] + 1)
      }
    }
  }
  return d[a.length][b.length]
}

// Two edits on a long name is a typo; two edits on a four-letter name is a
// different word. Scaling the budget with length is what keeps 'Bog' from
// reaching 'Bogrim'.
function budgetFor(length) {
  if (length < 5) return 0
  return length < 8 ? 1 : 2
}

/**
 * @param {string} value      the division as written on the sheet
 * @param {string[]} tierNames the camp's actual division names
 * @returns {string|null} the proposed division name, or null when there is no
 *   confident single candidate. Null for an exact match too — that is
 *   buildAttendance's job, and proposing it would make a matched camper look
 *   like a question.
 */
export function suggestDivisionMatch(value, tierNames = []) {
  const key = fold(value)
  if (!key) return null

  const candidates = tierNames
    .map((name) => ({ name, key: fold(name) }))
    .filter((c) => c.key)
  if (candidates.length === 0) return null
  if (candidates.some((c) => c.key === key)) return null // already matched

  const budget = budgetFor(key.length)
  if (budget === 0) return null

  const scored = candidates
    .map((c) => ({ ...c, d: editDistance(key, c.key) }))
    .filter((c) => c.d <= budget)
    .sort((a, b) => a.d - b.d || (a.key < b.key ? -1 : 1))

  if (scored.length === 0) return null
  // A tie is not a proposal. Precision over recall: asking "did you mean A or
  // B?" about a value that resembles both is the question T144 exists to avoid.
  if (scored.length > 1 && scored[0].d === scored[1].d) return null
  return scored[0].name
}
