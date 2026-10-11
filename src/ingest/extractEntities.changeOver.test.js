import { describe, it, expect } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import { parseTextGrid } from './textGrid'
import { extractEntities } from './extractEntities'
import { inferFixedEvents } from './fixedEvents'

// F2 (docs/work/evidence/2026-10-11-synthetic-15-scorecard.md): periodSpan's
// change-over rule (T132) dropped every row of <= 10 minutes, including a
// 10-minute Flag Raising that carries a real event. A short row is passing
// time only when it is also empty.
const REPRO = path.join(process.cwd(), 'docs/work/specs/samples/synthetic/repro/r2-ten-minute-event.txt')

describe('F2 - a 10-minute row with an event is a block; an empty change-over is not', () => {
  it('keeps a 10-minute Flag Raising row as a time block and as a fixed event', () => {
    const parsed = parseTextGrid(fs.readFileSync(REPRO, 'utf8'))
    const proposal = extractEntities(parsed)
    expect(proposal.entities.time_blocks).toContain('08:50-09:00')
    const { fixedEvents } = inferFixedEvents({ pages: parsed.pages }, proposal, {})
    expect(JSON.stringify(fixedEvents)).toContain('Flag Raising')
  })

  it('still drops a genuinely empty 10-minute change-over row', () => {
    const text = fs.readFileSync(REPRO, 'utf8').replace(/08:50–09:00 .*/g, '08:50–09:00       -              -              -')
    const blocks = extractEntities(parseTextGrid(text)).entities.time_blocks
    expect(blocks).toContain('09:05-09:50')
    expect(blocks).not.toContain('08:50-09:00')
  })
})
