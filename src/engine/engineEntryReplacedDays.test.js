// T350 (docs/adr/2026-10-09-special-day-binds-to-a-week-day.md D4, D4.5): every
// call site of an engine entry, and every hand-built stats/findings site, must
// carry `replacedDayIds`. This enumerates them from the source tree and fails
// on any call site not in the table — a new entry has to be wired and listed,
// or it would silently schedule onto a special day.
import { describe, it, expect } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { recalcStats, recalcFindings } from '../screens/schedule/useScheduleData.js'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
const SCAN_DIRS = ['src', 'electron', 'scripts']

// A frozen historical copy of the engine, not a live entry.
const ALLOWED_FILES = new Set(['scripts/_buildSchedule.before.mjs'])

// file → number of call sites of each entry, each of which passes replacedDayIds.
// The ScheduleScreen closure wrappers recalcStats(slotList)/recalcFindings(slotList)
// and their callers in useSlotMutations/useSnapshots only forward, so they are
// exempt (the wrapper body is what is counted, under ScheduleScreen.jsx).
const EXPECTED = {
  buildSchedule: {
    'src/screens/schedule/useGeneration.js': 2,
    'scripts/mcp/tools.js': 1,
  },
  computeFindings: {
    'src/screens/schedule/useGeneration.js': 1,
    'src/screens/schedule/useScheduleData.js': 1,
    'src/screens/schedule/useSnapshots.js': 1,
  },
  recalcStatsPure: {
    // the stats wrapper, plus the export picker's "N of M placed" line (#835)
    'src/screens/ScheduleScreen.jsx': 2,
  },
  recalcFindingsPure: {
    'src/screens/ScheduleScreen.jsx': 1,
  },
  statsFor: {
    'src/screens/schedule/useGeneration.js': 2,
  },
  assembleScheduleEngineInputs: {
    'scripts/mcp/tools.js': 1,
  },
}

// How a site visibly carries it: by name, as the hook's local `replaced`, as the
// MCP's `...inputs` (assembleScheduleEngineInputs returns replacedDayIds), or as
// the week argument assembleScheduleEngineInputs resolves it from.
const CARRIES = /replacedDayIds|\breplaced\b|\.\.\.inputs\b|, weekId\)/

function walk(dir, out) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name.startsWith('.')) continue
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) walk(full, out)
    else if (/\.(js|jsx|mjs)$/.test(entry.name) && !/\.test\.(js|jsx|mjs)$/.test(entry.name)) out.push(full)
  }
  return out
}

// A call: the name, not preceded by `function `/`.`/an identifier char, then `(`.
// Comment lines are skipped so prose mentioning `buildSchedule()` is not a site.
function callSites(src, name) {
  const re = new RegExp(`(?<![\\w.$])${name}\\(`, 'g')
  const sites = []
  const lines = src.split('\n')
  lines.forEach((line, i) => {
    const code = line.replace(/\/\/.*$/, '')
    if (/^\s*\*/.test(line)) return
    if (new RegExp(`function\\s+${name}\\(`).test(code)) return
    re.lastIndex = 0
    if (re.test(code)) sites.push({ line: i, text: lines.slice(i, i + 3).join('\n') })
  })
  return sites
}

const files = SCAN_DIRS.flatMap(d => walk(path.join(root, d), []))
  .map(f => path.relative(root, f).split(path.sep).join('/'))
  .filter(f => !ALLOWED_FILES.has(f))

describe('every engine entry call site carries replacedDayIds', () => {
  for (const [name, expected] of Object.entries(EXPECTED)) {
    it(`${name}: the call-site table is complete and each site passes it`, () => {
      const found = {}
      const missing = []
      for (const rel of files) {
        const src = fs.readFileSync(path.join(root, rel), 'utf8')
        const sites = callSites(src, name)
        if (sites.length === 0) continue
        found[rel] = sites.length
        for (const s of sites) if (!CARRIES.test(s.text)) missing.push(`${rel}:${s.line + 1}`)
      }
      expect(found).toEqual(expected)
      expect(missing).toEqual([])
    })
  }

  it('the hand-built ctx sites in useScheduleData pass it on both routes', () => {
    const src = fs.readFileSync(path.join(root, 'src/screens/schedule/useScheduleData.js'), 'utf8')
    const ctxCalls = src.match(/recalcFindings\(saved, \{[\s\S]*?\}\)/g) || []
    expect(ctxCalls).toHaveLength(2)
    for (const c of ctxCalls) expect(c).toMatch(/replacedDayIds/)
    expect(src).toMatch(/recalcStats\(saved, replaced\)/)
  })
})

describe('the pure stats/findings functions require replacedDayIds', () => {
  it('recalcStats throws on a one-argument call', () => {
    expect(() => recalcStats([])).toThrow(/replacedDayIds/)
  })
  it('recalcFindings throws when ctx has no replacedDayIds', () => {
    expect(() => recalcFindings([], { groups: [], activities: [], days: [] })).toThrow(/replacedDayIds/)
  })
  it('recalcStats hides rows on a replaced day', () => {
    const slots = [
      { day_id: 'd1', is_fixed_event: false, activity_id: 'a' },
      { day_id: 'd2', is_fixed_event: false, activity_id: 'a' },
    ]
    expect(recalcStats(slots, [])).toEqual({ open: 2, filled: 2 })
    expect(recalcStats(slots, ['d2'])).toEqual({ open: 1, filled: 1 })
  })
})
