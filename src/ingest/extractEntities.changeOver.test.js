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

// T366: a short row that fails the 2/3 agreement line is never dropped silently.
const GRID5 = ['Otters 1', 'Otters 2', 'Otters 3', 'Otters 4', 'Otters 5']
const sparseFile = (shortRow, longRow) => {
  const row = (time, cells) => `${time.padEnd(18)}${cells.map((c) => c.padEnd(18)).join('')}`.trimEnd()
  return ['Monday — All Camp', '', `   Time           ${GRID5.map((g) => g.padEnd(18)).join('')}`, '',
    row('08:50–09:00', shortRow), '', row('09:05–09:50', ['Archery', 'Music', 'Drama', 'Swim', 'Art']), '',
    row('15:00–15:10', longRow), ''].join('\n')
}

describe('T366 - a sparse short row is kept or reported, never dropped silently', () => {
  it('keeps the row as a block when its text matches an event the file prints elsewhere', () => {
    const text = sparseFile(['Flag Raising', 'Flag Raising', 'Flag Raising', '', ''], Array(5).fill('Flag raising!'))
    expect(blocksOf(text)).toContain('08:50-09:00')
  })

  it('drops and reports a row where under half the cells match a known event (2 of 5)', () => {
    const text = sparseFile(['Flag Raising', 'Flag Raising', '', '', ''], Array(5).fill('Flag raising!'))
    const proposal = extractEntities(parseTextGrid(text))
    expect(proposal.entities.time_blocks).not.toContain('08:50-09:00')
    expect(proposal.skippedShortRows).toEqual([{ label: '08:50-09:00', text: 'Flag Raising', groups: ['Otters 1', 'Otters 2'] }])
  })

  it('reports a dropped sparse row by time, name and groups when nothing else matches', () => {
    const text = sparseFile(['Flag Raising', 'Flag Raising', '', '', ''], Array(5).fill('Closing Circle'))
    const proposal = extractEntities(parseTextGrid(text))
    expect(proposal.entities.time_blocks).not.toContain('08:50-09:00')
    expect(proposal.skippedShortRows).toEqual([
      { label: '08:50-09:00', text: 'Flag Raising', groups: ['Otters 1', 'Otters 2'] },
    ])
  })

  it('reports nothing for a genuinely empty change-over row', () => {
    const text = sparseFile(['-', '-', '-', '-', '-'], Array(5).fill('Closing Circle'))
    expect(extractEntities(parseTextGrid(text)).skippedShortRows).toEqual([])
  })
})

describe('T364 - what a kept short block prints', () => {
  it('records the text most cells print, per kept short block', () => {
    const text = sparseFile(Array(5).fill('Swim'), Array(5).fill('Flag raising!'))
    expect(extractEntities(parseTextGrid(text)).shortBlockPrints).toEqual({ '08:50-09:00': 'Swim', '15:00-15:10': 'Flag raising!' })
  })

  it('Red Hat 5: a 2 Flag Raising / 2 Swim row (a tie, under agreement) is kept but prints nothing', () => {
    const row = (time, cells) => `${time.padEnd(18)}${cells.map((c) => c.padEnd(18)).join('')}`.trimEnd()
    const text = ['Monday — All Camp', '', `   Time           ${GRID5.map((g) => g.padEnd(18)).join('')}`, '',
      row('08:50–09:00', ['Flag Raising', 'Flag Raising', 'Swim', 'Swim', '']), '',
      row('09:05–09:50', ['Archery', 'Music', 'Drama', 'Art', 'Chess']), '',
      row('15:00–15:10', Array(5).fill('Flag raising!')), '',
      row('16:00–16:10', Array(5).fill('Swim')), ''].join('\n')
    const out = extractEntities(parseTextGrid(text))
    expect(out.entities.time_blocks).toContain('08:50-09:00')
    expect(out.shortBlockPrints['08:50-09:00']).toBeUndefined()
  })

  it('records nothing for a long block or a dropped change-over', () => {
    const text = sparseFile(['-', '-', '-', '-', '-'], Array(5).fill('Closing Circle'))
    expect(Object.keys(extractEntities(parseTextGrid(text)).shortBlockPrints)).toEqual(['15:00-15:10'])
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
