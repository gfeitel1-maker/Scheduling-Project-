import { describe, it, expect } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import { parseTextGrid } from './textGrid.js'
import { extractEntities } from './extractEntities.js'
import { capturePlacements } from './capturePlacements.js'
import { detectAllCampOverrides } from './allCampOverrides.js'
import { buildReconciliationReport } from './reconciliationReport.js'
import { formatBlockTime12h } from './blockTimeText.js'

// I7 — a review question must show what a director recognises: the day, the
// time in 12-hour form, the FULL name as written, which groups, and what each
// excluded group has instead. Never a bare fragment.
const campB = fs.readFileSync(path.join(process.cwd(), 'docs/work/specs/samples/campB-by-day.txt'), 'utf8')

describe('formatBlockTime12h', () => {
  it('reads a bare camp-day range as 12-hour with one meridiem when both ends agree', () => {
    expect(formatBlockTime12h('02:25-03:15')).toBe('2:25–3:15 PM')
    expect(formatBlockTime12h('09:00–09:40')).toBe('9:00–9:40 AM')
  })
  it('shows both meridiems when the range crosses noon', () => {
    expect(formatBlockTime12h('11:30-12:10')).toBe('11:30 AM–12:10 PM')
  })
  it('leaves a named period alone', () => {
    expect(formatBlockTime12h('Block 2')).toBe('Block 2')
  })
})

describe('campB all-camp-override question copy', () => {
  const parsed = parseTextGrid(campB)
  const proposal = extractEntities(parsed)
  const { placements } = capturePlacements(parsed, proposal)
  const findings = detectAllCampOverrides(placements, proposal.entities.groups)
  const report = buildReconciliationReport({ planItems: [], readiness: [], allCampOverrides: findings })
  const questions = report.decisions.filter((d) => d.kind === 'all_camp_override')

  it('asks about the full "All Camp Activity" name, never a fragment', () => {
    expect(questions.length).toBeGreaterThan(0)
    for (const q of questions) {
      expect(q.entityName).not.toBe('Activity')
      expect(q.entityName).not.toBe('All Camp')
    }
  })

  it('reads day, 12-hour time, full name, who, and what the excluded group has instead', () => {
    const thursday = questions.find((q) => q.evidence.day === 'Thursday')
    expect(thursday.reason).toContain(
      'Thursday 2:25–3:15 PM · All Camp Activity · every group except CIT (CIT Block 3)',
    )
  })

  it('every question carries a day, a 12-hour time and a full name', () => {
    for (const q of questions) {
      expect(q.reason).toMatch(/^(Monday|Tuesday|Wednesday|Thursday|Friday|Saturday|Sunday) \d{1,2}:\d{2}(–\d{1,2}:\d{2})? ?(AM|PM)?/)
      expect(q.reason).toContain(` · ${q.entityName} · `)
      expect(q.reason).toMatch(/every group except/)
    }
  })
})
