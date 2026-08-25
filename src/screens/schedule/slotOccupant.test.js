import { describe, it, expect } from 'vitest'
import {
  SLOT_OCCUPANT_FIELDS,
  occupantFields,
  emptyOccupantFields,
  readOccupant,
  occupantWriteKind,
} from './slotOccupant'
import { MUTUALLY_EXCLUSIVE_FIELDS } from '../../../electron/ops/projections.js'

describe('slotOccupant — SLOT_OCCUPANT_FIELDS parity guard', () => {
  it('matches MUTUALLY_EXCLUSIVE_FIELDS.template_slots[0] exactly, same order', () => {
    expect(SLOT_OCCUPANT_FIELDS).toEqual(MUTUALLY_EXCLUSIVE_FIELDS.template_slots[0])
  })
})

describe('slotOccupant — occupantFields', () => {
  it('returns the full triple with the named field set and the others explicitly null', () => {
    expect(occupantFields('activity_id', 'act-1')).toEqual({
      activity_id: 'act-1', elective_set_id: null, event_id: null,
    })
    expect(occupantFields('elective_set_id', 'set-1')).toEqual({
      activity_id: null, elective_set_id: 'set-1', event_id: null,
    })
    expect(occupantFields('event_id', 'ev-1')).toEqual({
      activity_id: null, elective_set_id: null, event_id: 'ev-1',
    })
  })

  it('throws for a field outside SLOT_OCCUPANT_FIELDS', () => {
    expect(() => occupantFields('is_span_head', true)).toThrow()
  })
})

describe('slotOccupant — emptyOccupantFields', () => {
  it('returns all three occupant columns as null', () => {
    expect(emptyOccupantFields()).toEqual({ activity_id: null, elective_set_id: null, event_id: null })
  })
})

describe('slotOccupant — readOccupant', () => {
  it('reads the full triple off a row, normalizing undefined to null', () => {
    const row = { id: 'r1', activity_id: 'act-1' }
    expect(readOccupant(row)).toEqual({ activity_id: 'act-1', elective_set_id: null, event_id: null })
  })

  it('reads an event-headed row', () => {
    const row = { id: 'r1', activity_id: null, elective_set_id: null, event_id: 'ev-1' }
    expect(readOccupant(row)).toEqual({ activity_id: null, elective_set_id: null, event_id: 'ev-1' })
  })
})

describe('slotOccupant — occupantWriteKind', () => {
  it('tags an activity-headed row', () => {
    expect(occupantWriteKind({ activity_id: 'act-1', elective_set_id: null, event_id: null })).toBe('activity:act-1')
  })

  it('tags an elective-headed row', () => {
    expect(occupantWriteKind({ activity_id: null, elective_set_id: 'set-1', event_id: null })).toBe('elective:set-1')
  })

  it('tags an event-headed row', () => {
    expect(occupantWriteKind({ activity_id: null, elective_set_id: null, event_id: 'ev-1' })).toBe('event:ev-1')
  })

  it('tags an empty row', () => {
    expect(occupantWriteKind({ activity_id: null, elective_set_id: null, event_id: null })).toBe('empty')
  })

  it('matches useContentRaceFlag.contentKind()\'s precedence: event over elective over activity', () => {
    // A row should never carry more than one occupant at once (that's the
    // whole point of MUTUALLY_EXCLUSIVE_FIELDS), but if one somehow did,
    // occupantWriteKind must agree with contentKind()'s tie-break order so
    // own-write suppression is never spuriously defeated.
    expect(occupantWriteKind({ activity_id: 'act-1', elective_set_id: 'set-1', event_id: 'ev-1' })).toBe('event:ev-1')
    expect(occupantWriteKind({ activity_id: 'act-1', elective_set_id: 'set-1', event_id: null })).toBe('elective:set-1')
  })
})

describe('slotOccupant — occupant-triple builder lockstep guard (mechanical scan)', () => {
  // Secondary guard, complementing the SLOT_OCCUPANT_FIELDS parity test
  // above: every occupant-triple write inside the four placement handlers
  // (replaceSlot, placeActivityManual, placeElectiveOnCell, placeEventOnCell)
  // must go through occupantFields/emptyOccupantFields/readOccupant, not a
  // hand re-inlined `{ activity_id: X, elective_set_id: Y, ... }` literal.
  // This scans the real source text of useSlotMutations.js and is proven
  // (below) to catch a planted re-inlined triple, so the guard cannot go
  // quietly blind.
  const fs = require('node:fs')
  const path = require('node:path')
  const SOURCE_PATH = path.join(__dirname, 'useSlotMutations.js')
  const HANDLER_NAMES = ['replaceSlot', 'placeActivityManual', 'placeElectiveOnCell', 'placeEventOnCell']

  // Extracts one top-level `async function <name>(...) { ... }` body by
  // brace/paren matching (handles the default-parameter-object destructure
  // that placeElectiveOnCell's signature carries, which a naive
  // indexOf('{')-from-start walk would trip over).
  function extractFunctionBody(source, name) {
    const startMatch = source.match(new RegExp(`async function ${name}\\(`))
    if (!startMatch) throw new Error(`extractFunctionBody: '${name}' not found in source`)
    const start = startMatch.index
    let pi = source.indexOf('(', start)
    let pdepth = 0
    let pend = pi
    for (let i = pi; i < source.length; i++) {
      if (source[i] === '(') pdepth++
      else if (source[i] === ')') { pdepth--; if (pdepth === 0) { pend = i; break } }
    }
    let i = source.indexOf('{', pend)
    let depth = 0
    let end = i
    for (; i < source.length; i++) {
      if (source[i] === '{') depth++
      else if (source[i] === '}') { depth--; if (depth === 0) { end = i; break } }
    }
    return source.slice(start, end + 1)
  }

  // A bare, non-spread occupant-column key — `activity_id:`, `elective_set_id:`,
  // or `event_id:` NOT immediately preceded by `...` — inside the writeSlotFields
  // argument for template_slots. writeElectiveSetActivityFields calls (a
  // DIFFERENT table, elective_set_activities) are excluded — they legitimately
  // set `elective_set_id`/`activity_id` as plain foreign keys on a join row,
  // which has nothing to do with the occupant-triple invariant.
  function findBareOccupantLiterals(functionBody) {
    const lines = functionBody.split('\n')
    const withoutJoinTableCalls = lines
      .filter((line, i) => {
        const window = [lines[i - 1] ?? '', line, lines[i + 1] ?? ''].join('\n')
        return !window.includes('writeElectiveSetActivityFields')
      })
      .join('\n')
    const matches = withoutJoinTableCalls.match(/(?<!\.\.\.)\b(activity_id|elective_set_id|event_id):/g) || []
    return matches
  }

  it('no handler re-inlines a bare occupant-column literal outside the builder', () => {
    const source = fs.readFileSync(SOURCE_PATH, 'utf8')
    for (const name of HANDLER_NAMES) {
      const body = extractFunctionBody(source, name)
      const bare = findBareOccupantLiterals(body)
      expect(bare, `${name} has a bare occupant-column literal — construct it via occupantFields/emptyOccupantFields/readOccupant instead: ${JSON.stringify(bare)}`).toEqual([])
    }
  })

  it('proves the scanner catches a planted re-inlined triple', () => {
    const planted = `
      async function replaceSlot() {
        await repo.writeSlotFields(targetRow.id, { activity_id: incoming.activityId, elective_set_id: null, event_id: null, flags: {} })
      }
    `
    const bare = findBareOccupantLiterals(planted)
    expect(bare.length).toBeGreaterThan(0)
  })
})
