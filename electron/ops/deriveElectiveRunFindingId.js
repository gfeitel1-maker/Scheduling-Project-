// Deterministic id derivation for elective_run_findings (T320, docs/adr/
// 2026-09-30-elective-run-durability.md item 4).
//
// Key: (run_id, solver_generation, kind, camper_id, choice_id, occurrence_id).
// Two devices computing the identical finding from the identical commit
// converge on one row (D4 discipline), same pattern as
// deriveElectiveRunOuterSnapshotId.js — a SEPARATE small module, not imported
// from it, per that file's own "separate small module" precedent.
//
// THIS ID IS NOT A PARSING CONTRACT. The components are legible in a SQLite
// shell for diagnosis only — nothing may recover a run/generation/kind by
// inspecting the string. The row's own columns are the only authority.

const V = 1

// uuid + slug alphabet, plus ':' and '.' — mirrors deriveElectiveRunOuterSnapshotId.js's
// OPAQUE guard exactly.
const OPAQUE = /^[A-Za-z0-9_.:-]+$/

function opaque(name, value) {
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error(`deriveElectiveRunFindingId: component ${name} must be a non-empty string`)
  }
  if (!OPAQUE.test(value)) {
    throw new Error(
      `deriveElectiveRunFindingId: component ${name} must be an opaque id matching [A-Za-z0-9_.:-]+`
    )
  }
  return value
}

// Length-prefixed concatenation — provably injective, same reasoning as
// deriveElectiveRunOuterSnapshotId.js's `join`.
function join(components) {
  return components.map((c) => `${c.length}.${c}`).join('')
}

// The three trailing components are nullable (a finding need not name every
// one of camper/choice/occurrence); a null encodes as the fixed marker
// '\0NULL' rather than being opaque()-validated, since opaque() rejects an
// empty string and 'null' would collide with a real id that happened to
// spell that word.
const nullableOpaque = (name, value) => (value == null ? '\0NULL' : opaque(name, value))

export function deriveElectiveRunFindingId(runId, solverGeneration, kind, camperId, choiceId, occurrenceId) {
  return `erf${V}:${join([
    opaque('run_id', runId),
    opaque('solver_generation', solverGeneration),
    opaque('kind', kind),
    nullableOpaque('camper_id', camperId),
    nullableOpaque('choice_id', choiceId),
    nullableOpaque('occurrence_id', occurrenceId),
  ])}`
}

// This slice's eligibility allowlist — see the ADR's item 4 and open question
// 2. Deliberately narrow: whether other buildElectiveAssignments finding
// kinds (e.g. a NO_CAPACITY-class finding) count as "eligibility" for product
// purposes is an unresolved product question (docs/work/tickets/
// T320-elective-run-durability.md "Not in scope"), not guessed here. Widening
// this later is a one-line change.
export const ELIGIBILITY_FINDING_KINDS = ['UNSUPPORTED_LINKED_CHOICE']
