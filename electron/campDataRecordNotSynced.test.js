// T292 guard — the camp data workbook is a LOCAL artifact and must never enter
// Shoresh's replication surface.
//
// The owner's requirement: the PII rendered into `<Documents>/Shoresh/<camp>
// data.xlsx` must never ride Shoresh's own transport — not the libp2p LAN sync,
// not a hole-punched connection, not a relay. (OS-level cloud sync of the folder,
// e.g. an org's OneDrive, is explicitly the org's concern, not this app's.)
//
// This is true today only BY CONSTRUCTION: the file is written by
// electron/campDataRecord.js (imported solely by main.js), from the device's own
// SQLite projection, to a directory that is disjoint from the replicated
// `<userData>/automerge` tree; nothing reads it back and no sync/automerge module
// references it. Nothing but discipline keeps it that way — so this test turns
// "verified once" into an enforced invariant. If a future change wires the writer
// or the builder into the sync layer, points its output at the replicated data
// dir, or gives it a second consumer, one of these assertions goes red.
//
// Scanned as source specifiers (import/require forms only), never a bare
// substring, so a comment mentioning the module does not false-red — matching the
// precedent in electron/mainSyncStartupWiring.test.js.

import { describe, it, expect } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ELECTRON_DIR = path.dirname(fileURLToPath(import.meta.url))
const REPO_ROOT = path.resolve(ELECTRON_DIR, '..')

/** Every non-test .js under a set of dirs, repo-root-relative, sorted. */
function jsFilesUnder(...relDirs) {
  const out = []
  for (const rel of relDirs) {
    const root = path.join(REPO_ROOT, rel)
    if (!fs.existsSync(root)) continue
    for (const entry of fs.readdirSync(root, { recursive: true })) {
      const p = String(entry)
      if (!p.endsWith('.js') || p.endsWith('.test.js')) continue
      out.push(path.relative(REPO_ROOT, path.join(root, p)))
    }
  }
  return out.sort()
}

/** Module specifiers this file import/requires (not comments, not strings). */
function importSpecifiers(absPath) {
  const src = fs.readFileSync(absPath, 'utf8')
  const specs = []
  const importRe = /\bimport\b[^;'"]*?\bfrom\s*['"]([^'"]+)['"]/g
  const bareImportRe = /\bimport\s*['"]([^'"]+)['"]/g
  const requireRe = /\brequire\s*\(\s*['"]([^'"]+)['"]\s*\)/g
  for (const re of [importRe, bareImportRe, requireRe]) {
    let m
    while ((m = re.exec(src)) !== null) specs.push(m[1])
  }
  return specs
}

const NAMES = ['campDataRecord', 'buildCampDataWorkbook']
const specMentions = (spec) => NAMES.some((n) => spec.includes(n))

describe('T292: the camp data workbook never enters the replication surface', () => {
  it('no electron/sync/** or electron/automerge/** module imports the writer or the builder', () => {
    const syncFiles = jsFilesUnder('electron/sync', 'electron/automerge')
    // Non-vacuity: if the scan finds nothing, the assertion below is meaningless.
    expect(syncFiles.length).toBeGreaterThan(20)

    const offenders = []
    for (const rel of syncFiles) {
      const specs = importSpecifiers(path.join(REPO_ROOT, rel))
      if (specs.some(specMentions)) offenders.push(rel)
    }
    expect(offenders).toEqual([])
  })

  it('the writer and builder each have exactly one importer — the write-only local chain, no sync consumer', () => {
    const all = jsFilesUnder('electron', 'src')
    const importers = { campDataRecord: [], buildCampDataWorkbook: [] }
    for (const rel of all) {
      for (const spec of importSpecifiers(path.join(REPO_ROOT, rel))) {
        for (const name of NAMES) {
          if (spec.includes(name) && !importers[name].includes(rel)) importers[name].push(rel)
        }
      }
    }
    // createCampDataRecordWriter is used only by the main process; the builder
    // only by the writer. A new edge here — especially from the sync layer —
    // must be a deliberate, reviewed change, not a silent one.
    expect(importers.campDataRecord).toEqual(['electron/main.js'])
    expect(importers.buildCampDataWorkbook).toEqual(['electron/campDataRecord.js'])
  })

  it('the writer imports nothing from the sync/automerge/network layer', () => {
    const specs = importSpecifiers(path.join(ELECTRON_DIR, 'campDataRecord.js'))
    const forbidden = specs.filter((s) => /(^|\/)sync\//.test(s) || /automerge/.test(s) || /libp2p/.test(s))
    expect(forbidden).toEqual([])
  })

  it('the writer writes under <documentsDir>/Shoresh and never into the replicated <userData>/automerge tree', () => {
    const src = fs.readFileSync(path.join(ELECTRON_DIR, 'campDataRecord.js'), 'utf8')
    // Output is anchored to the injected documentsDir + a 'Shoresh' folder.
    expect(src).toMatch(/path\.join\(\s*documentsDir\s*,\s*['"]Shoresh['"]\s*\)/)
    // and never joins the replicated data dir or resolves an app-data path itself.
    expect(src).not.toMatch(/automerge/)
    expect(src).not.toMatch(/\.getPath\s*\(/) // e.g. app.getPath('userData')
    expect(src).not.toMatch(/userData/i)
  })

  it('main.js feeds the writer a Documents/tmp path, not the replicated data path', () => {
    const src = fs.readFileSync(path.join(ELECTRON_DIR, 'main.js'), 'utf8')
    // The documentsDir the writer receives is the OS Documents dir in production
    // and a tmp dir under test — both disjoint from <userData>/automerge.
    const block = src.match(/const\s+documentsDir\s*=[\s\S]{0,240}?createCampDataRecordWriter/)
    expect(block, 'documentsDir assignment feeding createCampDataRecordWriter not found').toBeTruthy()
    const text = block[0]
    expect(text).toMatch(/homedir\(\)[\s\S]*['"]Documents['"]/)
    expect(text).toMatch(/tmpdir\(\)/)
    expect(text).not.toMatch(/automerge/)
    expect(text).not.toMatch(/getPath\(\s*['"]userData['"]\s*\)/)
  })
})
