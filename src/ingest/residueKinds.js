// WHAT A RESIDUE ITEM IS FOR — the one table that answers it, so a new kind is
// classified in a single place instead of in whichever screen renders it.
//
// The director's question about residue is not "what happened" but "is there
// anything I must do", and the two answers are genuinely different things:
//
//   DECISION       — the director can settle it, and settling it CHANGES WHAT
//                    GETS IMPORTED. `UNRESOLVED_CHOICE_LABEL` is the clear case:
//                    the sheet names an activity this camp does not have, and
//                    once the camp has it those preferences are readable.
//
//   ACKNOWLEDGMENT — a true statement about what we did not read, with no action
//                    available. Reported, and that is all.
//
// The distinction is load-bearing, not cosmetic. A 40-row sheet naming one
// unknown activity produced a "43 things" label over three statements, only ONE
// of which the director could act on; an acknowledgment that masquerades as work
// is the same overstatement in a different costume.
//
// A KIND IS AN ACKNOWLEDGMENT UNTIL PROVEN OTHERWISE. Listing a kind here as a
// decision is a claim that an action for it EXISTS in the product — the standing
// rule against a control whose options are all inert means the list and the
// implemented actions have to stay in step, so the default is the safe one.
export const DECISION_KINDS = new Set(['UNRESOLVED_CHOICE_LABEL'])

export const residueIsDecision = (kind) => DECISION_KINDS.has(kind)

// THE RAIL, derived from the same table rather than from a second one.
//
// DESIGN_STANDARD §6: `--accent` (bronze) is the CAUTION hue — "temporary, needs
// attention, in progress" — and `--danger` (brick) is destructive/error/invalid.
// Residue had every item on bronze, which overstated it: an acknowledgment is
// not a caution, nothing is wrong, and nothing needs attention. A decision
// genuinely does need attention, which is exactly the accent's documented role.
//
// So bronze marks the rows that ask something of the director, and everything
// else takes the neutral structural hairline — which keeps the row rhythm
// without claiming urgency it does not have. `--danger` appears nowhere in
// residue: a dropped duplicate rank or a forked identity is a statement about
// what the FILE said, not an error the app hit, and the standard's own argument
// for keeping red rare applies directly.
export const residueRailColor = (kind) =>
  (residueIsDecision(kind) ? 'var(--accent)' : 'var(--border)')

// FACTOR OUT THE PART THAT NEVER VARIES, and do not invent anything else.
//
// A 40-row sheet naming one unknown activity produced tokens reading
// `Row 4, column C · Row 5, column C · Row 6, column C · …` — "column C" forty
// times, carrying no information after the first. This folds the constant out:
// `Column C — Row 4, Row 5, Row 6, …`.
//
// DELIBERATELY NOT RANGE-FOLDING. "Rows 4-43" would be shorter still, but it
// asserts contiguity the tokens do not state and it has to reason about
// orderings and gaps. Factoring out a segment that is literally identical in
// every token asserts nothing that is not already there, which is the whole
// reason this is safe to do without a director confirming it.
//
// Tokens are segmented on commas because that is how the producers punctuate a
// compound token (`Row 5, column E`). A token with no comma (a grid coordinate,
// `Monday Period 1`) has one segment and simply never folds — under-folding is
// the correct failure here.
export function foldTokens(heads) {
  const tokens = (heads ?? []).filter(Boolean)
  // One token repeats nothing, so there is nothing to factor out.
  if (tokens.length < 2) return { invariant: null, variable: tokens }

  const split = tokens.map((t) => t.split(',').map((s) => s.trim()))
  let shared = 0
  const shortest = Math.min(...split.map((s) => s.length))
  // Longest common SUFFIX of segments. Suffix rather than prefix because the
  // varying part — the row, the camper — is what a reader scans for, and it
  // belongs at the end of the line where the eye is already travelling.
  while (shared < shortest - 1) {
    const candidate = split[0][split[0].length - 1 - shared]
    if (!split.every((s) => s[s.length - 1 - shared] === candidate)) break
    shared += 1
  }
  if (shared === 0) return { invariant: null, variable: tokens }

  const invariant = split[0].slice(split[0].length - shared).join(', ')
  return {
    invariant: invariant.charAt(0).toUpperCase() + invariant.slice(1),
    variable: split.map((s) => s.slice(0, s.length - shared).join(', ')),
  }
}
