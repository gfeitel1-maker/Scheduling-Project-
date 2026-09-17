import { describe, it, expect, vi } from 'vitest'
import fs from 'node:fs'
import { buildMenuTemplate, installMenu } from './menu.js'

// The hazard this file exists to guard: Shoresh sets no application menu today
// and inherits Electron's default. Menu.setApplicationMenu() REPLACES that
// default wholesale — a template missing a standard role silently destroys
// Cmd+C/Cmd+V/Cmd+Q. This must fail loudly if a future edit trims the template.

function collectRoles(template) {
  const roles = []
  for (const item of template) {
    if (item.role) roles.push(item.role)
    if (Array.isArray(item.submenu)) roles.push(...collectRoles(item.submenu))
  }
  return roles
}

function findByLabel(template, label) {
  for (const item of template) {
    if (item.label === label) return item
    if (Array.isArray(item.submenu)) {
      const found = findByLabel(item.submenu, label)
      if (found) return found
    }
  }
  return null
}

const STANDARD_ROLES = [
  'undo',
  'redo',
  'cut',
  'copy',
  'paste',
  'pasteAndMatchStyle',
  'delete',
  'selectAll',
  'minimize',
  'close',
  'quit',
]

// mac-only roles: Electron's real default menu includes a Speech submenu
// under Edit and "Bring All to Front" under Window on darwin, neither of
// which exists on other platforms' default menus.
const MAC_ONLY_ROLES = ['startSpeaking', 'stopSpeaking', 'front']

describe('buildMenuTemplate', () => {
  for (const isMac of [true, false]) {
    describe(isMac ? 'mac shape' : 'non-mac shape', () => {
      it('preserves every standard editing/window role', () => {
        const template = buildMenuTemplate({ isMac, onShowLicenses: () => {} })
        const roles = collectRoles(template)
        for (const role of STANDARD_ROLES) {
          expect(roles, `missing role "${role}"`).toContain(role)
        }
      })

      if (isMac) {
        it('includes the mac-only Speech submenu and "Bring All to Front"', () => {
          const template = buildMenuTemplate({ isMac, onShowLicenses: () => {} })
          const roles = collectRoles(template)
          for (const role of MAC_ONLY_ROLES) {
            expect(roles, `missing mac-only role "${role}"`).toContain(role)
          }
        })
      }

      it('includes About Shoresh with role "about"', () => {
        const template = buildMenuTemplate({ isMac, onShowLicenses: () => {} })
        const about = findByLabel(template, 'About Shoresh')
        expect(about).toBeTruthy()
        expect(about.role).toBe('about')
      })

      it('wires the Licenses item to onShowLicenses', () => {
        const onShowLicenses = vi.fn()
        const template = buildMenuTemplate({ isMac, onShowLicenses })
        const licenses = findByLabel(template, 'Licenses')
        expect(licenses).toBeTruthy()
        expect(onShowLicenses).not.toHaveBeenCalled()
        licenses.click()
        expect(onShowLicenses).toHaveBeenCalledTimes(1)
      })
    })
  }

  it('places About and Licenses under the app menu on mac (not Help)', () => {
    const template = buildMenuTemplate({ isMac: true, onShowLicenses: () => {} })
    const appMenu = template.find((m) => m.label === 'Shoresh')
    expect(appMenu.submenu.some((i) => i.label === 'About Shoresh')).toBe(true)
    expect(appMenu.submenu.some((i) => i.label === 'Licenses')).toBe(true)
    const helpMenu = template.find((m) => m.label === 'Help')
    expect(helpMenu.submenu.some((i) => i.label === 'About Shoresh')).toBe(false)
  })

  it('moves About and Licenses into Help, and Quit into File, on non-mac', () => {
    const template = buildMenuTemplate({ isMac: false, onShowLicenses: () => {} })
    const helpMenu = template.find((m) => m.label === 'Help')
    expect(helpMenu.submenu.some((i) => i.label === 'About Shoresh')).toBe(true)
    expect(helpMenu.submenu.some((i) => i.label === 'Licenses')).toBe(true)
    const fileMenu = template.find((m) => m.label === 'File')
    expect(fileMenu).toBeTruthy()
    expect(fileMenu.submenu.some((i) => i.role === 'quit')).toBe(true)
    expect(template.find((m) => m.label === 'Shoresh')).toBeUndefined()
  })

  it('wires optional Help links without requiring them', () => {
    const template = buildMenuTemplate({ isMac: true, onShowLicenses: () => {} })
    const helpMenu = template.find((m) => m.label === 'Help')
    expect(helpMenu.submenu.length).toBeGreaterThan(0)
    // No callback supplied — clicking must not throw.
    for (const item of helpMenu.submenu) {
      if (typeof item.click === 'function') expect(() => item.click()).not.toThrow()
    }
  })

  it('does not import electron at the top level — loads with zero Electron runtime', () => {
    // A real (not mocked) assertion on the source itself: `import ... from
    // 'electron'`/`require('electron')` anywhere before installMenu's own
    // Electron-touching code would defeat the whole point of this module
    // being loadable under Vitest without a live Electron runtime.
    const source = fs.readFileSync(new URL('./menu.js', import.meta.url), 'utf8')
    expect(source).not.toMatch(/(?:^|\n)\s*import\s[^\n]*['"]electron['"]/)
    expect(source).not.toMatch(/require\(\s*['"]electron['"]\s*\)/)
  })
})

describe('installMenu', () => {
  it('builds from the template and installs it via the injected Menu', () => {
    const built = { fake: 'menu' }
    const Menu = {
      buildFromTemplate: vi.fn(() => built),
      setApplicationMenu: vi.fn(),
    }
    const result = installMenu({ Menu, isMac: true, onShowLicenses: () => {} })
    expect(Menu.buildFromTemplate).toHaveBeenCalledTimes(1)
    expect(Menu.setApplicationMenu).toHaveBeenCalledWith(built)
    expect(result).toBe(built)
  })
})
