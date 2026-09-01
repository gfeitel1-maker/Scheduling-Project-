import { describe, it, expect } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

// GUARDRAIL — Product Premise §3 ("Explain the software, not the camp").
//
// Findings and flags render in the FindingsRail. They may state what the
// SOFTWARE established — a constraint, a count, a capacity, a goal not met:
//   "Pool is occupied by Lunch at this time"
//   "Goal: 3×/wk — scheduled 1×"
// They must NEVER cross into judgement about the camp:
//   "this is a worse choice", "you should move this group", "a poor arrangement".
// Mechanism and fact belong to the software; merit belongs to the director.
//
// This test scans every place a finding/flag message string is authored and
// fails if any of them contains evaluative / advisory language. It is a source
// scanner (not a behavioural test) so a message is caught even if no scenario
// happens to trigger it — including a brand-new finding kind added later.
//
// If this fails: reword the message to describe the mechanical fact only. If a
// banned word is genuinely mechanical in some future context (unlikely), narrow
// the list here deliberately — do not delete the guardrail to clear a finding.

const here = path.dirname(fileURLToPath(import.meta.url))
const root = path.resolve(here, '..', '..')

// Every module that authors user-facing finding/flag text.
const SOURCES = [
  'src/engine/buildSchedule.js',
  'src/utils/computeOverlaps.js',
  'src/utils/computeWeekClosures.js',
  'src/components/schedule/slotCellConstants.js',
]

// String literals that reach the user: reason messages and flag labels.
const MESSAGE_PATTERNS = [
  /(?:UNFILLABLE_reason|WEEK_CLOSED_reason|reason)\s*[:=]\s*(`[^`]*`|'[^']*'|"[^"]*")/g,
  /reasons?\.push\(\s*(`[^`]*`|'[^']*'|"[^"]*")/g,
  /\blabel:\s*('[^']*'|"[^"]*")/g,
]

// Advisory / evaluative vocabulary — the software offering an opinion about the
// camp rather than reporting a fact. Whole-word, case-insensitive.
const BANNED = /\b(better|worse|best|worst|bad|badly|poor|poorly|sub-?optimal|optimal|should|shouldn't|ought|recommend(?:ed|ation)?|prefer(?:red|able|ably)?|wrong|mistake|improve(?:ment)?|ideal|unwise|avoid)\b/i

function collectMessages() {
  const found = []
  for (const rel of SOURCES) {
    const src = fs.readFileSync(path.join(root, rel), 'utf8')
    for (const pat of MESSAGE_PATTERNS) {
      pat.lastIndex = 0
      let m
      while ((m = pat.exec(src)) !== null) {
        // Strip the surrounding quotes/backticks and any ${…} interpolations.
        const text = m[1].slice(1, -1).replace(/\$\{[^}]*\}/g, '')
        found.push({ file: rel, text })
      }
    }
  }
  return found
}

describe('findings/flags language (Premise §3 guardrail)', () => {
  const messages = collectMessages()

  it('actually finds the message strings (guards against a broken scan quietly passing)', () => {
    // ~20 messages exist today; a scan that collects almost nothing is broken,
    // not clean. This tripwire makes an extraction regression fail loudly.
    expect(messages.length).toBeGreaterThanOrEqual(10)
  })

  it('no finding or flag message uses evaluative / advisory language', () => {
    const offenders = messages
      .filter(({ text }) => BANNED.test(text))
      .map(({ file, text }) => `${file}: "${text.trim()}"`)
    expect(offenders, `Finding/flag text must state mechanism, never merit (Premise §3):\n${offenders.join('\n')}`).toEqual([])
  })
})
