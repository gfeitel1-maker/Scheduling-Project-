import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

// Every reason `buildSpecialDayPlan` can put in `blockedBy` disables the "Build
// this special day" button. A reason with no rendered explanation therefore
// produces a DEAD BUTTON: `disabled` blocks the click handler, so
// commitSpecialDayPlan's "not ready to build (<reasons>)" Error is never thrown
// either, and the director is told nothing at all.
//
// That is not hypothetical. T255 slice A added `ambiguous_activities` alongside
// the already-rendered `ambiguous_columns` and shipped with no message, and Red
// Hat found a director staring at a disabled button the evening before a colour
// war with no way to learn that two activities share a name.
//
// This guard PARSES specialDayPlan.js rather than hardcoding the reason list,
// so adding a reason cannot quietly skip the render. A hardcoded copy of the
// list would have to be kept in step by the same person who forgot the message.
const planSource = readFileSync(
  fileURLToPath(new URL('../ingest/specialDayPlan.js', import.meta.url)),
  'utf8'
)
const screenSource = readFileSync(
  fileURLToPath(new URL('./ImportScreen.jsx', import.meta.url)),
  'utf8'
)

export function blockedByReasonsIn(source) {
  return [...source.matchAll(/blockedBy\.push\(\s*'([a-z_]+)'\s*\)/g)].map((m) => m[1])
}

// The plan field whose non-empty value each reason is derived from. A reason is
// "explained" when ImportScreen renders something keyed off that field.
//
// `no_name` is the one deliberate exception and needs no message: the reason it
// blocks is that the director has not typed a name into the field they are
// looking at, so a sentence telling them the name is empty adds nothing. Every
// other reason describes a condition somewhere ELSE in the camp, which the
// director cannot see from this screen and must be told about.
const EXPLAINED_BY_FIELD = {
  unmatched_columns: 'unmatchedColumns',
  ambiguous_columns: 'ambiguousColumns',
  ambiguous_activities: 'ambiguousActivityNames',
  name_taken: 'nameTaken',
}
const NEEDS_NO_MESSAGE = new Set(['no_name'])

describe('every special-day blockedBy reason is explained to the director', () => {
  const reasons = blockedByReasonsIn(planSource)

  it('finds the reasons by parsing the plan builder, not from a hardcoded list', () => {
    // If this fails, blockedBy.push stopped matching the pattern and the guard
    // below has gone vacuous — it would pass by checking nothing.
    expect(reasons.length).toBeGreaterThanOrEqual(5)
    expect(reasons).toContain('ambiguous_activities')
  })

  it('accounts for every reason: each is either rendered or explicitly exempt', () => {
    for (const reason of reasons) {
      if (NEEDS_NO_MESSAGE.has(reason)) continue
      expect(
        EXPLAINED_BY_FIELD[reason],
        `blockedBy reason '${reason}' is neither mapped to a plan field in ` +
          `EXPLAINED_BY_FIELD nor listed in NEEDS_NO_MESSAGE. It disables the Build ` +
          `button, so decide which it is rather than leaving the director a dead button.`
      ).toBeTruthy()
    }
  })

  it('renders a message keyed off each explained reason\'s plan field', () => {
    for (const reason of reasons) {
      if (NEEDS_NO_MESSAGE.has(reason)) continue
      const field = EXPLAINED_BY_FIELD[reason]
      expect(
        screenSource.includes(`specialDayPlan.${field}`),
        `ImportScreen.jsx never reads specialDayPlan.${field}, so blockedBy ` +
          `reason '${reason}' disables the Build button silently.`
      ).toBe(true)
    }
  })

  // NON-VACUITY. The guard is only worth having if it fires on a shape it was
  // not written against. It was written against ONE defect — a new reason with
  // no message — so planting that same defect proves nothing (the guard's
  // description is part of the guard).
  //
  // So plant two DIFFERENT shapes instead:
  //
  //   1. A reason that exists and IS mapped, but whose plan field the screen
  //      does not actually read. That is the "someone deleted the paragraph
  //      while leaving the mapping in place" defect, which is not the shape the
  //      guard was written for and which the mapping table alone would miss.
  //   2. A reason pushed through a differently-spelled call that the parser
  //      still has to catch.
  it('fires on a mapped reason whose message was deleted from the screen', () => {
    const screenWithMessageDeleted = screenSource.replaceAll(
      'specialDayPlan.ambiguousColumns',
      'specialDayPlan.somethingElse'
    )
    // Same assertion the real guard makes, against the mutated screen.
    expect(screenWithMessageDeleted.includes('specialDayPlan.ambiguousColumns')).toBe(false)
    const survivingReasons = blockedByReasonsIn(planSource).filter(
      (r) => !NEEDS_NO_MESSAGE.has(r) && !screenWithMessageDeleted.includes(`specialDayPlan.${EXPLAINED_BY_FIELD[r]}`)
    )
    expect(survivingReasons).toContain('ambiguous_columns')
  })

  it('parses a reason pushed with different spacing', () => {
    expect(blockedByReasonsIn("blockedBy.push( 'weird_new_reason' )")).toEqual(['weird_new_reason'])
  })
})
