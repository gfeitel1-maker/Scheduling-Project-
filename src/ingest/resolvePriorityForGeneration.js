// UNKNOWN/absent/NULL priority would be silently unplaceable at
// buildSchedule.js:302 — its round filter only ever matches the two-valued
// 'high'|'low' engine contract. The safe default is 'low', NEVER 'high': an
// unconfirmed (inferred, un-reviewed) activity must never outcompete a
// director's real high-priority activity for round-1 slots.
// Applied at generation time, immediately before buildSchedule — the engine
// itself stays untouched (ADR 2026-08-06 D4/OQ3).
export function resolvePriorityForGeneration(activities) {
  return activities.map((a) =>
    a.priority === 'high' || a.priority === 'low' ? a : { ...a, priority: 'low' }
  )
}
