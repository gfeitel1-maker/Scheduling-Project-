import { describe, it, expect } from 'vitest'
import { extractEntities } from './extractEntities'
import { inferFixedEvents } from './fixedEvents'
import { findMovedPlacements } from './movedPlacements'

// Owner, 2026-09-12, on the real camp: lunch used to be identical across all
// days. Wednesday was changed LATER, because a different group's pool schedule
// made it necessary — so the Wednesday cell is an EXCEPTION to the normal
// lunch, not a fourth lunch.
//
// Shoresh files it as a new activity today, silently. This module notices it
// instead. It is a NOTE, not a question: it tells the director and they can
// move past it (owner, same conversation).
//
// The signal is structural, never the word "lunch" — the reliable part is the
// SHAPE: a pinned slot is absent for a group on one day, and a name that
// appears NOWHERE ELSE fills exactly that gap, for exactly those groups. That
// works for a camp that calls it Mittagessen, and for swim, and for anything.
const DAYS = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday']
const row = (label, cells) => ({ label, cells })
const onDays = (days, value) => DAYS.map((d) => (days.includes(d) ? value : ''))

// SIX groups, because the real case is a MINORITY of them. Chalutzim (3 of 14)
// move their lunch; everyone else does not. A fixture where ALL groups move is
// not this case at all — T141's group-coverage arm correctly detects that as a
// recurring event in its own right, and there is nothing to explain.
//
// A, B, C  — lunch at 12:00 four days; on Wednesday Music takes that slot and
//            "Late Lunch" appears at 13:00.
// D, E, F  — lunch at 12:00 all five days, undisturbed.
const MOVERS = ['A', 'B', 'C']
const page = (title) => ({
  title,
  columns: DAYS,
  rows: MOVERS.includes(title)
    ? [
        row('12:00-12:40', DAYS.map((d) => (d === 'Wednesday' ? 'Music' : 'Lunch'))),
        row('13:00-13:40', onDays(['Wednesday'], 'Late Lunch')),
        row('14:00-14:40', DAYS.map(() => 'Sports')),
      ]
    : [
        row('12:00-12:40', DAYS.map(() => 'Lunch')),
        row('14:00-14:40', DAYS.map(() => 'Sports')),
      ],
})
const parsed = { pages: ['A', 'B', 'C', 'D', 'E', 'F'].map(page) }
const proposal = extractEntities(parsed)
const { fixedEvents } = inferFixedEvents(parsed, proposal)
const notes = findMovedPlacements(parsed, proposal, fixedEvents)

describe('findMovedPlacements', () => {
  it('notices that the pinned slot moved, and says what moved where', () => {
    expect(notes).toEqual([{
      pinned: 'Lunch',
      pinned_block: '12:00-12:40',
      moved: 'Late Lunch',
      moved_block: '13:00-13:40',
      groups: ['A', 'B', 'C'],
      days: ['Wednesday'],
    }])
  })

  it('does not mistake whatever TOOK the slot for the thing that moved', () => {
    // Music fills the 12:00 block on Wednesday for exactly those three groups,
    // so it matches the gap just as well as Late Lunch does. It is the
    // replacement, not the relocation — the thing that MOVED is somewhere else.
    expect(notes.some((n) => n.moved === 'Music')).toBe(false)
  })

  it('does not propose the moved name as a pinned event in its own right', () => {
    // It is an exception to Lunch, not a second pinned thing.
    expect(fixedEvents.some((e) => e.name === 'Late Lunch')).toBe(false)
  })

  // --- precision guards ---

  const build = (rowsFor) => {
    const p = { pages: ['A', 'B', 'C', 'D', 'E', 'F'].map((t) => ({ title: t, columns: DAYS, rows: rowsFor(t) })) }
    const pr = extractEntities(p)
    return findMovedPlacements(p, pr, inferFixedEvents(p, pr).fixedEvents)
  }

  it('says nothing when the filler also appears on other days', () => {
    // Swim shows up all week, so Swim-on-Wednesday is not "lunch moved" — it
    // is just Wednesday's activity.
    expect(build((t) => MOVERS.includes(t)
      ? [row('12:00-12:40', DAYS.map((d) => (d === 'Wednesday' ? 'Music' : 'Lunch'))), row('13:00-13:40', DAYS.map(() => 'Swim'))]
      : [row('12:00-12:40', DAYS.map(() => 'Lunch')), row('13:00-13:40', DAYS.map(() => 'Swim'))]
    )).toEqual([])
  })

  it('says nothing when the filler covers only some of the pinned groups', () => {
    // A partial match is a different thing happening, not a move.
    expect(build((t) => MOVERS.includes(t)
      ? [row('12:00-12:40', DAYS.map((d) => (d === 'Wednesday' ? 'Music' : 'Lunch'))), row('13:00-13:40', t === 'A' ? onDays(['Wednesday'], 'Late Lunch') : DAYS.map(() => ''))]
      : [row('12:00-12:40', DAYS.map(() => 'Lunch')), row('14:00-14:40', DAYS.map(() => 'Sports'))]
    )).toEqual([])
  })

  it('says nothing when the pinned slot is never absent', () => {
    expect(build(() => [row('12:00-12:40', DAYS.map(() => 'Lunch')), row('14:00-14:40', DAYS.map(() => 'Sports'))])).toEqual([])
  })

  it('is safe on an empty or malformed parse', () => {
    expect(findMovedPlacements({ pages: [] }, {}, [])).toEqual([])
    expect(findMovedPlacements(null, null, null)).toEqual([])
  })
})
