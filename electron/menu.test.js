import { describe, it, expect, vi } from 'vitest'
import fs from 'node:fs'
import { fileURLToPath } from 'node:url'
import { buildMenuTemplate, installMenu } from './menu.js'

// The hazard this file exists to guard: Shoresh sets no application menu today
// and inherits Electron's default. Menu.setApplicationMenu() REPLACES that
// default wholesale — a template missing a standard role silently destroys
// Cmd+C/Cmd+V/Cmd+Q. This must fail loudly if a future edit trims the template.
//
// This file previously hand-copied the roles it expected into STANDARD_ROLES/
// MAC_ONLY_ROLES arrays — the exact shape of guard that cannot catch what it
// never asserted, and the reason this file shipped missing
// pasteAndMatchStyle/delete/startSpeaking/stopSpeaking/front for a while (see
// memory: plant-the-shape-the-guard-cannot-see). The guard is inverted below:
// the universe of roles comes from Electron's own type definitions
// (`node_modules/electron/electron.d.ts`, pinned to the Electron version this
// app depends on), and every role in that universe must be either present in
// buildMenuTemplate's output or listed in EXCLUDED_ROLES with a reason. A
// future Electron version adding a role therefore shows up here as an
// unexplained gap instead of silent absence.

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

// Parses the `role?: (...)` union(s) out of Electron's own .d.ts — the
// external source of truth for what roles exist — rather than trusting a
// hand-maintained list. electron.d.ts declares this union twice (once for
// BrowserWindow menu items, once for the Dock/tray-adjacent variant); their
// contents differ slightly, so this unions both occurrences. Throws loudly
// if the shape can't be found at all (Electron's type defs moved) rather
// than silently yielding an empty/tiny set that would make every assertion
// below vacuously pass.
function parseElectronRoleUniverse() {
  const dtsPath = fileURLToPath(new URL('../node_modules/electron/electron.d.ts', import.meta.url))
  const source = fs.readFileSync(dtsPath, 'utf8')
  const unionMatches = [...source.matchAll(/role\?:\s*\(([^)]+)\)/g)]
  if (unionMatches.length === 0) {
    throw new Error(
      'menu.test.js: could not find the MenuItemConstructorOptions "role" union in electron.d.ts — ' +
        'Electron\'s type definitions may have changed shape; update parseElectronRoleUniverse().'
    )
  }
  const roles = new Set()
  for (const union of unionMatches) {
    for (const part of union[1].split('|')) {
      const quoted = /^\s*'([^']+)'\s*$/.exec(part)
      if (quoted) roles.add(quoted[1])
    }
  }
  return roles
}

const ROLE_UNIVERSE = parseElectronRoleUniverse()

// Roles Electron defines but Shoresh deliberately does not wire up, each with
// a written reason. A role NOT in this list and NOT implemented in menu.js
// fails the coverage test below.
const EXCLUDED_ROLES = {
  forceReload: 'no separate hard-reload item offered; the "reload" role covers the refresh Shoresh exposes',
  toggleSpellChecker: 'no spellcheck toggle exposed in Shoresh\'s UI',
  window: 'a prebuilt whole-Window-submenu role; Shoresh builds its Window submenu by hand, item by item',
  help: 'Shoresh\'s Help menu uses custom items (GitHub, Report Issue, Licenses, About), not the "help" role placeholder',
  appMenu: 'a prebuilt whole-submenu role; Shoresh builds the app (mac) submenu by hand',
  fileMenu: 'a prebuilt whole-submenu role; Shoresh builds the File submenu by hand',
  editMenu: 'a prebuilt whole-submenu role; Shoresh builds the Edit submenu by hand',
  viewMenu: 'a prebuilt whole-submenu role; Shoresh builds the View submenu by hand',
  windowMenu: 'a prebuilt whole-submenu role; Shoresh builds the Window submenu by hand',
  shareMenu: 'Shoresh has no sharing feature',
  recentDocuments: 'Shoresh is not a document-based app; there is no Recent Documents list',
  clearRecentDocuments: 'depends on recentDocuments, which Shoresh does not use',
  toggleTabBar: 'Shoresh has no window tabs',
  selectNextTab: 'Shoresh has no window tabs',
  selectPreviousTab: 'Shoresh has no window tabs',
  showAllTabs: 'Shoresh has no window tabs',
  mergeAllWindows: 'Shoresh has no window tabs',
  moveTabToNewWindow: 'Shoresh has no window tabs',
  showSubstitutions: 'macOS text-substitution feature not exposed in Shoresh\'s UI',
  toggleSmartQuotes: 'macOS text-substitution feature not exposed in Shoresh\'s UI',
  toggleSmartDashes: 'macOS text-substitution feature not exposed in Shoresh\'s UI',
  toggleTextReplacement: 'macOS text-substitution feature not exposed in Shoresh\'s UI',
}

// mac-only roles: Electron's real default menu includes a Speech submenu
// under Edit, "Bring All to Front" under Window, and the whole "Shoresh" app
// submenu (Services/Hide/Hide Others/Show All) on darwin — none of which
// exist in menu.js's non-mac shape, which uses a plain File menu instead.
const MAC_ONLY_ROLES = new Set(['startSpeaking', 'stopSpeaking', 'front', 'services', 'hide', 'hideOthers', 'unhide'])

describe('Electron role universe (external truth, not hand-copied)', () => {
  it('is parsed from electron.d.ts and is not vacuous', () => {
    // Guards against a parser that silently matches nothing or matches too
    // little — a brittle regex here would make every coverage assertion
    // below pass by finding nothing to check.
    expect(ROLE_UNIVERSE.size).toBeGreaterThanOrEqual(40)
    for (const known of ['undo', 'copy', 'paste', 'quit', 'about', 'front', 'minimize', 'close']) {
      expect(ROLE_UNIVERSE.has(known), `expected known role "${known}" in the parsed universe`).toBe(true)
    }
  })

  it('every EXCLUDED_ROLES entry is still a real Electron role (no stale exclusions)', () => {
    for (const role of Object.keys(EXCLUDED_ROLES)) {
      expect(ROLE_UNIVERSE.has(role), `"${role}" is excluded but not in the parsed universe — stale entry?`).toBe(
        true
      )
    }
  })
})

describe('buildMenuTemplate', () => {
  for (const isMac of [true, false]) {
    describe(isMac ? 'mac shape' : 'non-mac shape', () => {
      it('covers the full Electron role universe minus the documented exclusions', () => {
        const template = buildMenuTemplate({ isMac, onShowLicenses: () => {} })
        const roles = new Set(collectRoles(template))
        for (const role of ROLE_UNIVERSE) {
          if (role in EXCLUDED_ROLES) continue
          if (MAC_ONLY_ROLES.has(role) && !isMac) continue
          expect(roles, `missing role "${role}" — add it to menu.js, or to EXCLUDED_ROLES with a reason`).toContain(
            role
          )
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
