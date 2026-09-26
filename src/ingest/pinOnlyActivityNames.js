// The ONE derivation of "which names did ingest pass 1/2 claim?".
//
// Pass 1 (FIXED events) and pass 2 (RECURRING events) both come out of
// `inferFixedEvents` (src/ingest/fixedEvents.js). Pass 3 (ACTIVITIES) comes out
// of `extractEntities`, which walks the same cells and subtracts nothing. This
// function is the arbiter between them: every inferred event name, MINUS the
// dual-use names, is claimed and must not reach pass 3.
//
// Extracted from src/screens/ImportScreen.jsx (where it was two inline lines) so
// that the acceptance test can exercise the REAL derivation rather than
// hand-rolling its own copy of it. That is not a convenience. T62 was closed
// against an `anchor.activity_id` the row does not carry, and its unit test —
// which hand-built the field — stayed green for a month while the production Set
// was empty. A test that reconstructs the input it is meant to be checking
// proves only that the test and the code agree, which is the one thing that was
// never in doubt.
//
// CONFIDENCE-INDEPENDENT, deliberately (T234). Confidence answers "does this
// event exist", not "is it exclusive of the free-choice catalogue". A
// LOW-confidence recurring event is still an event and its name is still
// claimed.
//
// The dual-use carve-out is NOT re-implemented here — `inferFixedEvents` already
// computes `dualUseNames`, and a name that is genuinely both a scheduled event
// and a free choice (a swim that is pinned AND selectable) is simply never
// claimed. Strict exclusivity needs no new carve-out.

/**
 * @param {Array<{name: string}>} inferredFixedEvents - inferFixedEvents().fixedEvents
 * @param {Iterable<string>} dualUseNames - inferFixedEvents().dualUseNames
 * @returns {Set<string>} names claimed by pass 1/2, in their inferred spelling
 */
export function derivePinOnlyActivityNames(inferredFixedEvents, dualUseNames) {
  const dualUse = new Set(dualUseNames ?? [])
  return new Set((inferredFixedEvents ?? []).map((fe) => fe.name).filter((n) => !dualUse.has(n)))
}
