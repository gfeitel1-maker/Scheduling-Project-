import { describe, it, expect } from 'vitest'
import { splitPeriodBlocks } from './splitPeriodBlocks'

// Tokens as tokenize() produces them: { text, start, end }. The data columns
// begin at 20 in these fixtures, so anything ending at or before 20 is in the
// time column.
const COL = 20
const t = (text, start) => ({ text, start, end: start + text.length })
const timeCol = (text) => [t(text, 0)]
const dataRow = (...texts) => texts.map((text, i) => t(text, COL + i * 20))
const labelled = (label, ...texts) => [t(label, 0), ...dataRow(...texts)]

describe('splitPeriodBlocks', () => {
  it("splits campA's first block, which holds two periods back to back", () => {
    // " 9:15-" / "  9:40" / "Opening" / "9:50- Block" + data / " 10:25  1"
    const block = [
      timeCol('9:15-'),
      timeCol('9:40'),
      dataRow('Opening'),
      labelled('9:50- Block', 'Drama', 'Dance'),
      timeCol('10:25  1'),
    ]
    const out = splitPeriodBlocks(block, COL)
    expect(out).toHaveLength(2)
    expect(out[0]).toHaveLength(3)
    expect(out[1]).toHaveLength(2)
  })

  it("splits campA's swim block, where a second period nests inside the first", () => {
    const block = [
      dataRow('11:10-11:20 Change'),
      labelled('11:10-Block', '11:20-11:45-'),
      timeCol('11:45  3'),
      dataRow('Instructional Swim'),
      dataRow('11:45-12:10-'),
      labelled('11:50-Block', 'Recreational Swim'),
      timeCol('12:25  4'),
    ]
    const out = splitPeriodBlocks(block, COL)
    expect(out).toHaveLength(2)
    expect(out[0]).toHaveLength(5)
    expect(out[1]).toHaveLength(2)
  })

  it('does NOT split the two halves of one wrapped label — the bug blocks exist to fix', () => {
    // "9:50- Block" over "10:25  1" is ONE period written across two lines.
    // Splitting here is what made a camp come back with 53 periods instead of 8.
    const block = [labelled('9:50- Block', 'Drama'), timeCol('10:25  1')]
    expect(splitPeriodBlocks(block, COL)).toHaveLength(1)
  })

  it('does not split a label spread over three lines with no data between them', () => {
    const block = [timeCol('9:15-'), timeCol('9:40'), timeCol('Block 1'), dataRow('Opening')]
    expect(splitPeriodBlocks(block, COL)).toHaveLength(1)
  })

  it('leaves a one-period block alone', () => {
    expect(splitPeriodBlocks([labelled('08:40-09:00', 'Carpool')], COL)).toHaveLength(1)
  })

  it('splits a file that puts one period per line, as campB does', () => {
    const block = [
      labelled('08:40-09:00', 'Carpool'),
      labelled('09:00-09:15', 'Group Time'),
      labelled('09:20-09:40', 'Mifkad'),
    ]
    expect(splitPeriodBlocks(block, COL)).toHaveLength(3)
  })

  it('never drops a line — every token survives the split', () => {
    const block = [
      timeCol('9:15-'), timeCol('9:40'), dataRow('Opening'),
      labelled('9:50- Block', 'Drama'), timeCol('10:25  1'),
    ]
    const out = splitPeriodBlocks(block, COL)
    expect(out.flat()).toEqual(block)
  })

  it('leaves a block with no time column alone rather than guessing', () => {
    const block = [dataRow('Drama'), dataRow('Dance')]
    expect(splitPeriodBlocks(block, 0)).toEqual([block])
  })

  it('tolerates an empty or missing block', () => {
    expect(splitPeriodBlocks([], COL)).toEqual([])
    expect(splitPeriodBlocks(undefined, COL)).toEqual([])
  })
})
