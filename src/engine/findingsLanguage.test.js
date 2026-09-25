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

// Every module that authors user-facing finding/flag text. There is no clean
// mechanical discriminator between finding text and other quoted UI copy: the
// message patterns below also match ~36 non-test src files authoring nav
// labels, CRUD form labels, and ingest/reconciliation copy that are NOT
// FindingsRail text — and a real finding source (computeOverlaps.js) doesn't
// even match the reason-family patterns. So this list is curated by hand, and
// the omission test below (not this list) is what makes a new, unregistered
// finding-text home fail loudly instead of silently escaping (T254).
const FINDING_TEXT_SOURCES = [
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
  for (const rel of FINDING_TEXT_SOURCES) {
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

// OMISSION GUARD — makes coverage shrinkage loud instead of silent (T254).
//
// New finding text realistically arrives as a reason/message string (the
// motivating case: a new director-facing state added outside the four files
// above), not as a brand-new flag-label constants file — so this scans only
// the reason-family patterns (UNFILLABLE_reason / WEEK_CLOSED_reason / reason
// / reasons.push), not the generic `label:` pattern, which would sweep in
// unrelated nav/CRUD/form labels across the app. Every non-test src file
// matching a reason-family pattern must be named in FINDING_TEXT_SOURCES
// (and therefore scanned above) or in NON_FINDING_MESSAGE_FILES below
// (curated by hand from the actual current matches — confirmed non-finding
// copy). A file in neither list fails this test.
const REASON_FAMILY_PATTERNS = [
  /(?:UNFILLABLE_reason|WEEK_CLOSED_reason|reason)\s*[:=]\s*(`[^`]*`|'[^']*'|"[^"]*")/g,
  /reasons?\.push\(\s*(`[^`]*`|'[^']*'|"[^"]*")/g,
]

// Confirmed non-finding copy (ingest/reconciliation/CRUD messages), curated
// from the actual matches of REASON_FAMILY_PATTERNS against src/ today.
//
// KNOWN RESIDUAL LIMITATION: the omission guard below forces a new
// reason-family file into one of the two lists above, but a developer could
// still misclassify genuine finding text into NON_FINDING_MESSAGE_FILES —
// which the banned-word scan (collectMessages, FINDING_TEXT_SOURCES only)
// would then never see. We deliberately do NOT run the banned scan over
// NON_FINDING_MESSAGE_FILES: that copy (ingest/reconciliation, e.g.
// "prefer"/"avoid") legitimately uses merit language, because Premise §3
// governs FindingsRail text only — scanning it would contradict the rule's
// own scope. This residual requires a deliberate miscategorization, which is
// strictly better than the prior failure mode (silent, zero-action shrink),
// and is accepted.
const NON_FINDING_MESSAGE_FILES = [
  'src/data/setupCrudRepository.js',
  'src/engine/weekCatalog.js',
  'src/ingest/buildPlan.js',
  'src/ingest/electiveSetPopulate.js',
  'src/ingest/eventGridPopulate.js',
  'src/ingest/fieldUpdate.js',
  'src/ingest/parseGridSchedule.js',
  'src/ingest/preferenceSheet.js',
  'src/ingest/reconciliationReport.js',
  'src/ingest/salience.js',
  'src/ingest/suspectRecords.js',
  'src/ingest/workbookToSource.js',
  'src/screens/reconciliationResolutions.js',
  'src/screens/reconciliationTriage.js',
  'src/localClient.mock.js',
]

function listSrcFiles(dir) {
  const out = []
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) {
      out.push(...listSrcFiles(full))
    } else if (/\.jsx?$/.test(entry.name) && !/\.test\.jsx?$/.test(entry.name)) {
      out.push(path.relative(root, full))
    }
  }
  return out
}

function findUnregisteredReasonFamilyFiles() {
  const registered = new Set([...FINDING_TEXT_SOURCES, ...NON_FINDING_MESSAGE_FILES])
  const offenders = []
  for (const rel of listSrcFiles(path.join(root, 'src'))) {
    if (registered.has(rel)) continue
    const src = fs.readFileSync(path.join(root, rel), 'utf8')
    const matches = REASON_FAMILY_PATTERNS.some((pat) => {
      pat.lastIndex = 0
      return pat.test(src)
    })
    if (matches) offenders.push(rel)
  }
  return offenders
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

  it('every reason-family message source is registered (guards against a new, unscanned finding-text home)', () => {
    const offenders = findUnregisteredReasonFamilyFiles()
    expect(
      offenders,
      `File(s) author reason/reasons.push text but are in neither FINDING_TEXT_SOURCES nor NON_FINDING_MESSAGE_FILES:\n${offenders.join('\n')}\nIf this is new finding text, add it to FINDING_TEXT_SOURCES. If it is confirmed non-finding copy, add it to NON_FINDING_MESSAGE_FILES.`
    ).toEqual([])
  })

  it('the guard is non-vacuous — a banned word in a new, unregistered finding-text home is caught', () => {
    // Deliberately at the top level of src/, NOT in src/engine/: the fixture
    // exists only while this test runs, and fixtureSchemaParity.test.js
    // AST-parses every non-test .js in src/engine/, so a transient file there
    // could be parsed by it under the full suite's cross-file parallelism.
    const fixture = path.join(root, 'src/__t254_nonvacuity_fixture.js')
    const fixtureRel = path.relative(root, fixture)
    const contents = "export const f = { reason: 'you should improve this arrangement' }\n"
    try {
      fs.writeFileSync(fixture, contents)

      // Half 1: the omission guard fires on a home the current lists don't name.
      expect(findUnregisteredReasonFamilyFiles()).toContain(fixtureRel)

      // Half 2: once such a file is registered, the banned scan WOULD catch
      // its merit language — proves collectMessages/BANNED aren't vacuous.
      const extracted = []
      for (const pat of MESSAGE_PATTERNS) {
        pat.lastIndex = 0
        let m
        while ((m = pat.exec(contents)) !== null) {
          extracted.push(m[1].slice(1, -1))
        }
      }
      expect(extracted.some((text) => BANNED.test(text))).toBe(true)
    } finally {
      fs.rmSync(fixture, { force: true })
    }
    expect(fs.existsSync(fixture)).toBe(false)
  })
})
