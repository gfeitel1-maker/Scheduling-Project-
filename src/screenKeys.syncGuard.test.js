// T108 Phase 2 review round 3 (MED — screenKeys.js sync guard).
//
// screenKeys.js is a hand-maintained mirror of App.jsx's SCREENS keys (it
// exists only because App.jsx can't export a non-component value without
// tripping react-refresh/only-export-components). A hand-maintained mirror
// can silently drift from the thing it mirrors — this test makes that
// mechanical, not a matter of diligence, the same "parse the real source,
// don't trust a second hand-written list" idiom this codebase already uses
// for schema.sql (undoReferences.schemaParity.test.js's parseSchemaReferences).
//
// Deliberately a dumb regex over App.jsx's source text, not an import of
// App.jsx itself: importing it would pull in the whole screen component
// tree (every screen, every hook) into a test whose only job is comparing
// two lists of strings — the same "read the DDL text directly" tradeoff
// undoReferences.schemaParity.test.js already made for schema.sql.
import { describe, it, expect } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { SCREEN_KEYS } from './screenKeys.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const appSource = fs.readFileSync(path.join(__dirname, 'App.jsx'), 'utf8')

// Extracts the keys of the `const SCREENS = { ... }` object literal by
// finding its block and reading each `key:` / `'quoted:key':` line, skipping
// comment-only lines. Matches App.jsx's actual formatting (bareword keys
// like `camp:`, quoted keys like `'schedule:manual':`).
function extractScreensKeys(source) {
  const blockMatch = source.match(/const SCREENS = \{([\s\S]*?)\n\}/)
  if (!blockMatch) throw new Error('extractScreensKeys: could not find `const SCREENS = { ... }` in App.jsx — has it moved or been renamed?')
  const body = blockMatch[1]
  const keys = []
  for (const rawLine of body.split('\n')) {
    const line = rawLine.trim()
    if (!line || line.startsWith('//') || line.startsWith('/*') || line.startsWith('*')) continue
    const quoted = line.match(/^'([^']+)':/)
    const bare = line.match(/^([A-Za-z_$][\w$]*):/)
    if (quoted) keys.push(quoted[1])
    else if (bare) keys.push(bare[1])
  }
  return keys
}

describe('screenKeys.js stays in sync with App.jsx SCREENS (mechanical, not hand-diligence)', () => {
  it('SCREEN_KEYS equals the actual SCREENS keys parsed from App.jsx — no drift in either direction', () => {
    const actual = extractScreensKeys(appSource)
    expect(actual.length).toBeGreaterThan(0) // sanity: the parser actually found something
    expect(new Set(actual)).toEqual(SCREEN_KEYS)
  })

  it('the parser itself is proven, not just proven-to-pass-today: catches a planted extra key', () => {
    const planted = extractScreensKeys(appSource.replace(
      'const SCREENS = {',
      "const SCREENS = {\n  plantedGhostKey: PlantedGhostScreen,"
    ))
    expect(planted).toContain('plantedGhostKey')
    expect(new Set(planted)).not.toEqual(SCREEN_KEYS)
  })
})
