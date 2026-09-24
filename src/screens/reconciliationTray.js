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

// T253 (Amendment, docs/adr/2026-08-17-onescreen-reconciliation-undo.md) —
// the post-commit exit tray, a SIBLING to applyTrayState, not a branch
// inside it: this describes a finished commit's result plus an optional
// undo, a different question from triage progress, and nothing calls both
// from the same call site.
//
// `undoCapable` must be the caller's OWN read of
// Array.isArray(outcome.invertibleOps) — never re-derived here from
// `mode`. That is Invariant 3's structural guarantee (commitPlan throws on
// captureInverse && mode==='replace'), read once.
//
// Honesty constraint (Invariant 5c): copy here must say "for the next few
// minutes" or a live countdown, never "always available" — and the
// not-undoable state must read as complete, never as missing something; it
// never mentions undo at all.
const recordWord = (n) => (n === 1 ? 'record' : 'records')

function receiptFor({ deleted = [], skipped = [], kept = [] } = {}) {
  const D = deleted.length
  const K = skipped.length
  const R = kept.length

  let summary
  if (D === 0) {
    summary = 'Nothing removed — everything had changed since import.'
  } else if (K === 0 && R === 0) {
    summary = `Removed ${D} ${recordWord(D)}.`
  } else {
    const parts = []
    if (K > 0) parts.push(`${K} changed since import`)
    if (R > 0) parts.push(`${R} still in use`)
    const keptClause = parts.length === 2 ? `${parts[0]}, and ${parts[1]}` : parts[0]
    summary = `Removed ${D} ${recordWord(D)}. Kept ${keptClause}.`
  }

  const detail = []
  if (K > 0) {
    const fields = [...new Set(skipped.map((s) => s.field).filter(Boolean))]
    detail.push(`Kept — changed since import: ${fields.join(', ')}`)
  }
  if (R > 0) {
    const items = kept.map((k) => {
      const n = k.referencedByCount ?? 0
      return `${k.name ?? 'record'} (used by ${n} other ${recordWord(n)})`
    })
    detail.push(`Kept — still in use: ${items.join('; ')}`)
  }

  return { summary, detail }
}

/**
 * @param notices      version/compound-cell notices ImportScreen already computed
 * @param undoCapable  the caller's own Array.isArray(outcome.invertibleOps) read
 * @param undoState    useGraceWindowUndo's fields, plus `total` (outcome.total)
 * @returns { hint, primary, secondary, receipt }
 */
export function commitTrayState({ notices = [], undoCapable = false, undoState = {} } = {}) {
  const {
    status = 'idle',
    isPending = false,
    secondsLeft = null,
    total = 0,
    deleted,
    skipped,
    kept,
  } = undoState

  const primary = { label: 'Continue' }
  const importedHint = `Imported ${total} ${recordWord(total)}.`

  if (!undoCapable) {
    return { hint: 'Setup replaced and ready.', primary, secondary: null, receipt: null }
  }

  if (status === 'used') {
    return { hint: 'Undo complete.', primary, secondary: null, receipt: receiptFor({ deleted, skipped, kept }) }
  }

  if (status === 'live') {
    if (isPending) {
      return {
        hint: importedHint,
        primary,
        secondary: { label: 'Undoing…', disabled: true, pending: true },
        receipt: null,
      }
    }
    const note = secondsLeft != null ? `${secondsLeft}s left` : 'for the next few minutes'
    return {
      hint: importedHint,
      primary,
      secondary: { label: 'Undo this import', disabled: false, pending: false, note },
      receipt: null,
    }
  }

  // expired, or a status this caller hasn't reached start() for yet — no
  // undo to offer, but the import itself is unaffected.
  void notices
  return { hint: importedHint, primary, secondary: null, receipt: null }
}
