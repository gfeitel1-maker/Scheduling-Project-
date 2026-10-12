// @vitest-environment node
//
// Owner, 2026-10-12: "all times need the am pm fix". Every time a director sees reads as 12-hour
// AM/PM, through the shared formatters in src/utils/timeBlockLabel.js (blockDisplayName,
// timeRangeLabel, formatTime12, formatClock12). This guard scans src/ for the three ways a 24-hour
// "13:35" has reached the screen, so a new screen cannot bring one back:
//   1. a time block's NAME shown raw: an imported block is named after its own printed times
//      ("13:35-14:15"), so a name must go through blockDisplayName;
//   2. a raw start_time / end_time interpolated into copy;
//   3. a Date rendered with toLocaleString / toLocaleTimeString without hour12: true (the
//      browser's locale may be 24-hour).
// It scans source text, so it sees only these shapes; a display it cannot recognise is caught by
// review, not here.
import { describe, it, expect } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'

const ROOT = path.join(process.cwd(), 'src')
// Code that uses a block name as a KEY (matching an import file's text), not as display.
const ALLOW = new Set(['utils/timeBlockLabel.js', 'localClient.mock.js'])
const isKeyOnly = (rel) => rel.startsWith('ingest/')

function sourceFiles(dir) {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const p = path.join(dir, e.name)
    if (e.isDirectory()) return e.name === 'assets' ? [] : sourceFiles(p)
    return /\.(js|jsx)$/.test(e.name) && !/\.test\.(js|jsx)$/.test(e.name) ? [p] : []
  })
}

const RULES = [
  { why: 'time block name shown raw (use blockDisplayName)', re: /\b(timeBlocks|blocks)\.find\(.*\)\??\.name\b|\.map\(\(?b\)? => b\.name\)|timeBlocks\.map\(\(?(\w+)\)? => \[\2\.id, \2\.name|\{block\.name\}|\bblock\?\.name\b|blockName: b\.name\b/ },
  { why: 'raw start_time/end_time in copy (use timeRangeLabel / formatTime12)', re: /\$\{[^}]*\.(start_time|end_time)\}|>\{[^}]*\.(start_time|end_time)\}</ },
  { why: 'locale time without hour12: true (use formatClock12)', re: /(new Date\([^)]*\)|\b(d|date|asOf|when|dt)\b)\.toLocale(Time)?String\(/, unlessNear: /hour12:\s*true/ },
]

export function findTimeDisplayViolations(files = sourceFiles(ROOT)) {
  const out = []
  for (const file of files) {
    const rel = path.relative(ROOT, file).split(path.sep).join('/')
    if (ALLOW.has(rel) || isKeyOnly(rel)) continue
    const lines = fs.readFileSync(file, 'utf8').split('\n')
    lines.forEach((line, i) => {
      if (/^\s*(\/\/|\*)/.test(line) || /time-guard: key/.test(line)) return
      for (const rule of RULES) {
        if (!rule.re.test(line)) continue
        if (rule.unlessNear && rule.unlessNear.test(lines.slice(i, i + 8).join('\n'))) continue
        out.push(`${rel}:${i + 1} ${rule.why}`)
      }
    })
  }
  return out
}

describe('every time a director sees is 12-hour AM/PM', () => {
  it('no source file shows a block name, a stored time or a Date in 24-hour form', () => {
    expect(findTimeDisplayViolations()).toEqual([])
  })

  it('catches a planted violation of each kind (so a pass is not vacuous)', () => {
    const dir = fs.mkdtempSync(path.join(ROOT, '..', 'node_modules', '.time-guard-'))
    try {
      const planted = path.join(dir, 'Planted.jsx')
      fs.writeFileSync(planted, [
        "const a = timeBlocks.find((b) => b.id === id)?.name",
        "const s = `starts ${block.start_time}`",
        "const t = new Date(x).toLocaleTimeString()",
      ].join('\n'))
      const hits = findTimeDisplayViolations([planted]).map((h) => h.split(' ').slice(1).join(' '))
      expect(hits).toEqual([
        'time block name shown raw (use blockDisplayName)',
        'raw start_time/end_time in copy (use timeRangeLabel / formatTime12)',
        'locale time without hour12: true (use formatClock12)',
      ])
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })
})
