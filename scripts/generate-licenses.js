// Generates the third-party attribution artifacts shipped in the packaged app.
// See docs/superpowers/specs/2026-09-15-licensing-and-app-menu-design.md (C2/C3).
//
// Failure behavior is the feature: an unresolvable REQUIRED dependency, or a
// dependency whose license cannot be classified, throws and NOTHING is written
// — a generator that degrades to a partial list while exiting 0 is the "ships
// green while recording nothing" class this project has already been bitten
// by (see memory: plant-the-defect-the-guard-cannot-see).
//
// DECISION (round 2, Red Hat finding — not the original spec's literal
// wording): the SET of production packages is derived from `package-lock.json`
// (lockfileVersion 3's `packages` map, keyed by installed path, each entry
// carrying `dev`/`optional`/`os`/`cpu` flags), not from walking whatever
// happens to be installed under `node_modules`. The lockfile is committed and
// therefore byte-identical on every machine; `node_modules` is not — an
// `optionalDependencies` entry like `better-sqlite3-multiple-ciphers` (no
// `os`/`cpu` restriction — its presence depends on whether its prebuild
// succeeded on THIS run) used to be silently skipped when absent, which meant
// a flaked install on one machine could red `npm run licenses:check` for a
// developer whose diff was unrelated, and "fixing" it by regenerating would
// silently DROP a dependency that genuinely ships elsewhere. A lockfile-
// derived set is stale only when dependencies actually changed, which serves
// the "fails only on real drift" goal far better than matching `node_modules`
// literally. License TEXT still has to be read from `node_modules` (the only
// place it exists) — the lockfile only decides which packages belong in the
// manifest and enforces that they are actually present on disk.
//
// A package in the lockfile's production set that is MISSING from
// `node_modules` is a HARD FAILURE, not a skip — see buildLicenseManifest.
// The one deliberate exception is a package whose lockfile entry declares
// `os`/`cpu` values that exclude the current platform: that absence is
// expected (npm never installs it here) and is skipped without error, exactly
// like it would be omitted from `node_modules` on this platform by design.
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const LICENSE_FILE_RE = /^(license|licence|copying)(\.[^.]+)?$/i

// Preference order when a package ships more than one matching file (e.g. a
// dual-licensed package with LICENSE-MIT + LICENSE-APACHE). `fs.readdirSync`
// order is filesystem-dependent, so an unordered `.find()` could pick a
// different file on different machines and red the staleness gate with no
// code change to explain it. Bare LICENSE first, then LICENCE, then COPYING,
// then lexicographic among whatever's left.
function licenseFileRank(filename) {
  const lower = filename.toLowerCase()
  if (lower === 'license') return 0
  if (lower === 'licence') return 1
  if (lower === 'copying') return 2
  return 3
}

function findLicenseText(dir) {
  let entries
  try {
    entries = fs.readdirSync(dir)
  } catch {
    return null
  }
  const candidates = entries.filter((f) => LICENSE_FILE_RE.test(f))
  if (candidates.length === 0) return null
  candidates.sort((a, b) => licenseFileRank(a) - licenseFileRank(b) || a.localeCompare(b))
  try {
    return fs.readFileSync(path.join(dir, candidates[0]), 'utf8')
  } catch {
    return null
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

// npm's lockfile `os`/`cpu` arrays list allowed values, optionally negated
// with a `!` prefix (e.g. `["!win32"]` means "everything except Windows").
// Absent/empty means unrestricted.
function platformExcluded(values, current) {
  if (!Array.isArray(values) || values.length === 0) return false
  const negated = values.filter((v) => v.startsWith('!'))
  if (negated.length > 0) return negated.some((v) => v.slice(1) === current)
  return !values.includes(current)
}

function isPlatformGatedOut(entry) {
  return platformExcluded(entry.os, process.platform) || platformExcluded(entry.cpu, process.arch)
}

/**
 * Derives the production dependency SET from `rootDir`'s committed
 * `package-lock.json` (every `packages` entry not flagged `dev`, regardless
 * of nesting depth — the lockfile is already the fully-resolved flat graph,
 * so no separate recursive walk is needed), reads each package's license
 * metadata and license text from the corresponding `node_modules` directory,
 * and returns a deterministic, name-then-version-sorted array of
 * { name, version, license, homepage, licenseText }.
 *
 * Throws on:
 *   - a production package present in the lockfile but missing from
 *     node_modules (unless its lockfile entry's os/cpu excludes this
 *     platform, in which case it is deliberately skipped)
 *   - a package whose license field cannot be classified
 *
 * Never returns partial results on failure — the caller only sees the array
 * once the whole set has been resolved.
 */
export function buildLicenseManifest(rootDir) {
  const lock = JSON.parse(fs.readFileSync(path.join(rootDir, 'package-lock.json'), 'utf8'))
  const lockPackages = lock.packages || {}
  const packages = new Map()

  for (const [key, entry] of Object.entries(lockPackages)) {
    if (key === '') continue // the root project entry itself
    if (entry.dev) continue

    if (isPlatformGatedOut(entry)) continue // expected absence — not an error

    const dir = path.join(rootDir, key)
    let pkgJson
    try {
      pkgJson = JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8'))
    } catch {
      throw new Error(
        `generate-licenses: production dependency "${key}" is in package-lock.json but missing from ` +
          `node_modules — the install tree is incomplete. Run \`npm ci\` and try again.`
      )
    }

    const license = classifyLicense(pkgJson)
    if (license === null) {
      throw new Error(
        `generate-licenses: cannot classify license for "${pkgJson.name}@${pkgJson.version}"`
      )
    }

    const dedupeKey = `${pkgJson.name}@${pkgJson.version}`
    if (packages.has(dedupeKey)) continue // same package resolved at another nested path
    packages.set(dedupeKey, {
      name: pkgJson.name,
      version: pkgJson.version,
      license,
      homepage: typeof pkgJson.homepage === 'string' ? pkgJson.homepage : null,
      licenseText: findLicenseText(dir),
    })
  }

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

// Guards against a package.json "homepage" carrying a non-http(s) scheme
// (e.g. `javascript:...`) rendering as a live, clickable link. This page is
// built from third-party package metadata, so treat that metadata as
// untrusted input for anything that becomes a URL.
function isSafeHomepageUrl(value) {
  try {
    const url = new URL(value)
    return url.protocol === 'http:' || url.protocol === 'https:'
  } catch {
    return false
  }
}

export function renderHtml(packages) {
  const rows = packages
    .map((p) => {
      const text =
        p.licenseText === null
          ? '<p><em>Full text not distributed with the package; see SPDX identifier above.</em></p>'
          : `<pre>${escapeHtml(p.licenseText)}</pre>`
      const homepage = p.homepage
        ? isSafeHomepageUrl(p.homepage)
          ? ` &middot; <a href="${escapeHtml(p.homepage)}">${escapeHtml(p.homepage)}</a>`
          : ` &middot; ${escapeHtml(p.homepage)}`
        : ''
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
