import { normalizeName } from './preview.js'

// "Lunch 3" -> "lunch". Only a trailing whitespace-separated number is a numbering; "Lunch2" and
// "Group 2A" are not (docs/adr/2026-10-11-import-answer-memory.md 3.4). One definition, shared by
// fixed-event detection and answer-pattern induction.
export function numberedBase(name) {
  const m = String(name).match(/^(.*\S)\s+\d+$/)
  return m ? normalizeName(m[1]) : null
}

// A stem that is under 3 characters, or still holds a digit, forms no pattern: failing toward asking.
export function stemOf(name) {
  const base = numberedBase(name)
  if (!base || base.length < 3 || /\d/.test(base)) return null
  return base
}

// Anchored whole-name meal test ("Snack Shack" and "Dinner Dance" are not meals): one definition,
// owned by eventKeptWhenUnanswered.js and re-exported here for the answer-pattern code.
export { isMealName } from './eventKeptWhenUnanswered.js'
