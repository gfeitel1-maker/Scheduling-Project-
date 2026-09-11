// A blank-line block can hold more than one period. Split it.
//
// parseTextGrid delimits rows by blank lines, which was the right call: Camp A
// wraps a period label around its own data row —
//
//     9:50- Block
//                    Drama          Dance          Music
//      10:25   1
//
// — so reading line-by-line produced periods that ran backwards. What the
// blank-line block does not handle is a block containing TWO periods with no
// blank line between them, which Camp A also does, twice: its first block holds
// 9:15-9:40 and 9:50-10:25 back to back, and its swim block nests 11:50-12:25
// inside 11:10-11:45 around a shared instructional/recreational sub-schedule.
//
// normalizeTimeLabel then takes the first two times it can see in the joined
// label, so every row in such a block inherits the FIRST period's name.
//
// The rule: a new period starts at a line whose TIME COLUMN carries another
// time, once the period being accumulated already has a complete label (two
// times — a start and an end) and has seen at least one line of data. Both
// conditions matter. Without the label test, the second half of a wrapped label
// ("10:25  1") would start a period of its own, which is the bug the blank-line
// block was introduced to fix. Without the data test, a label spread over three
// lines with nothing between them would fragment.

function timesIn(text) {
  return (String(text ?? '').match(/\d{1,2}[:.]\d{2}/g) ?? []).length
}

/**
 * @param block  lines of the blank-line block, each an array of tokens
 * @param timeColumnStart  where the first DATA column begins; a token ending at
 *                         or before this sits in the time column
 * @returns an array of blocks, in order. A block with one period comes back as
 *          a single-element array, so the caller's loop does not change shape.
 */
export function splitPeriodBlocks(block, timeColumnStart) {
  if (!Array.isArray(block) || block.length === 0) return []
  // No data column means no time column to read a period out of.
  if (!(timeColumnStart > 0)) return [block]

  const out = []
  let current = []
  let labelTimes = 0
  let sawData = false

  for (const tokens of block) {
    const labelTokens = tokens.filter((t) => t.end <= timeColumnStart)
    const lineHasData = tokens.some((t) => t.end > timeColumnStart)
    const lineStartsPeriod = labelTokens.some((t) => timesIn(t.text) > 0)

    if (lineStartsPeriod && labelTimes >= 2 && sawData && current.length > 0) {
      out.push(current)
      current = []
      labelTimes = 0
      sawData = false
    }

    current.push(tokens)
    for (const t of labelTokens) labelTimes += timesIn(t.text)
    if (lineHasData) sawData = true
  }

  if (current.length > 0) out.push(current)
  return out
}
