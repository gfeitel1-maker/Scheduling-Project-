// Machine-checkable doc-facts (T295).
//
// The staleness class T294 swept up re-drifts the moment code moves ahead of a
// descriptive doc. `checkPlatformStateFreshness` (check-governance.js) can only
// say "possibly behind" from commit dates; it cannot say "this doc states 78 and
// the code says 79." This does — for the specific high-churn facts a doc pins.
//
// Contract: a doc annotates a checkable claim with an explicit anchored marker
//
//     schema **v79** as of this writing <!-- doc-fact:schema_version value=79 -->
//
// The asserted value lives INSIDE the marker, so the surrounding prose stays
// natural ("eight steps") and an incidental number elsewhere on the line is
// never mistaken for the claim. The gate derives the canonical value from source
// — regex/parse of committed files, NO SQLite build and NO Electron, so it runs
// on the portable CI runner — and a mismatch is a BLOCKING finding (a marked
// fact is an exact claim its author placed, not a heuristic guess).

import { readFileSync } from 'node:fs'
import { join } from 'node:path'

/**
 * The registry. Each `derive(read)` returns the canonical value as a STRING, or
 * null when it cannot be read (a null derivation is announced and skips that
 * fact rather than failing the run — the same defensive posture as the
 * entity-sync check). `read(relPath)` returns the committed file's text.
 */
export const DOC_FACTS = {
  schema_version: {
    label: 'CURRENT_SCHEMA_VERSION in electron/db/localDb.js',
    derive: (read) => {
      const m = read('electron/db/localDb.js').match(/CURRENT_SCHEMA_VERSION\s*=\s*(\d+)/)
      return m ? m[1] : null
    },
  },
  verify_step_count: {
    label: 'number of steps in VERIFY_STEPS (scripts/verify.js)',
    derive: (read) => {
      const body = read('scripts/verify.js').match(/VERIFY_STEPS\s*=\s*\[([\s\S]*?)\]/)
      if (!body) return null
      // Count lines that ARE a quoted step literal — not raw quote characters,
      // because interspersed comments carry apostrophes ("step's worst case").
      const n = body[1]
        .split('\n')
        .map((l) => l.trim())
        .filter((l) => /^['"`][\w:.-]+['"`],?$/.test(l)).length
      return n > 0 ? String(n) : null
    },
  },
}

/** Docs scanned for markers. Bounded and explicit — the guard is opt-in per doc. */
export const DOC_FACT_SCAN = [
  'docs/current/PLATFORM_STATE.md',
  'docs/governance/standards/TESTING_STANDARD.md',
]

const MARKER = /<!--\s*doc-fact:([A-Za-z0-9_]+)\s+value=([^\s>]+)\s*-->/g

const finding = (message) => ({ code: 'doc-fact-stale', message })

/**
 * Pure core: scan one doc's text for markers and compare each against the
 * derived values. `derived` maps factName -> canonical string (or null/absent
 * when unreadable). Returns findings (never throws on a bad marker — a malformed
 * or unknown marker is itself a finding, because misuse must not pass silently).
 */
export function scanDocFactsInText(path, text, derived) {
  const findings = []
  const lines = text.split('\n')
  lines.forEach((line, i) => {
    const lineNo = i + 1
    for (const m of line.matchAll(MARKER)) {
      const [, name, asserted] = m
      if (!(name in DOC_FACTS)) {
        findings.push(finding(`${path}:${lineNo} — unknown doc-fact \`${name}\` (not in DOC_FACTS registry)`))
        continue
      }
      const canonical = derived[name]
      if (canonical === null || canonical === undefined) {
        // Derivation could not read its source — announced by checkDocFacts, not
        // silently treated as a match. Skip the comparison for this fact.
        continue
      }
      if (String(asserted) !== String(canonical)) {
        findings.push(finding(
          `${path}:${lineNo} — doc-fact \`${name}\` asserts value=${asserted} but source says ${canonical} ` +
          `(${DOC_FACTS[name].label}). Update the doc and the marker together.`))
      }
    }
  })
  return findings
}

/**
 * Wrapper over the real filesystem. `checkDocFacts(root)` derives every fact
 * once, then scans each DOC_FACT_SCAN doc. A source file that cannot be read
 * yields a null derivation, announced once (never a silent pass).
 */
export function checkDocFacts(root, {
  facts = DOC_FACTS,
  scan = DOC_FACT_SCAN,
  read = (rel) => readFileSync(join(root, rel), 'utf8'),
  warn = (msg) => console.warn(msg),
} = {}) {
  const derived = {}
  for (const [name, def] of Object.entries(facts)) {
    let value = null
    try {
      value = def.derive(read)
    } catch {
      value = null
    }
    if (value === null) warn(`check:governance — doc-fact \`${name}\` skipped (could not derive ${def.label})`)
    derived[name] = value
  }

  const findings = []
  for (const path of scan) {
    let text
    try {
      text = read(path)
    } catch {
      continue // a scanned doc that does not exist is not this check's concern
    }
    findings.push(...scanDocFactsInText(path, text, derived))
  }
  return findings
}
