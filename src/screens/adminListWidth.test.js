import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

// Design F6: the three admin lists share the setup width constant instead of
// 560/760/860/900 picked per screen.
const SCREENS = ['ConflictsScreen.jsx', 'TrashScreen.jsx', 'DeviceManagerScreen.jsx']

describe.each(SCREENS)('%s page width', file => {
  const src = readFileSync(resolve('src/screens', file), 'utf8')
  it('uses SETUP_MAX_WIDTH for the page container', () => {
    expect(src).toMatch(/import \{[^}]*SETUP_MAX_WIDTH[^}]*\} from '\.\.\/components\/setup\/SetupScreenShell'/)
    expect(src).toMatch(/maxWidth: SETUP_MAX_WIDTH/)
  })
  it('has no per-screen page width literal left', () => {
    expect(src).not.toMatch(/maxWidth: (760|860|900)\b/)
  })
})
