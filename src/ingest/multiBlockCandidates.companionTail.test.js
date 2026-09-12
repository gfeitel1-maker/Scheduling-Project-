import { describe, it, expect } from 'vitest'
import { extractEntities } from './extractEntities'
import { inferMultiBlockCandidates } from './multiBlockCandidates'

// T143 — docs/work/tickets/T143-swim-return-never-paired-as-multiblock.md
//
// Swim / Swim Return are twins: in all 14 sheets of the owner's real file,
// Swim Return sits in the block immediately after Swim and never occurs
// without it. They are one two-block swim session (the second block is
// travel), not two activities. The merged-cell walk cannot see this — the two
// halves are separately-named cells, not an XLSX vertical merge — so it needs
// its own detector.
//
// THE FALSE POSITIVE THIS MUST NOT PRODUCE, found in that same file: Menucha
// always sits in the block right after Lunch 1 and never occurs standalone, so
// "tail never occurs alone" ALONE would wrongly weld Lunch 1 + Menucha. What
// separates them is the head: every Swim has a Return, while Lunch 1 happens
// five days a week and is followed by Menucha on only some of them. So the
// head must ALSO be followed by the tail most of the time.
const DAYS = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday']
const row = (label, cells) => ({ label, cells })

// Camp {A, B, C}, Mon-Fri, five blocks:
//   11:00  Lunch 1 every day, every group          <- head of the DECOY pair
//   12:00  Swim      Mon + Wed                     <- real head
//   13:00  Swim Return, exactly where Swim was     <- real tail
//   14:00  Menucha   Tue + Thu only                <- decoy tail (never alone,
//                                                     but Lunch 1 is usually
//                                                     NOT followed by it)
//   15:00  Sports    every day                     <- ordinary activity
function page(title) {
  return {
    title,
    columns: DAYS,
    rows: [
      row('11:00-11:40', DAYS.map(() => 'Lunch 1')),
      row('12:00-12:40', DAYS.map((d) => (d === 'Monday' || d === 'Wednesday' ? 'Swim' : ''))),
      row('13:00-13:40', DAYS.map((d) => (d === 'Monday' || d === 'Wednesday' ? 'Swim Return' : ''))),
      // Menucha sits directly after Lunch 1 in block order ONLY on the days
      // Swim/Swim Return are absent, so it is always preceded by a filled
      // block and never stands alone.
      row('14:00-14:40', DAYS.map((d) => (d === 'Tuesday' || d === 'Thursday' ? 'Menucha' : ''))),
      row('15:00-15:40', DAYS.map(() => 'Sports')),
      // Two more decoys, both measured as real FALSE WELDS on the owner's file
      // before clause (4) existed. Each is rigidly sequential and would pass
      // the purely structural clauses (1)-(3) at a perfect 100%:
      //   Group Time -> Mifkad : two separate daily anchors, every group,
      //                          every day, always in that order.
      //   CIT Block 1 -> CIT Block 2 : a numbered chain sharing a prefix.
      row('16:00-16:40', DAYS.map(() => 'Group Time')),
      row('16:45-17:25', DAYS.map(() => 'Mifkad')),
      row('17:30-18:10', DAYS.map(() => 'CIT Block 1')),
      row('18:15-18:55', DAYS.map(() => 'CIT Block 2')),
    ],
  }
}

const parsed = { pages: ['A', 'B', 'C'].map(page) }
const proposal = extractEntities(parsed)
const { multiBlockCandidates } = inferMultiBlockCandidates(parsed, proposal)
const find = (name, startBlock) =>
  multiBlockCandidates.find((c) => c.name === name && c.start_block === startBlock)

describe('inferMultiBlockCandidates — companion tail (T143)', () => {
  it('pairs a tail that never occurs without its head into one two-block candidate', () => {
    const swim = find('Swim', '12:00-12:40')
    expect(swim).toBeTruthy()
    expect(swim.span_blocks).toBe(2)
    expect(swim.tail_name).toBe('Swim Return')
    expect(swim.days).toEqual(['Monday', 'Wednesday'])
    expect(swim.scope).toEqual({ is_all_groups: true, groups: null })
  })

  it('does not also propose the tail as a candidate in its own right', () => {
    expect(find('Swim Return', '13:00-13:40')).toBeUndefined()
  })

  it('does NOT weld a head that usually has no tail (Lunch 1 + Menucha)', () => {
    expect(find('Lunch 1', '11:00-11:40')).toBeUndefined()
    expect(multiBlockCandidates.some((c) => c.tail_name === 'Menucha')).toBe(false)
  })

  it('leaves an ordinary activity alone', () => {
    expect(find('Sports', '15:00-15:40')).toBeUndefined()
  })

  it('does NOT weld two daily anchors that merely always run in order', () => {
    expect(find('Group Time', '16:00-16:40')).toBeUndefined()
    expect(multiBlockCandidates.some((c) => c.tail_name === 'Mifkad')).toBe(false)
  })

  it('does NOT weld a numbered chain that shares a prefix', () => {
    expect(find('CIT Block 1', '17:30-18:10')).toBeUndefined()
    expect(multiBlockCandidates.some((c) => c.tail_name === 'CIT Block 2')).toBe(false)
  })

  it('proposes exactly one candidate for this grid', () => {
    expect(multiBlockCandidates.map((c) => `${c.name} + ${c.tail_name}`)).toEqual(['Swim + Swim Return'])
  })

  it('emits nothing for a grid with no companion pattern', () => {
    const flat = { pages: [{ title: 'A', columns: DAYS, rows: [row('09:00-09:40', DAYS.map(() => 'Sports'))] }] }
    const out = inferMultiBlockCandidates(flat, extractEntities(flat))
    expect(out.multiBlockCandidates).toEqual([])
  })
})
