// T240 — a guard against the class of bug this ticket fixed: a default-
// exporting React component file that nothing outside its own test imports.
// `rootsBanner.jsx` sat in the tree, fully wired to real product logic
// (readiness verdict, worksheet download), with zero non-test importers —
// invisible to `npm run lint` because eslint.config.js's no-unused-vars
// exempts every capitalized binding (`varsIgnorePattern: '^[A-Z_]'`), which
// is every React component import. Narrowing that pattern was measured
// (2026-09-24) at 135 files flagged, most legitimate (React-in-scope /
// object-literal-value component references eslint's unused-vars can't see
// through) — too large a blast radius to churn for this ticket, so the
// fix is this standalone structural check instead.
import { describe, it, expect } from 'vitest'
import { readFileSync, readdirSync, statSync } from 'fs'
import path from 'path'

const SRC_DIR = path.join(__dirname)

// Known, currently-orphaned component files that are NOT this bug — each has a
// real capability behind it and a recorded owner decision
// (docs/work/tickets/T240-collapse-duplicate-ingest-layer.md).
//
// T253 — postImportBanner.jsx (and its KNOWN_ORPHANS entry) is gone: the
// grace-window undo it carried is rehomed in ReconciliationScreen's own
// post-commit exit tray (commitTrayState / CommittedTray), never re-mounted
// as a banner.
//
// Do not add to this list to silence a genuinely new orphan; only a doc'd,
// owner-acknowledged one belongs here.
const KNOWN_ORPHANS = new Set([])

// This guard walks a LIVE directory, and another test writes into it:
// eslint.supabase-ban.test.js plants `src/__supabase_ban_probe.js` to prove the
// Supabase import ban actually fires, then removes it in its own afterEach. In a
// different worker that delete can land between our readdirSync and our read, so
// both the stat and the read below must tolerate a file that has vanished.
//
// Observed as `ENOENT ... src/__supabase_ban_probe.js` at the read site, on 2 of 2
// CI runs of one branch (2026-09-26) — a red naming a path that does not exist in
// the repo, which is maximally confusing on first encounter.
//
// Skipping a vanished file cannot weaken this guard: a file that is not on disk
// when we look is not a component this repo ships, and it cannot be the importer
// that rescues a real orphan either. What WOULD weaken the guard is swallowing a
// read error generally, so both helpers rethrow anything that is not ENOENT.
function statIfPresent(full) {
  try {
    return statSync(full)
  } catch (err) {
    if (err.code === 'ENOENT') return null
    throw err
  }
}

function readIfPresent(file) {
  try {
    return readFileSync(file, 'utf8')
  } catch (err) {
    if (err.code === 'ENOENT') return null
    throw err
  }
}

function walk(dir, out = []) {
  for (const entry of readdirSync(dir)) {
    const full = path.join(dir, entry)
    const rel = path.relative(SRC_DIR, full)
    if (rel.split(path.sep).some((p) => p.startsWith('.'))) continue
    const st = statIfPresent(full)
    if (!st) continue
    if (st.isDirectory()) walk(full, out)
    else out.push(full)
  }
  return out
}

function defaultExportName(source) {
  const fn = source.match(/export default function (\w+)/)
  if (fn) return fn[1]
  const named = source.match(/export default (\w+)/)
  if (named) return named[1]
  return null
}

describe('no orphaned React component files (guard, see header comment)', () => {
  it('every default-exporting component under src/components or src/screens has a non-test importer', () => {
    const allFiles = walk(SRC_DIR)
    const sourceFiles = allFiles.filter((f) => /\.(js|jsx)$/.test(f) && !f.endsWith('.test.js') && !f.endsWith('.test.jsx'))
    const candidates = sourceFiles.filter(
      (f) =>
        f.endsWith('.jsx') &&
        (f.includes(`${path.sep}components${path.sep}`) || f.includes(`${path.sep}screens${path.sep}`))
    )

    const orphans = []
    for (const file of candidates) {
      const repoRel = path.relative(path.join(SRC_DIR, '..'), file).split(path.sep).join('/')
      if (KNOWN_ORPHANS.has(repoRel)) continue
      const source = readIfPresent(file)
      if (source === null) continue // vanished between walk and read — see header
      const exportName = defaultExportName(source)
      if (!exportName) continue // not a default-exporting component; out of scope for this guard

      const base = path.basename(file).replace(/\.jsx$/, '')
      const importPattern = new RegExp(`from ['"][^'"]*${base}(\\.jsx)?['"]`)

      const hasImporter = sourceFiles.some((other) => {
        if (other === file) return false
        const otherSource = readIfPresent(other)
        if (otherSource === null) return false // vanished between walk and read
        return importPattern.test(otherSource)
      })

      if (!hasImporter) orphans.push(repoRel)
    }

    expect(orphans).toEqual([])
  })
})
