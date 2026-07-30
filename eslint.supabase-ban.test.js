import { describe, it, expect, afterEach, beforeAll } from 'vitest'
import { ESLint } from 'eslint'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

// Proves the no-restricted-imports rule added to eslint.config.js (Phase 1, Task 3)
// actually fires on a fresh @supabase/supabase-js import under src/ or electron/,
// and stays clean on the real post-migration tree. See legacy/supabase/README.md.
//
// These tests spawn a real ESLint instance and lint the tree, which is slow and
// contends with other workers under `npm run test`'s parallel execution — this is
// redundant with the repo's own `npm run lint`, so we reuse a single shared ESLint
// instance across the file's tests and give the full-tree tests generous timeouts
// to avoid flaking under CPU starvation rather than re-linting per test.

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

  it('does not flag any real file under src/ or electron/ for a Supabase import', async () => {
    const results = await eslint.lintFiles(['src/**/*.{js,jsx}', 'electron/**/*.js'])
    const restrictedImportHits = results
      .flatMap((r) => r.messages.map((m) => ({ file: r.filePath, ...m })))
      .filter((m) => m.ruleId === 'no-restricted-imports')

    expect(restrictedImportHits).toEqual([])
    // 240s, not 60s. This lints the whole project through ESLint's API and
    // takes ~55s on an idle machine — inside a 60s budget only just, and over it
    // whenever anything else is running (a dev server, a packaged app, another
    // suite). It failed exactly that way on 2026-07-29 with the dev app up.
    // The generous budget is the fix for a genuinely slow test, not cover for a
    // slow one that should be fast: it walks every file on purpose.
  }, 240000)

  it('does not flag legacy/supabase/ (excluded from the rule by scope)', async () => {
    const results = await eslint.lintFiles(['legacy/supabase/**/*.js'])
    const restrictedImportHits = results
      .flatMap((r) => r.messages.map((m) => ({ file: r.filePath, ...m })))
      .filter((m) => m.ruleId === 'no-restricted-imports')

    expect(restrictedImportHits).toEqual([])
  }, 30000)
})
