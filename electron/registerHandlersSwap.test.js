// @vitest-environment node
//
// A db swap (Restore from backup, project switch) calls registerHandlers() again, and Electron's
// ipcMain.handle THROWS if a channel is still registered. Removal used to iterate a hand-kept list of
// channels that had drifted: 38 channels registered in registerHandlers were missing from it, so the
// first swap threw ("Attempted to register a second handler for 'shoresh:last-import-undo'") halfway
// through, and the app was left unable to start until restarted (final candidate 2f4f16c, audit step 17).
//
// registerHandlers lives inside main()'s closure, so this reads its source: every registration in it
// must go through the local handle() that removes the channel first, and that wrapper must exist.
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import path from 'node:path'

const MAIN = readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), 'main.js'), 'utf8')

function registerHandlersBody() {
  const start = MAIN.indexOf('function registerHandlers(')
  if (start < 0) throw new Error('registerHandlers not found in electron/main.js')
  const open = MAIN.indexOf('{', start)
  let depth = 0
  for (let i = open; i < MAIN.length; i++) {
    if (MAIN[i] === '{') depth++
    else if (MAIN[i] === '}' && --depth === 0) return MAIN.slice(open, i + 1)
  }
  throw new Error('registerHandlers has no closing brace')
}

describe('a db swap re-registers every IPC handler without throwing', () => {
  const body = registerHandlersBody()

  it('registers at least the known channels (non-vacuity: the body was found and is the real one)', () => {
    for (const ch of ['shoresh:login', 'shoresh:last-import-undo', 'shoresh:ingest-undo', 'shoresh:get-camp']) {
      expect(body).toContain(`'${ch}'`)
    }
  })

  it('every channel registered in registerHandlers is removed just before it is registered', () => {
    // Any raw ipcMain.handle with a literal channel, on one line or several (the wrapper's own call takes `ch`).
    const raw = [...body.matchAll(/ipcMain\.handle\(\s*(['"`])([^'"`]+)\1/g)].map((m) => m[2])
    expect(raw, 'raw ipcMain.handle calls inside registerHandlers (each must go through handle(), which removes first)').toEqual([])
  })

  it('the local handle() removes the channel before registering it', () => {
    expect(body).toMatch(/const handle = \(ch, fn\) => \{\s*ipcMain\.removeHandler\(ch\);?\s*ipcMain\.handle\(ch, fn\)/)
  })
})
