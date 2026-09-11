// What the reconciliation screen's exit offers, given how far the director got.
//
// The screen used to end in two buttons, and the hierarchy was inverted:
//
//   "Use this setup"                                    PRIMARY, navy
//     disabled until every item was resolved — 79 of them, on one real file
//   "Apply confirmed changes and keep the rest for review"   SECONDARY
//     disabled until at least one item was resolved
//
// So the button that LOOKED like the way out stayed locked, and the only
// reachable exit was the quiet one beside it. A director who did not notice
// that had no way forward at all from a 15-screen page.
//
// There is one exit now, and it is always reachable. That costs nothing in
// behaviour: apply('confirmedOnly') and apply('all') fold the SAME answers once
// everything is resolved (see ReconciliationScreen's `apply`), so the two
// buttons only ever differed while work was outstanding — which is exactly when
// the primary was disabled.
//
// The label carries the state instead of a tooltip, because a tooltip on a
// disabled button is help for a UI that should not need explaining.

/**
 * @param totalCount     decisions in the attention lanes
 * @param doneCount      how many of those are resolved
 * @param confirmedCount answers staged (resolved decisions the director acted on)
 * @returns { label, mode, disabled, hint }
 */
export function applyTrayState({ totalCount = 0, doneCount = 0, confirmedCount = 0 } = {}) {
  const pending = Math.max(0, totalCount - doneCount)

  // Nothing was ever asked: the file read cleanly.
  if (totalCount === 0) {
    return {
      label: 'Use this setup',
      mode: 'all',
      disabled: false,
      hint: 'Nothing needed a decision.',
    }
  }

  // Everything answered — the two old modes are equivalent here.
  if (pending === 0) {
    return {
      label: 'Use this setup',
      mode: 'all',
      disabled: false,
      hint: `All ${totalCount} decided.`,
    }
  }

  // Work outstanding. This is the case the old screen had no reachable exit
  // for, and the label says exactly what pressing it does with the remainder.
  if (confirmedCount === 0) {
    return {
      label: 'Use what Shoresh understood',
      mode: 'confirmedOnly',
      disabled: false,
      hint: `${pending} ${pending === 1 ? 'question is' : 'questions are'} still open — they stay here for later.`,
    }
  }

  return {
    label: `Apply ${confirmedCount} ${confirmedCount === 1 ? 'decision' : 'decisions'}`,
    mode: 'confirmedOnly',
    disabled: false,
    hint: `${pending} ${pending === 1 ? 'question stays' : 'questions stay'} here for later.`,
  }
}
