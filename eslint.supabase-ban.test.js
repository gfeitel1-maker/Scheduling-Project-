import { describe, it, expect, afterEach, beforeAll } from 'vitest'
import { ESLint } from 'eslint'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

// Proves the no-restricted-imports rule added to eslint.config.js (Phase 1, Task 3)
// actually FIRES on a fresh @supabase/supabase-js import under src/ or electron/,
// and that legacy/supabase/ stays exempt. See legacy/supabase/README.md.
//
// "and stays clean on the real post-migration tree" used to be the third claim on
// this line. It is no longer this file's job — see below.
//
// WHAT THIS FILE DOES NOT DO, and why that is deliberate (T188, 2026-09-16).
//
// It does NOT lint the whole tree looking for real violations. `npm run lint`
// (`eslint .`) already runs this exact config, with this exact rule at `error`,
// over a superset of these paths, and it runs BEFORE `test` in VERIFY_STEPS. So a
// real violation fails the gate there first, and a second full-tree ESLint pass
// inside the suite could only ever agree with it.
//
// (An earlier draft of this comment said "step 1 of VERIFY_STEPS". That was wrong
// — the list was reordered cheapest-first in this same branch and lint is 5th of
// six. Only "before `test`" was ever load-bearing, and that is what is claimed
// now. Flagged by both reviewers; recorded because a gate-ordering comment that
// is casually wrong is how the next reader inherits a false guarantee.)
//
// That second pass used to live here and cost 136.1s — 10.3% of ALL test
// file-time, the single most expensive file in the suite. It was removed after
// the subsumption claim was proven by experiment rather than argued: a
// `@supabase/supabase-js` import was planted in BOTH `src/` and `electron/`, and
// `eslint .` reported both as `no-restricted-imports` errors (2 errors, non-zero
// exit). No file-set asymmetry exists between the two — there are no dotfiles or
// dot-directories under either path for ESLint's directory walk to skip, and flat
// config does not read `.gitignore`.
//
// WHAT CAME BACK, and why. Red Hat's review made a point the "strictly weaker"
// argument had missed: the deleted test scanned the real tree FROM INSIDE THE TEST
// RUN, so it held even for someone running `npm test` alone and never invoking
// `npm run lint` — two disjoint scripts. "Strictly weaker" was true of a full gate
// invocation and NOT true of `npm test` on its own, which this repo's own CLAUDE.md
// documents as a supported workflow.
//
// So the tree scan is restored below — as a grep, not as a second ESLint run. It
// reads the same file set and answers the same question ("does any real file under
// src/ or electron/ import @supabase?") in milliseconds instead of 136 seconds. It
// is deliberately dumber than ESLint: it cannot resolve aliases or re-exports, and
// it is not trying to. ESLint remains the authority via `npm run lint`; this is
// defense-in-depth that costs nothing.
//
// What stays here is also the part `npm run lint` genuinely cannot prove: that the
// rule FIRES AT ALL. A config edit that silently stopped applying the rule would
// leave `eslint .` passing a clean tree forever, and nothing would notice. The
// probe test below plants a violation and asserts it is caught — that is this
// file's whole remaining job, and it is a non-vacuity guard, not a lint pass.
// The `legacy/supabase/` test pins the scope exemption for the same reason.
//
// If you are tempted to re-add a full-tree pass here: measure `npm run lint`
// first and say what it misses.

const ROOT_DIR = path.dirname(fileURLToPath(import.meta.url))
const PROBE_PATH = path.resolve(ROOT_DIR, 'src/__supabase_ban_probe.js')

let eslint

beforeAll(() => {
  eslint = new ESLint({ cwd: ROOT_DIR })
})

afterEach(() => {
  if (fs.existsSync(PROBE_PATH)) fs.rmSync(PROBE_PATH)
})

describe('eslint: active Supabase imports are banned', () => {
  it('fails on a fresh @supabase/supabase-js import under src/', async () => {
    fs.writeFileSync(
      PROBE_PATH,
      "import { createClient } from '@supabase/supabase-js'\nexport const client = createClient('a', 'b')\n"
    )

    const results = await eslint.lintFiles([PROBE_PATH])
    const messages = results.flatMap((r) => r.messages)

    expect(results[0].errorCount).toBeGreaterThan(0)
    expect(messages.some((m) => m.ruleId === 'no-restricted-imports')).toBe(true)
  }, 30000)

  it('no real file under src/ or electron/ imports @supabase (grep, not ESLint)', () => {
    // Deliberately NOT `eslint.lintFiles(...)` — that was the 136s pass this file
    // stopped doing. Same question, same file set, ~1000x cheaper.
    const SUPABASE_IMPORT = /(?:from\s*|require\(\s*|import\(\s*)['"]@supabase\//
    const hits = []
    const walk = (dir) => {
      for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, e.name)
        if (e.isDirectory()) { walk(full); continue }
        if (!/\.jsx?$/.test(e.name)) continue
        if (full === PROBE_PATH) continue // this file's own probe, written by the test above
        if (SUPABASE_IMPORT.test(fs.readFileSync(full, 'utf8'))) hits.push(full)
      }
    }
    walk(path.join(ROOT_DIR, 'src'))
    walk(path.join(ROOT_DIR, 'electron'))

    expect(hits).toEqual([])
  })

  it('does not flag legacy/supabase/ (excluded from the rule by scope)', async () => {
    const results = await eslint.lintFiles(['legacy/supabase/**/*.js'])
    const restrictedImportHits = results
      .flatMap((r) => r.messages.map((m) => ({ file: r.filePath, ...m })))
      .filter((m) => m.ruleId === 'no-restricted-imports')

    expect(restrictedImportHits).toEqual([])
  }, 30000)
})
