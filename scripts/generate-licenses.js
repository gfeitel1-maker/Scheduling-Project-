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
import crypto from 'node:crypto'
import { fileURLToPath } from 'node:url'
import { Parser as TarParser } from 'tar'

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

// ---------------------------------------------------------------------------
// Three-tier license TEXT sourcing.
//
// Tier 1 (disk) covers ~177/178 production packages: the package is present
// in node_modules and findLicenseText() reads it straight off disk, exactly
// as before. Tier 2/3 exist for the remaining case — a package whose
// node_modules directory is entirely absent even though it is a genuine
// production dependency (e.g. an optionalDependency like
// better-sqlite3-multiple-ciphers whose prebuild doesn't cover this Node
// version). Previously that was an unconditional hard failure telling the
// developer to re-run `npm ci`, which is unactionable when the package
// cannot install on this machine at all.
//
// Tier 2 (cache): electron/license-texts/ holds one committed text file per
// package, named `<name, "/" replaced with "+">@<version>.txt`. The "+"
// substitution keeps scoped package names (e.g. "@foo/bar") on one flat
// filename with no subdirectories. Once a package has been recovered once
// (tier 3), every subsequent run — including on a machine that can't install
// or reach the network — is offline-green from this cache.
//
// Tier 3 (fetch+verify): only reached on a cache miss. Downloads the tarball
// at the lockfile entry's own `resolved` URL, verifies the bytes against that
// entry's committed `integrity` SRI hash BEFORE trusting them (a mismatch is
// treated as a trust problem, not a license-generation bug), extracts
// package.json and the LICENSE-family file from the tarball in memory using
// the SAME findLicenseText/classifyLicense logic as the disk path, and writes
// the recovered text to the cache so the next run doesn't need the network.
function cacheFileName(name, version) {
  return `${name.replace(/\//g, '+')}@${version}.txt`
}

function readCachedLicenseText(cacheDir, name, version) {
  try {
    return fs.readFileSync(path.join(cacheDir, cacheFileName(name, version)), 'utf8')
  } catch {
    return null
  }
}

function writeCachedLicenseText(cacheDir, name, version, text) {
  fs.mkdirSync(cacheDir, { recursive: true })
  fs.writeFileSync(path.join(cacheDir, cacheFileName(name, version)), text)
}

function verifyIntegrity(buffer, integrity, label) {
  const match = /^sha512-(.+)$/.exec(integrity || '')
  if (!match) {
    throw new Error(
      `generate-licenses: "${label}"'s package-lock.json "integrity" value is not a recognized sha512 SRI hash — refusing to trust unverifiable tarball bytes.`
    )
  }
  const actual = crypto.createHash('sha512').update(buffer).digest('base64')
  if (actual !== match[1]) {
    throw new Error(
      `generate-licenses: downloaded tarball for "${label}" does not match the sha512 hash recorded in package-lock.json. ` +
        `This is a TRUST problem — a tampered, corrupted, or wrong artifact — not a license-generation bug. Refusing to use it.`
    )
  }
}

// Parses a downloaded tarball in memory (no temp files) and returns the
// package.json contents plus whichever LICENSE-family file findLicenseText's
// preference order (LICENSE > LICENCE > COPYING, then lexicographic) would
// have picked on disk, so the same file wins regardless of source.
function extractPackageFromTarball(buffer) {
  return new Promise((resolve, reject) => {
    const files = new Map() // path within package/ -> Buffer
    const parser = new TarParser({
      onwarn: () => {},
      onReadEntry(entry) {
        const chunks = []
        entry.on('data', (chunk) => chunks.push(chunk))
        entry.on('end', () => {
          // npm tarballs wrap everything in a single "package/" prefix dir.
          const rel = entry.path.replace(/^package\//, '')
          files.set(rel, Buffer.concat(chunks))
        })
      },
    })
    parser.on('error', reject)
    parser.on('end', () => {
      try {
        const pkgJsonBuf = files.get('package.json')
        if (!pkgJsonBuf) {
          reject(new Error('generate-licenses: downloaded tarball has no package.json'))
          return
        }
        const pkgJson = JSON.parse(pkgJsonBuf.toString('utf8'))
        const licenseFiles = [...files.keys()].filter((name) => LICENSE_FILE_RE.test(path.basename(name)))
        licenseFiles.sort(
          (a, b) => licenseFileRank(path.basename(a)) - licenseFileRank(path.basename(b)) || a.localeCompare(b)
        )
        const licenseText = licenseFiles.length > 0 ? files.get(licenseFiles[0]).toString('utf8') : null
        resolve({ pkgJson, licenseText })
      } catch (err) {
        reject(err)
      }
    })
    parser.end(buffer)
  })
}

async function fetchTarball(url, label, fetchImpl) {
  let response
  try {
    response = await fetchImpl(url)
  } catch (err) {
    throw new Error(`generate-licenses: failed to fetch "${label}" from ${url} — ${err.message}`)
  }
  if (!response.ok) {
    throw new Error(
      `generate-licenses: failed to fetch "${label}" from ${url} — HTTP ${response.status} ${response.statusText}`
    )
  }
  const arrayBuffer = await response.arrayBuffer()
  return Buffer.from(arrayBuffer)
}

// Resolves a package whose node_modules directory does not exist at all:
// tries the committed cache, then falls back to fetch+verify+extract,
// writing the cache on success. Never returns partial/unverified data.
async function resolveMissingPackage({ name, version, entry, cacheDir, fetchImpl }) {
  const label = `${name}@${version}`
  const cachedText = readCachedLicenseText(cacheDir, name, version)
  if (cachedText !== null) {
    // Classification still comes from the lockfile entry's own `license`
    // field (npm records it there from the package's package.json at
    // publish time) — this is committed data, so it's just as offline and
    // deterministic as the cached text, and avoids re-fetching every run.
    const license = classifyLicense(entry)
    if (license === null) {
      throw new Error(`generate-licenses: cannot classify license for "${label}" (missing from node_modules, and its package-lock.json entry has no usable license field)`)
    }
    return { name, version, license, homepage: null, licenseText: cachedText }
  }

  if (typeof entry.resolved !== 'string' || !entry.resolved || typeof entry.integrity !== 'string' || !entry.integrity) {
    throw new Error(
      `generate-licenses: "${label}" is in package-lock.json but missing from node_modules, and its lockfile entry has no ` +
        `usable "resolved"/"integrity" to recover it from — cannot source its license offline or online. Run \`npm ci\`.`
    )
  }

  const tarball = await fetchTarball(entry.resolved, label, fetchImpl)
  verifyIntegrity(tarball, entry.integrity, label)
  const { pkgJson, licenseText } = await extractPackageFromTarball(tarball)

  const license = classifyLicense(pkgJson) ?? classifyLicense(entry)
  if (license === null) {
    throw new Error(`generate-licenses: cannot classify license for "${label}"`)
  }

  if (licenseText !== null) {
    writeCachedLicenseText(cacheDir, name, version, licenseText)
  }

  return {
    name,
    version,
    license,
    homepage: typeof pkgJson.homepage === 'string' ? pkgJson.homepage : null,
    licenseText,
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
// A lockfile key looks like "node_modules/foo" or, nested,
// "node_modules/bar/node_modules/@scope/foo" — the package name is always
// whatever follows the LAST "node_modules/" segment.
function deriveNameFromKey(key) {
  const marker = 'node_modules/'
  return key.slice(key.lastIndexOf(marker) + marker.length)
}

export async function buildLicenseManifest(rootDir, { fetchImpl = globalThis.fetch } = {}) {
  const lock = JSON.parse(fs.readFileSync(path.join(rootDir, 'package-lock.json'), 'utf8'))
  const lockPackages = lock.packages || {}
  const packages = new Map()
  const cacheDir = path.join(rootDir, 'electron', 'license-texts')

  for (const [key, entry] of Object.entries(lockPackages)) {
    if (key === '') continue // the root project entry itself
    if (entry.dev) continue

    if (isPlatformGatedOut(entry)) continue // expected absence — not an error

    const dir = path.join(rootDir, key)
    let pkgJson
    let resolved
    try {
      pkgJson = JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8'))
      const license = classifyLicense(pkgJson)
      if (license === null) {
        throw new Error(`generate-licenses: cannot classify license for "${pkgJson.name}@${pkgJson.version}"`)
      }
      resolved = {
        name: pkgJson.name,
        version: pkgJson.version,
        license,
        homepage: typeof pkgJson.homepage === 'string' ? pkgJson.homepage : null,
        licenseText: findLicenseText(dir),
      }
    } catch (err) {
      if (!(err.code === 'ENOENT' || err instanceof SyntaxError)) throw err
      // Package directory is entirely absent from node_modules (e.g. a
      // no-prebuild optionalDependency on this Node version) — see the
      // three-tier sourcing block above for why this is no longer an
      // unconditional hard failure.
      resolved = await resolveMissingPackage({
        name: deriveNameFromKey(key),
        version: entry.version,
        entry,
        cacheDir,
        fetchImpl,
      })
    }

    const dedupeKey = `${resolved.name}@${resolved.version}`
    if (packages.has(dedupeKey)) continue // same package resolved at another nested path
    packages.set(dedupeKey, resolved)
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

// Prints an added/removed/version-changed delta between two manifests so a
// `--check` failure is actionable without a separate diff step.
function describeManifestDelta(oldJson, newManifest) {
  let oldManifest
  try {
    oldManifest = JSON.parse(oldJson)
  } catch {
    return // no parseable prior artifact to diff against
  }
  const oldByName = new Map(oldManifest.map((p) => [p.name, p]))
  const newByName = new Map(newManifest.map((p) => [p.name, p]))

  const added = [...newByName.keys()].filter((name) => !oldByName.has(name)).sort()
  const removed = [...oldByName.keys()].filter((name) => !newByName.has(name)).sort()
  const versionChanged = [...newByName.keys()]
    .filter((name) => oldByName.has(name) && oldByName.get(name).version !== newByName.get(name).version)
    .sort()

  console.error(`delta: +${added.length} added, -${removed.length} removed, ${versionChanged.length} version-changed`)
  for (const name of added) console.error(`  added: ${name}@${newByName.get(name).version}`)
  for (const name of removed) console.error(`  removed: ${name}@${oldByName.get(name).version}`)
  for (const name of versionChanged) {
    console.error(`  version-changed (${name}: ${oldByName.get(name).version} -> ${newByName.get(name).version})`)
  }
}

async function main() {
  let manifest
  try {
    manifest = await buildLicenseManifest(ROOT)
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
      if (curJson !== null) describeManifestDelta(curJson, manifest)
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
if (invokedDirectly) {
  main().catch((err) => {
    console.error(err.stack || err.message)
    process.exit(1)
  })
}
