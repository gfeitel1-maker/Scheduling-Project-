// The participant domain: the seven entities T194 adds at schema v66
// (docs/adr/2026-09-17-individual-elective-scheduling.md D8/D9).
//
// ONE DEFINITION, imported everywhere. Round 1 hand-copied this list into seven
// places — the audit PII guard, the restore decisions, the MCP entity-map
// exclusion and four tests. That shape has a recorded incident in this repo
// (feedback_derive_gate_inputs_from_committed_state, and the menu guard whose
// role list had the same blind spot as the menu it guarded): an EIGHTH
// participant entity added in T195/T196 would be caught by the authorization
// parity test — which compares against a hand-kept sibling list — while
// silently losing the audit PII guard and the MCP exclusion, because those two
// triggers are membership tests against copies nobody remembered to update.
// Deriving every guard's trigger from this constant is what closes that.
//
// Adding an entity here is therefore a deliberate act with consequences: it
// becomes admin-only, audit-guarded, unrestorable and excluded from the MCP
// entity map, and the parity tests will tell you if any of those did not follow.
export const PARTICIPANT_ENTITIES = Object.freeze(
  new Set([
    'campers',
    'elective_assignment_runs',
    'elective_occurrences',
    'elective_choices',
    'elective_choice_offerings',
    'elective_preferences',
    'elective_assignments',
    // T243 (v74, docs/adr/2026-09-23-elective-run-lifecycle-and-remaining-
    // slices.md) — the eighth participant entity this module's header
    // comment anticipated. A finalized run's per-camper, per-cell export
    // snapshot: PII-adjacent for the same reason elective_assignments is —
    // it denormalizes a named child's whole schedule.
    'elective_run_outer_snapshots',
  ])
)

// Spellings that are NOT the registered entity name but plainly mean it — the
// near misses a caller reaches for. Every guard in this repo that keys on an
// exact string match has the same blind spot: `targetType: 'camper'` (singular)
// or `'elective_run'` matches nothing, so the guard silently does not fire and
// the caller believes it did.
//
// DERIVED from the set above, never hand-kept, so a new entity gets its near
// misses for free. Callers passing one of these are refused with the real name.
export const PARTICIPANT_ENTITY_NEAR_MISSES = Object.freeze(
  new Map(
    [...PARTICIPANT_ENTITIES].flatMap((entity) => {
      const spellings = new Set()
      if (entity.endsWith('s')) spellings.add(entity.slice(0, -1))
      if (entity.startsWith('elective_')) {
        const short = entity.slice('elective_'.length)
        spellings.add(short)
        if (short.endsWith('s')) spellings.add(short.slice(0, -1))
      }
      spellings.delete(entity)
      return [...spellings]
        .filter((s) => !PARTICIPANT_ENTITIES.has(s))
        .map((spelling) => [spelling, entity])
    })
  )
)
