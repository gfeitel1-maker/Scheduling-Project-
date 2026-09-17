// @vitest-environment node
//
// T194 — the participant entities are DELIBERATELY absent from the MCP
// ENTITY_MAP, and that exclusion is the decision, not an oversight.
//
// The implementation spec's success predicate lists "generic `list_entities`
// returning camper rows" under DOES NOT COUNT AS DONE. ENTITY_MAP is what
// list_entities resolves a caller-supplied name against, so an entry here is a
// machine-readable read path into a child's record, reachable by anything
// holding the MCP server — outside the app's role model entirely.
//
// NOTHING GUARDS THIS MAP TODAY. It is a hand-maintained object with no parity
// test, which is exactly why a negative test is required rather than a comment:
// a future slice adding `campers: 'campers'` for convenience would otherwise
// ship silently. T198 revisits machine access deliberately; until then this
// test is the gate.
import { describe, it, expect } from 'vitest'
import { ENTITY_MAP } from './tools.js'

const PARTICIPANT_ENTITIES = [
  'campers',
  'elective_assignment_runs',
  'elective_occurrences',
  'elective_choices',
  'elective_choice_offerings',
  'elective_preferences',
  'elective_assignments',
]

describe('MCP ENTITY_MAP excludes the participant domain', () => {
  it('names none of the seven as a caller-facing KEY', () => {
    for (const entity of PARTICIPANT_ENTITIES) {
      expect(Object.keys(ENTITY_MAP), `${entity} is an MCP-addressable name`).not.toContain(entity)
    }
  })

  it('names none of the seven as a resolved TABLE value', () => {
    // Checking values as well as keys matters: an alias like
    // `children: 'campers'` would pass a key-only check while exposing exactly
    // the rows this test exists to keep out.
    for (const entity of PARTICIPANT_ENTITIES) {
      expect(Object.values(ENTITY_MAP), `${entity} is reachable via an alias`).not.toContain(entity)
    }
  })

  it('exposes no table whose name suggests a participant surface', () => {
    // Catches a seven-entity rename or an eighth participant table added later
    // under a name this file's hard-coded list does not know about.
    for (const value of Object.values(ENTITY_MAP)) {
      expect(value, `${value} looks like a participant table`).not.toMatch(
        /camper|elective_assignment|elective_preference|elective_choice|elective_occurrence/
      )
    }
  })

  // NON-VACUITY: a test that only asserts absence passes just as happily
  // against an empty map, or if the import silently yielded undefined.
  it('positive control: the map is populated and DOES expose the ordinary setup entities', () => {
    expect(Object.keys(ENTITY_MAP).length).toBeGreaterThan(5)
    expect(Object.values(ENTITY_MAP)).toContain('activities')
    expect(Object.values(ENTITY_MAP)).toContain('groups')
  })
})
