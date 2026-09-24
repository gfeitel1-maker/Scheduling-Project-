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

// Known, currently-orphaned component files that are NOT this bug — each has
// a real capability behind it and a recorded owner decision pending restore-
// vs-retire (see docs/work/tickets/T240-collapse-duplicate-ingest-layer.md).
// Do not add to this list to silence a genuinely new orphan; only a doc'd,
// owner-acknowledged one belongs here.
const KNOWN_ORPHANS = new Set([
  'src/components/reconciliation/postImportBanner.jsx',
])

function walk(dir, out = []) {
  for (const entry of readdirSync(dir)) {
    const full = path.join(dir, entry)
    const rel = path.relative(SRC_DIR, full)
    if (rel.split(path.sep).some((p) => p.startsWith('.'))) continue
    const st = statSync(full)
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
      const source = readFileSync(file, 'utf8')
      const exportName = defaultExportName(source)
      if (!exportName) continue // not a default-exporting component; out of scope for this guard

      const base = path.basename(file).replace(/\.jsx$/, '')
      const importPattern = new RegExp(`from ['"][^'"]*${base}(\\.jsx)?['"]`)

      const hasImporter = sourceFiles.some((other) => {
        if (other === file) return false
        const otherSource = readFileSync(other, 'utf8')
        return importPattern.test(otherSource)
      })

      if (!hasImporter) orphans.push(repoRel)
    }

    expect(orphans).toEqual([])
  })
})
