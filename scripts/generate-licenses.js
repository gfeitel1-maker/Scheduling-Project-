// Generates the third-party attribution artifacts shipped in the packaged app.
// See docs/superpowers/specs/2026-09-15-licensing-and-app-menu-design.md (C2/C3).
//
// Failure behavior is the feature: an unresolvable REQUIRED dependency, or a
// dependency whose license cannot be classified, throws and NOTHING is written
// — a generator that degrades to a partial list while exiting 0 is the "ships
// green while recording nothing" class this project has already been bitten
// by (see memory: plant-the-defect-the-guard-cannot-see).
//
// An `optionalDependencies` entry that isn't installed is NOT an error — it is
// legitimately absent on some platforms (e.g. better-sqlite3-multiple-ciphers'
// prebuild alternatives) — so it is silently skipped.
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const LICENSE_FILE_RE = /^(license|licence|copying)(\.[^.]+)?$/i

function resolvePackageDir(name, fromDir) {
  let dir = fromDir
  for (;;) {
    const candidate = path.join(dir, 'node_modules', name)
    if (fs.existsSync(path.join(candidate, 'package.json'))) return candidate
    const parent = path.dirname(dir)
    if (parent === dir) return null
    dir = parent
  }
}

function classifyLicense(pkgJson) {
  const l = pkgJson.license
  if (typeof l === 'string' && l.trim().length > 0) return l.trim()
  if (l && typeof l === 'object' && typeof l.type === 'string' && l.type.trim().length > 0) {
    return l.type.trim()
  }
  if (Array.isArray(pkgJson.licenses) && pkgJson.licenses.length > 0) {
    const types = pkgJson.licenses.map((entry) => entry && entry.type).filter(Boolean)
    if (types.length > 0) return types.join(' OR ')
  }
  return null
}

function findLicenseText(dir) {
  let entries
  try {
    entries = fs.readdirSync(dir)
  } catch {
    return null
  }
  const match = entries.find((f) => LICENSE_FILE_RE.test(f))
  if (!match) return null
  try {
    return fs.readFileSync(path.join(dir, match), 'utf8')
  } catch {
    return null
  }
}

/**
 * Walks the PRODUCTION dependency closure starting from rootDir's package.json
 * (`dependencies` + `optionalDependencies`, never `devDependencies`, at any
 * depth) and returns a deterministic, name-then-version-sorted array of
 * { name, version, license, homepage, licenseText }.
 *
 * Throws on an unresolvable required dependency or an unclassifiable license.
 * Never returns partial results on failure — the caller only sees the array
 * once the whole walk has succeeded.
 */
export function buildLicenseManifest(rootDir) {
  const rootPkg = JSON.parse(fs.readFileSync(path.join(rootDir, 'package.json'), 'utf8'))
  const packages = new Map()

  function walk(name, fromDir, required) {
    const dir = resolvePackageDir(name, fromDir)
    if (!dir) {
      if (required) throw new Error(`generate-licenses: cannot resolve required dependency "${name}"`)
      return // optional and not installed on this platform — not an error
    }
    const pkgJson = JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8'))
    const license = classifyLicense(pkgJson)
    if (license === null) {
      throw new Error(
        `generate-licenses: cannot classify license for "${pkgJson.name}@${pkgJson.version}"`
      )
    }
    const key = `${pkgJson.name}@${pkgJson.version}`
    if (packages.has(key)) return // already walked — also guards cycles
    packages.set(key, {
      name: pkgJson.name,
      version: pkgJson.version,
      license,
      homepage: typeof pkgJson.homepage === 'string' ? pkgJson.homepage : null,
      licenseText: findLicenseText(dir),
    })
    for (const dep of Object.keys(pkgJson.dependencies || {})) walk(dep, dir, true)
    for (const dep of Object.keys(pkgJson.optionalDependencies || {})) walk(dep, dir, false)
  }

  for (const name of Object.keys(rootPkg.dependencies || {})) walk(name, rootDir, true)
  for (const name of Object.keys(rootPkg.optionalDependencies || {})) walk(name, rootDir, false)

  return [...packages.values()].sort(
    (a, b) => a.name.localeCompare(b.name) || a.version.localeCompare(b.version)
  )
}

/** Byte-deterministic JSON: sorted input, no timestamps, no machine-specific data. */
export function renderJson(packages) {
  return JSON.stringify(packages, null, 2) + '\n'
}

function escapeHtml(value) {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}

export function renderHtml(packages) {
  const rows = packages
    .map((p) => {
      const text =
        p.licenseText === null
          ? '<p><em>Full text not distributed with the package; see SPDX identifier above.</em></p>'
          : `<pre>${escapeHtml(p.licenseText)}</pre>`
      const homepage = p.homepage ? ` &middot; <a href="${escapeHtml(p.homepage)}">${escapeHtml(p.homepage)}</a>` : ''
      return (
        `<section>\n` +
        `<h2>${escapeHtml(p.name)} <small>${escapeHtml(p.version)}</small></h2>\n` +
        `<p>License: ${escapeHtml(p.license)}${homepage}</p>\n` +
        `${text}\n` +
        `</section>`
      )
    })
    .join('\n')
  return (
    `<!doctype html>\n<html><head><meta charset="utf-8"><title>Third-Party Licenses</title></head>\n` +
    `<body>\n<h1>Third-Party Licenses</h1>\n${rows}\n</body></html>\n`
  )
}

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const OUT_JSON = path.join(ROOT, 'electron', 'third-party-licenses.json')
const OUT_HTML = path.join(ROOT, 'electron', 'third-party-licenses.html')

function main() {
  let manifest
  try {
    manifest = buildLicenseManifest(ROOT)
  } catch (err) {
    console.error(err.message)
    process.exit(1)
    return
  }
  const json = renderJson(manifest)
  const html = renderHtml(manifest)

  if (process.argv.includes('--check')) {
    const curJson = fs.existsSync(OUT_JSON) ? fs.readFileSync(OUT_JSON, 'utf8') : null
    const curHtml = fs.existsSync(OUT_HTML) ? fs.readFileSync(OUT_HTML, 'utf8') : null
    if (curJson !== json || curHtml !== html) {
      console.error(
        'electron/third-party-licenses.{json,html} are stale relative to the dependency tree — run `npm run licenses` and commit the result.'
      )
      process.exit(1)
      return
    }
    console.log(`third-party-licenses up to date (${manifest.length} packages)`)
    return
  }

  fs.writeFileSync(OUT_JSON, json)
  fs.writeFileSync(OUT_HTML, html)
  console.log(`wrote electron/third-party-licenses.{json,html} — ${manifest.length} packages`)
}

const invokedDirectly =
  process.argv[1] && process.argv[1].replace(/\\/g, '/').endsWith('scripts/generate-licenses.js')
if (invokedDirectly) main()
