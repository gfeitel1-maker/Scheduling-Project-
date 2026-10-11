import { describe, it, expect } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import { parseTextGrid } from './textGrid'
import { extractEntities } from './extractEntities'
import { inferFixedEvents } from './fixedEvents'
import { buildPlan } from './buildPlan'

// F2 (docs/work/evidence/2026-10-11-synthetic-15-scorecard.md): periodSpan's
// change-over rule (T132) dropped every row of <= 10 minutes, including a
// 10-minute Flag Raising that carries a real event. A short row is passing
// time unless most groups print the same event in it.
const SAMPLES = path.join(process.cwd(), 'docs/work/specs/samples')
const REPRO = path.join(SAMPLES, 'synthetic/repro/r2-ten-minute-event.txt')
const blocksOf = (text) => extractEntities(parseTextGrid(text)).entities.time_blocks

describe('F2 - a 10-minute row with an event is a block; a change-over is not', () => {
  it('keeps a 10-minute Flag Raising row as a time block and as a fixed event', () => {
    const parsed = parseTextGrid(fs.readFileSync(REPRO, 'utf8'))
    const proposal = extractEntities(parsed)
    expect(proposal.entities.time_blocks).toContain('08:50-09:00')
    const { fixedEvents } = inferFixedEvents({ pages: parsed.pages }, proposal, {})
    expect(JSON.stringify(fixedEvents)).toContain('Flag Raising')
  })

  it('creates the kept Flag Raising block events-only through the real extract -> infer -> plan path', () => {
    const parsed = parseTextGrid(fs.readFileSync(REPRO, 'utf8'))
    const proposal = extractEntities(parsed)
    const { fixedEvents } = inferFixedEvents({ pages: parsed.pages }, proposal, {})
    const p = buildPlan({ approved: { time_blocks: proposal.entities.time_blocks }, camp_id: 'c', cohort_id: 'k', fixedEvents })
    const byName = (n) => p.items.find((i) => i.entity === 'time_blocks' && i._name === n)
    expect(byName('08:50-09:00').fields.events_only).toMatchObject({ to: 1 })
    expect(byName('09:05-09:50').fields.events_only).toBeUndefined()
  })

  it('still drops a genuinely empty 10-minute change-over row', () => {
    const text = fs.readFileSync(REPRO, 'utf8').replace(/08:50–09:00 .*/g, '08:50–09:00       -              -              -')
    const blocks = blocksOf(text)
    expect(blocks).toContain('09:05-09:50')
    expect(blocks).not.toContain('08:50-09:00')
  })

  it('keeps a partial short row (2 of 3 groups print the event)', () => {
    const text = fs.readFileSync(REPRO, 'utf8').replace(/08:50–09:00 .*/g, '08:50–09:00       Flag Raising   Flag Raising   -')
    expect(blocksOf(text)).toContain('08:50-09:00')
  })

  it('drops a short row where only one of three groups prints something', () => {
    const text = fs.readFileSync(REPRO, 'utf8').replace(/08:50–09:00 .*/g, '08:50–09:00       Flag Raising   -              -')
    expect(blocksOf(text)).not.toContain('08:50-09:00')
  })

  it('keeps a short row in a by-group layout', () => {
    const text = `Otters 1

   Time           Monday         Tuesday        Wednesday

08:50–09:00       Flag Raising   Flag Raising   Flag Raising

09:05–09:50       Archery        Music          Drama

10:00–10:45       Swim           Swim           Swim
`
    expect(blocksOf(text)).toContain('08:50-09:00')
  })
})

describe('T132 golden - real-sample time-block counts', () => {
  it('campA stays at 11 blocks (main before F2; T132 recorded 13 before later merging): overflow slivers stay dropped', () => {
    const blocks = blocksOf(fs.readFileSync(path.join(SAMPLES, 'campA-bunk-schedules.txt'), 'utf8'))
    expect(blocks).toHaveLength(11)
    for (const sliver of ['1:05-1:10', '11:45-11:50', '1:45-1:50', '2:25-2:30', '3:45-3:55']) {
      expect(blocks).not.toContain(sliver)
    }
  })

  it('campC keeps its all-group Closing Circle and Pick Up rows (F2 intent)', () => {
    const blocks = blocksOf(fs.readFileSync(path.join(SAMPLES, 'campC-daysheet-synthetic.txt'), 'utf8'))
    expect(blocks).toHaveLength(9)
    expect(blocks).toContain('03:20-03:25')
    expect(blocks).toContain('03:45-03:50')
  })

  it('campB is unchanged at 12 blocks', () => {
    expect(blocksOf(fs.readFileSync(path.join(SAMPLES, 'campB-by-day.txt'), 'utf8'))).toHaveLength(12)
  })
})
