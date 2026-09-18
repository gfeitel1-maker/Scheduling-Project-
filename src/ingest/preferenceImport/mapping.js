// T195 — the preference-import mapping model. Pure: no db, no IPC.
//
// ADR D8 (docs/adr/2026-09-17-individual-elective-scheduling.md) is satisfied
// STRUCTURALLY here: ALLOWED_MAPPING_TARGETS is the one closed enum every
// column-picker and every validated mapping is built from, so there is no
// code path that can render or accept a target outside it — even when the
// sheet genuinely contains a "Medical Notes" or "DOB" header. Widening this
// enum is an ADR-level change, not a field addition.
export const ALLOWED_MAPPING_TARGETS = Object.freeze(['displayName', 'group', 'externalId', 'choiceRank'])

// Mapping shape (see T195 brief §Modules):
//   {
//     displayName: colIndex, group: colIndex, externalId: colIndex|null,
//     noPreferenceValues: string[],
//     choices: [ { label, isLinked, memberColumns: number[] } ]  // memberColumns ordered by rank
//   }
export function validateMapping(mapping, headers) {
  const errors = []
  const lastIndex = (headers?.length ?? 0) - 1

  const checkColumn = (name, value, { required = true } = {}) => {
    if (value === null || value === undefined) {
      if (required) errors.push(`${name} is required`)
      return
    }
    if (!Number.isInteger(value) || value < 0 || value > lastIndex) {
      errors.push(`${name} column index is out of range`)
    }
  }

  if (!mapping || typeof mapping !== 'object') {
    return { ok: false, errors: ['mapping is required'] }
  }

  checkColumn('displayName', mapping.displayName)
  checkColumn('group', mapping.group)
  checkColumn('externalId', mapping.externalId, { required: false })

  if (!Array.isArray(mapping.noPreferenceValues)) {
    errors.push('noPreferenceValues must be an array')
  }

  const choices = Array.isArray(mapping.choices) ? mapping.choices : null
  if (!choices || choices.length === 0) {
    errors.push('at least one choice column group is required')
  } else {
    choices.forEach((choice, i) => {
      if (!choice || typeof choice.label !== 'string' || choice.label.length === 0) {
        errors.push(`choice[${i}].label is required`)
      }
      const members = Array.isArray(choice?.memberColumns) ? choice.memberColumns : []
      if (members.length === 0) {
        errors.push(`choice[${i}].memberColumns must have at least one column`)
      }
      if (choice?.isLinked && members.length < 2) {
        errors.push(`choice[${i}] is marked linked but has fewer than two member columns`)
      }
      members.forEach((col) => checkColumn(`choice[${i}].memberColumns`, col))
    })
  }

  return { ok: errors.length === 0, errors }
}
