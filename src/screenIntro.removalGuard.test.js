// Roots-as-hub setup IA, Slice A (docs/adr/2026-08-22-roots-as-hub-setup-ia.md
// §Decision 5): the SCREEN_INTRO explainer system was removed deliberately —
// a top-of-screen explainer is evidence a screen isn't self-evident, not a
// feature. This test keeps it from creeping back in, the same "mechanical,
// not hand-diligence" idiom as screenKeys.syncGuard.test.js.
import { describe, it, expect } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const srcRoot = __dirname

function walk(dir, files = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) walk(full, files)
    else if (/\.(jsx?|tsx?)$/.test(entry.name)) files.push(full)
  }
  return files
}

describe('SCREEN_INTRO explainer system stays removed', () => {
  it('src/components/ScreenIntro.jsx and screenIntroText.js no longer exist', () => {
    expect(fs.existsSync(path.join(srcRoot, 'components/ScreenIntro.jsx'))).toBe(false)
    expect(fs.existsSync(path.join(srcRoot, 'components/screenIntroText.js'))).toBe(false)
  })

  it('no source file imports or renders ScreenIntro / SCREEN_INTRO', () => {
    const offenders = []
    for (const file of walk(srcRoot)) {
      if (file === path.join(srcRoot, 'screenIntro.removalGuard.test.js')) continue
      const contents = fs.readFileSync(file, 'utf8')
      if (/\bScreenIntro\b|\bSCREEN_INTRO\b/.test(contents)) offenders.push(file)
    }
    expect(offenders).toEqual([])
  })
})
