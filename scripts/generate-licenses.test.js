import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import crypto from 'node:crypto'
import * as tar from 'tar'
import { buildLicenseManifest, renderJson, renderHtml } from './generate-licenses.js'

// Builds a synthetic root: a package-lock.json (the source of truth for the
// SET of production packages — see the file header for why) plus real files
// on disk under node_modules for whatever the test needs to resolve, so the
// walk is exercised against real files rather than mocks — see memory:
// plant-the-defect-the-guard-cannot-see.
function writeLock(root, packages) {
  fs.writeFileSync(
    path.join(root, 'package-lock.json'),
    JSON.stringify({ name: 'root', lockfileVersion: 3, packages: { '': { name: 'root' }, ...packages } }, null, 2)
  )
}

function writePkg(root, key, json, files = {}) {
  const pkgDir = path.join(root, key)
  fs.mkdirSync(pkgDir, { recursive: true })
  fs.writeFileSync(path.join(pkgDir, 'package.json'), JSON.stringify(json, null, 2))
  for (const [filename, content] of Object.entries(files)) {
    fs.writeFileSync(path.join(pkgDir, filename), content)
  }
  return pkgDir
}

// Builds a real gzipped npm-shaped tarball in memory (package/package.json +
// package/<licenseFile>), synchronously, using the same `tar` package the
// generator uses to extract — so tests exercise real bytes, not a mock of
// the parser. Returns { buffer, integrity } where integrity is the real
// sha512 SRI hash the generator would need to verify against.
function makeTarball({ pkgJson, licenseFileName, licenseText }) {
  const src = fs.mkdtempSync(path.join(os.tmpdir(), 'tarball-src-'))
  const pkgDir = path.join(src, 'package')
  fs.mkdirSync(pkgDir)
  fs.writeFileSync(path.join(pkgDir, 'package.json'), JSON.stringify(pkgJson))
  if (licenseFileName) fs.writeFileSync(path.join(pkgDir, licenseFileName), licenseText)
  const stream = tar.create({ gzip: true, sync: true, cwd: src }, ['package'])
  const chunks = []
  stream.on('data', (c) => chunks.push(c))
  stream.resume()
  // sync:true means data is already fully buffered by the time create()
  // returns; drain synchronously.
  let buffer = Buffer.concat(chunks)
  fs.rmSync(src, { recursive: true, force: true })
  const integrity = `sha512-${crypto.createHash('sha512').update(buffer).digest('base64')}`
  return { buffer, integrity }
}

// The cache stores the FULL resolved record ({ name, version, license,
// homepage, licenseText }) as JSON, named `<name, "/" -> "+">@<version>.json`
// — not just raw license text — so a cache hit never needs to consult disk
// for any field. See the tier-order comment in generate-licenses.js.
function writeCacheRecord(root, name, version, record) {
  const dir = path.join(root, 'electron', 'license-texts')
  fs.mkdirSync(dir, { recursive: true })
  const filename = `${name.replace(/\//g, '+')}@${version}.json`
  fs.writeFileSync(path.join(dir, filename), JSON.stringify(record, null, 2) + '\n')
}

function fakeFetchOk(buffer) {
  return async () => ({
    ok: true,
    status: 200,
    statusText: 'OK',
    arrayBuffer: async () => buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength),
  })
}

let root

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'licenses-test-'))
})

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true })
})

describe('buildLicenseManifest', () => {
  it('throws a HARD failure (not a silent skip) when a production package from the lockfile is missing from node_modules', async () => {
    writeLock(root, {
      'node_modules/missing-pkg': { version: '1.0.0' },
    })
    // deliberately not writing missing-pkg to disk
    await expect(buildLicenseManifest(root)).rejects.toThrow(/missing-pkg/)
    await expect(buildLicenseManifest(root)).rejects.toThrow(/npm ci/)
  })

  it('throws its own corruption error, and does NOT fall through to a network fetch, when package.json is present but not valid JSON', async () => {
    writeLock(root, {
      'node_modules/corrupt-pkg': {
        version: '1.0.0',
        resolved: 'https://registry.npmjs.org/corrupt-pkg/-/corrupt-pkg-1.0.0.tgz',
        integrity: 'sha512-doesnotmatter',
      },
    })
    const dir = path.join(root, 'node_modules', 'corrupt-pkg')
    fs.mkdirSync(dir, { recursive: true })
    fs.writeFileSync(path.join(dir, 'package.json'), '{ this is not valid json')
    const fetchImpl = async () => {
      throw new Error('must not be called — a corrupt package.json is not a missing package')
    }
    await expect(buildLicenseManifest(root, { fetchImpl })).rejects.toThrow(/corrupt-pkg.*not valid JSON/s)
  })

  it('throws on a package with a missing/unclassifiable license field', async () => {
    writeLock(root, {
      'node_modules/no-license-pkg': { version: '1.0.0' },
    })
    writePkg(root, 'node_modules/no-license-pkg', { name: 'no-license-pkg', version: '1.0.0' }) // no `license` field
    await expect(buildLicenseManifest(root)).rejects.toThrow(/no-license-pkg/)
  })

  it('succeeds with an honest licenseText: null when the LICENSE file is absent but the field is valid', async () => {
    writeLock(root, {
      'node_modules/no-file-pkg': { version: '2.0.0' },
    })
    writePkg(root, 'node_modules/no-file-pkg', { name: 'no-file-pkg', version: '2.0.0', license: 'MIT' })
    const packages = await buildLicenseManifest(root)
    expect(packages).toEqual([
      { name: 'no-file-pkg', version: '2.0.0', license: 'MIT', homepage: null, licenseText: null },
    ])
  })

  it('deliberately skips a package whose lockfile entry excludes the current platform, without error', async () => {
    writeLock(root, {
      'node_modules/other-platform-pkg': { version: '1.0.0', os: ['not-a-real-platform'] },
    })
    // deliberately not writing it to disk — this is the "not installed on this
    // platform, and that's expected" case the os/cpu gate exists to recognize
    const packages = await buildLicenseManifest(root)
    expect(packages).toEqual([])
  })

  it('does NOT skip an optionalDependency with no os/cpu restriction just because it is optional — missing means it should have installed and failed to, which is a hard failure', async () => {
    writeLock(root, {
      'node_modules/flaky-optional-pkg': { version: '1.0.0', optional: true },
    })
    await expect(buildLicenseManifest(root)).rejects.toThrow(/flaky-optional-pkg/)
  })

  it('includes an optionalDependency with no os/cpu restriction when it IS installed', async () => {
    writeLock(root, {
      'node_modules/flaky-optional-pkg': { version: '1.0.0', optional: true },
    })
    writePkg(root, 'node_modules/flaky-optional-pkg', { name: 'flaky-optional-pkg', version: '1.0.0', license: 'MIT' })
    const packages = await buildLicenseManifest(root)
    expect(packages.map((p) => p.name)).toEqual(['flaky-optional-pkg'])
  })

  it('includes a transitive dependency nested under another package in node_modules', async () => {
    writeLock(root, {
      'node_modules/has-transitive': { version: '1.0.0' },
      'node_modules/has-transitive/node_modules/the-transitive-dep': { version: '3.1.4' },
    })
    writePkg(root, 'node_modules/has-transitive', { name: 'has-transitive', version: '1.0.0', license: 'MIT' })
    writePkg(root, 'node_modules/has-transitive/node_modules/the-transitive-dep', {
      name: 'the-transitive-dep',
      version: '3.1.4',
      license: 'ISC',
    })
    const packages = await buildLicenseManifest(root)
    const names = packages.map((p) => p.name)
    expect(names).toContain('has-transitive')
    expect(names).toContain('the-transitive-dep')
  })

  it('never includes a devDependency, even one nested under a production package', async () => {
    writeLock(root, {
      'node_modules/has-devdep': { version: '1.0.0' },
      'node_modules/root-devdep': { version: '1.0.0', dev: true },
      'node_modules/has-devdep/node_modules/nested-devdep': { version: '1.0.0', dev: true },
    })
    writePkg(root, 'node_modules/has-devdep', { name: 'has-devdep', version: '1.0.0', license: 'MIT' })
    // Neither devDependency exists on disk — if the walk ever tried to resolve
    // them by looking outside the lockfile's dev-flagged entries this would
    // throw, proving the omission is a real filter and not an accidental miss.
    const packages = await buildLicenseManifest(root)
    const names = packages.map((p) => p.name)
    expect(names).not.toContain('root-devdep')
    expect(names).not.toContain('nested-devdep')
    expect(names).toEqual(['has-devdep'])
  })

  it('collects name, version, license, homepage, and verbatim license text', async () => {
    writeLock(root, {
      'node_modules/full-pkg': { version: '1.2.3' },
    })
    writePkg(
      root,
      'node_modules/full-pkg',
      { name: 'full-pkg', version: '1.2.3', license: 'Apache-2.0', homepage: 'https://example.com/full-pkg' },
      { LICENSE: 'THE FULL LICENSE TEXT\n' }
    )
    const packages = await buildLicenseManifest(root)
    expect(packages).toEqual([
      {
        name: 'full-pkg',
        version: '1.2.3',
        license: 'Apache-2.0',
        homepage: 'https://example.com/full-pkg',
        licenseText: 'THE FULL LICENSE TEXT\n',
      },
    ])
  })

  it('sorts output by name then version, deterministically', async () => {
    writeLock(root, {
      'node_modules/zzz': { version: '1.0.0' },
      'node_modules/aaa': { version: '1.0.0' },
    })
    writePkg(root, 'node_modules/zzz', { name: 'zzz', version: '1.0.0', license: 'MIT' })
    writePkg(root, 'node_modules/aaa', { name: 'aaa', version: '1.0.0', license: 'MIT' })
    const packages = await buildLicenseManifest(root)
    expect(packages.map((p) => p.name)).toEqual(['aaa', 'zzz'])
  })

  it('deduplicates a package installed at two different nested paths with the same name and version', async () => {
    writeLock(root, {
      'node_modules/dupe': { version: '1.0.0' },
      'node_modules/has-transitive/node_modules/dupe': { version: '1.0.0' },
    })
    writePkg(root, 'node_modules/dupe', { name: 'dupe', version: '1.0.0', license: 'MIT' })
    writePkg(root, 'node_modules/has-transitive/node_modules/dupe', { name: 'dupe', version: '1.0.0', license: 'MIT' })
    const packages = await buildLicenseManifest(root)
    expect(packages.filter((p) => p.name === 'dupe')).toHaveLength(1)
  })

  it('finds a license file deterministically when multiple candidates exist, regardless of directory-entry order', async () => {
    writeLock(root, {
      'node_modules/dual-licensed': { version: '1.0.0' },
    })
    // fs.readdirSync order is filesystem-dependent; write APACHE-shaped file
    // second so a naive `.find()` over unsorted entries could still pick it
    // first on some filesystems. The preference order (LICENSE before LICENCE
    // before COPYING, then lexicographic) must make this deterministic.
    writePkg(
      root,
      'node_modules/dual-licensed',
      { name: 'dual-licensed', version: '1.0.0', license: '(MIT OR Apache-2.0)' },
      { 'LICENSE.APACHE': 'APACHE TEXT', 'LICENSE.MIT': 'MIT TEXT' }
    )
    const packages = await buildLicenseManifest(root)
    // Neither filename is exactly "LICENSE" — both carry an extension — so
    // preference falls through to lexicographic: LICENSE.APACHE < LICENSE.MIT.
    expect(packages[0].licenseText).toBe('APACHE TEXT')
  })

  it('prefers a bare LICENSE file over LICENCE or COPYING, regardless of directory order', async () => {
    writeLock(root, {
      'node_modules/multi-file': { version: '1.0.0' },
    })
    writePkg(
      root,
      'node_modules/multi-file',
      { name: 'multi-file', version: '1.0.0', license: 'MIT' },
      { COPYING: 'COPYING TEXT', LICENCE: 'LICENCE TEXT', LICENSE: 'LICENSE TEXT' }
    )
    const packages = await buildLicenseManifest(root)
    expect(packages[0].licenseText).toBe('LICENSE TEXT')
  })
})

// A package entirely absent from node_modules (not just missing a LICENSE
// file — the whole directory doesn't exist, e.g. an optionalDependency whose
// prebuild doesn't cover this Node version). Tier 1 (disk) is unreachable by
// construction in every test below; these exercise tier 2 (committed cache)
// and tier 3 (fetch + verify + extract), plus every hard-failure mode.
describe('buildLicenseManifest — package missing from node_modules entirely', () => {
  it('tier 1: uses the committed electron/license-texts/ cache record and never calls fetch', async () => {
    writeLock(root, {
      'node_modules/cached-pkg': { version: '1.0.0', license: 'MIT' },
    })
    writeCacheRecord(root, 'cached-pkg', '1.0.0', {
      name: 'cached-pkg',
      version: '1.0.0',
      license: 'MIT',
      homepage: null,
      licenseText: 'CACHED TEXT',
    })
    const fetchImpl = async () => {
      throw new Error('must not be called — cache should have satisfied this package')
    }
    const packages = await buildLicenseManifest(root, { fetchImpl })
    expect(packages).toEqual([
      { name: 'cached-pkg', version: '1.0.0', license: 'MIT', homepage: null, licenseText: 'CACHED TEXT' },
    ])
  })

  it('tier 1: escapes "/" in a scoped package name for the cache filename', async () => {
    writeLock(root, {
      'node_modules/@scope/cached-pkg': { version: '2.0.0', license: 'ISC' },
    })
    writeCacheRecord(root, '@scope/cached-pkg', '2.0.0', {
      name: '@scope/cached-pkg',
      version: '2.0.0',
      license: 'ISC',
      homepage: null,
      licenseText: 'SCOPED CACHED TEXT',
    })
    const packages = await buildLicenseManifest(root, { fetchImpl: async () => { throw new Error('no network') } })
    expect(packages[0]).toMatchObject({ name: '@scope/cached-pkg', licenseText: 'SCOPED CACHED TEXT' })
  })

  it('tier 3: fetches, verifies integrity, extracts package.json + LICENSE, and writes the cache record for next time', async () => {
    const { buffer, integrity } = makeTarball({
      pkgJson: { name: 'fetched-pkg', version: '1.0.0', license: 'Apache-2.0', homepage: 'https://example.com/fetched-pkg' },
      licenseFileName: 'LICENSE',
      licenseText: 'FETCHED LICENSE TEXT',
    })
    writeLock(root, {
      'node_modules/fetched-pkg': {
        version: '1.0.0',
        resolved: 'https://registry.npmjs.org/fetched-pkg/-/fetched-pkg-1.0.0.tgz',
        integrity,
      },
    })
    const packages = await buildLicenseManifest(root, { fetchImpl: fakeFetchOk(buffer) })
    expect(packages).toEqual([
      {
        name: 'fetched-pkg',
        version: '1.0.0',
        license: 'Apache-2.0',
        homepage: 'https://example.com/fetched-pkg',
        licenseText: 'FETCHED LICENSE TEXT',
      },
    ])
    const cached = JSON.parse(fs.readFileSync(path.join(root, 'electron', 'license-texts', 'fetched-pkg@1.0.0.json'), 'utf8'))
    expect(cached).toEqual({
      name: 'fetched-pkg',
      version: '1.0.0',
      license: 'Apache-2.0',
      homepage: 'https://example.com/fetched-pkg',
      licenseText: 'FETCHED LICENSE TEXT',
    })
  })

  it('tier 3 is skipped on a cache hit even when resolved/integrity are present (cache wins, no fetch call)', async () => {
    writeLock(root, {
      'node_modules/either-tier-pkg': {
        version: '1.0.0',
        license: 'MIT',
        resolved: 'https://registry.npmjs.org/either-tier-pkg/-/either-tier-pkg-1.0.0.tgz',
        integrity: 'sha512-doesnotmatter',
      },
    })
    writeCacheRecord(root, 'either-tier-pkg', '1.0.0', {
      name: 'either-tier-pkg',
      version: '1.0.0',
      license: 'MIT',
      homepage: null,
      licenseText: 'FROM CACHE',
    })
    let fetchCalled = false
    const packages = await buildLicenseManifest(root, {
      fetchImpl: async () => {
        fetchCalled = true
        throw new Error('should not reach fetch')
      },
    })
    expect(fetchCalled).toBe(false)
    expect(packages[0].licenseText).toBe('FROM CACHE')
  })

  it('hard-fails with a distinct message when neither cache nor a usable resolved/integrity exists', async () => {
    writeLock(root, {
      'node_modules/nowhere-pkg': { version: '1.0.0', license: 'MIT' },
    })
    await expect(buildLicenseManifest(root, { fetchImpl: async () => { throw new Error('unused') } })).rejects.toThrow(
      /nowhere-pkg.*resolved.*integrity/s
    )
  })

  it('hard-fails with a distinct trust-problem message on a tarball integrity mismatch, and does not write the cache', async () => {
    const { buffer } = makeTarball({
      pkgJson: { name: 'tampered-pkg', version: '1.0.0', license: 'MIT' },
      licenseFileName: 'LICENSE',
      licenseText: 'TAMPERED TEXT',
    })
    writeLock(root, {
      'node_modules/tampered-pkg': {
        version: '1.0.0',
        resolved: 'https://registry.npmjs.org/tampered-pkg/-/tampered-pkg-1.0.0.tgz',
        // Deliberately wrong hash — this is the whole point of the test.
        integrity: `sha512-${crypto.createHash('sha512').update('not the real bytes').digest('base64')}`,
      },
    })
    await expect(buildLicenseManifest(root, { fetchImpl: fakeFetchOk(buffer) })).rejects.toThrow(
      /trust problem/i
    )
    expect(fs.existsSync(path.join(root, 'electron', 'license-texts', 'tampered-pkg@1.0.0.json'))).toBe(false)
  })

  it('hard-fails with a distinct message when the fetch itself fails (network error)', async () => {
    writeLock(root, {
      'node_modules/unreachable-pkg': {
        version: '1.0.0',
        resolved: 'https://registry.npmjs.org/unreachable-pkg/-/unreachable-pkg-1.0.0.tgz',
        integrity: 'sha512-doesnotmatter',
      },
    })
    const fetchImpl = async () => {
      throw new Error('ECONNREFUSED')
    }
    await expect(buildLicenseManifest(root, { fetchImpl })).rejects.toThrow(/unreachable-pkg/)
  })

  it('hard-fails with a distinct message on an HTTP error response', async () => {
    writeLock(root, {
      'node_modules/notfound-pkg': {
        version: '1.0.0',
        resolved: 'https://registry.npmjs.org/notfound-pkg/-/notfound-pkg-1.0.0.tgz',
        integrity: 'sha512-doesnotmatter',
      },
    })
    const fetchImpl = async () => ({ ok: false, status: 404, statusText: 'Not Found' })
    await expect(buildLicenseManifest(root, { fetchImpl })).rejects.toThrow(/404/)
  })

  // Non-vacuity check: prove the fetch path is exercised for real by using a
  // tarball whose package.json license DIFFERS from the lockfile entry's own
  // `license` field — if the code path silently fell back to the lockfile
  // value instead of actually parsing the fetched tarball, this would fail.
  it('classification comes from the FETCHED package.json, not just the lockfile entry (proves the tarball is actually parsed)', async () => {
    const { buffer, integrity } = makeTarball({
      pkgJson: { name: 'real-license-pkg', version: '1.0.0', license: 'BSD-3-Clause' },
      licenseFileName: 'LICENSE',
      licenseText: 'BSD TEXT',
    })
    writeLock(root, {
      'node_modules/real-license-pkg': {
        version: '1.0.0',
        // Deliberately absent/wrong lockfile `license` so a pass-through
        // bug (using the lockfile value instead of the fetched one) is
        // caught by this test rather than hidden by agreement.
        resolved: 'https://registry.npmjs.org/real-license-pkg/-/real-license-pkg-1.0.0.tgz',
        integrity,
      },
    })
    const packages = await buildLicenseManifest(root, { fetchImpl: fakeFetchOk(buffer) })
    expect(packages[0].license).toBe('BSD-3-Clause')
  })

  // Non-vacuity check for the cache-hit branch: disk carries a DIFFERENT
  // license and homepage than the committed cache record. If the cache-hit
  // branch fell back to reading any field off disk (the exact bug this
  // reordering exists to close — see the tier-order comment), this would
  // pick up the disk license/homepage and fail. Every field must come from
  // the committed record, none from disk.
  it('a cache hit sources every field from the committed record, never from disk, even when disk disagrees', async () => {
    writeLock(root, {
      'node_modules/both-present': { version: '1.0.0', license: 'MIT' },
    })
    writePkg(
      root,
      'node_modules/both-present',
      { name: 'both-present', version: '1.0.0', license: 'ISC', homepage: 'https://disk-only.example.com/wrong' },
      { LICENSE: 'DISK TEXT (should lose)' }
    )
    writeCacheRecord(root, 'both-present', '1.0.0', {
      name: 'both-present',
      version: '1.0.0',
      license: 'Apache-2.0',
      homepage: 'https://committed.example.com/correct',
      licenseText: 'CACHE TEXT (should win)',
    })
    const packages = await buildLicenseManifest(root)
    expect(packages).toEqual([
      {
        name: 'both-present',
        version: '1.0.0',
        license: 'Apache-2.0',
        homepage: 'https://committed.example.com/correct',
        licenseText: 'CACHE TEXT (should win)',
      },
    ])
  })

  it('fetch timeout/failure message names the commit-the-cache remedy, not `npm ci`', async () => {
    writeLock(root, {
      'node_modules/timeout-pkg': {
        version: '1.0.0',
        resolved: 'https://registry.npmjs.org/timeout-pkg/-/timeout-pkg-1.0.0.tgz',
        integrity: 'sha512-doesnotmatter',
      },
    })
    const fetchImpl = async () => {
      const err = new Error('The operation was aborted due to timeout')
      err.name = 'TimeoutError'
      throw err
    }
    await expect(buildLicenseManifest(root, { fetchImpl })).rejects.toThrow(/electron\/license-texts/)
  })

  it('bounds the fetch with an AbortSignal timeout', async () => {
    const { buffer, integrity } = makeTarball({
      pkgJson: { name: 'signal-pkg', version: '1.0.0', license: 'MIT' },
      licenseFileName: 'LICENSE',
      licenseText: 'SIGNAL TEXT',
    })
    writeLock(root, {
      'node_modules/signal-pkg': {
        version: '1.0.0',
        resolved: 'https://registry.npmjs.org/signal-pkg/-/signal-pkg-1.0.0.tgz',
        integrity,
      },
    })
    let receivedOptions
    const fetchImpl = async (url, options) => {
      receivedOptions = options
      return {
        ok: true,
        status: 200,
        statusText: 'OK',
        arrayBuffer: async () => buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength),
      }
    }
    await buildLicenseManifest(root, { fetchImpl })
    expect(receivedOptions.signal).toBeInstanceOf(AbortSignal)
  })
})

describe('buildLicenseManifest — cache filename collisions and orphans', () => {
  it('throws when two packages in the production set would collide on the same cache filename', async () => {
    writeLock(root, {
      'node_modules/@a/b': { version: '1.0.0' },
      'node_modules/@a+b': { version: '1.0.0' },
    })
    writePkg(root, 'node_modules/@a/b', { name: '@a/b', version: '1.0.0', license: 'MIT' })
    writePkg(root, 'node_modules/@a+b', { name: '@a+b', version: '1.0.0', license: 'MIT' })
    await expect(buildLicenseManifest(root)).rejects.toThrow(/collide/i)
  })

  it('throws when electron/license-texts/ contains a file that does not correspond to any production dependency', async () => {
    writeLock(root, {
      'node_modules/still-here': { version: '1.0.0' },
    })
    writePkg(root, 'node_modules/still-here', { name: 'still-here', version: '1.0.0', license: 'MIT' })
    writeCacheRecord(root, 'long-gone-pkg', '9.9.9', {
      name: 'long-gone-pkg',
      version: '9.9.9',
      license: 'MIT',
      homepage: null,
      licenseText: 'ORPHAN TEXT',
    })
    await expect(buildLicenseManifest(root)).rejects.toThrow(/long-gone-pkg@9\.9\.9/)
  })
})

describe('renderJson / renderHtml determinism and escaping', () => {
  it('renderJson produces stable byte output with no timestamps or absolute paths', async () => {
    const packages = [{ name: 'a', version: '1.0.0', license: 'MIT', homepage: null, licenseText: null }]
    const out1 = renderJson(packages)
    const out2 = renderJson(packages)
    expect(out1).toBe(out2)
    expect(out1).not.toMatch(/\d{4}-\d{2}-\d{2}T/) // no ISO timestamp
    expect(out1).not.toMatch(root) // no machine-specific path baked in
  })

  it('renderHtml HTML-escapes interpolated license text and names', async () => {
    const packages = [
      {
        name: '<script>evil</script>',
        version: '1.0.0',
        license: 'MIT',
        homepage: null,
        licenseText: '<b>not actually bold</b> & "quoted"',
      },
    ]
    const html = renderHtml(packages)
    expect(html).not.toContain('<script>evil</script>')
    expect(html).toContain('&lt;script&gt;evil&lt;/script&gt;')
    expect(html).toContain('&lt;b&gt;not actually bold&lt;/b&gt;')
    expect(html).toContain('&amp;')
  })

  it('renderHtml visibly marks a package with no distributed license text', async () => {
    const packages = [{ name: 'no-text', version: '1.0.0', license: 'MIT', homepage: null, licenseText: null }]
    const html = renderHtml(packages)
    expect(html).toMatch(/full text not distributed/i)
  })

  it('renders an http(s) homepage as a live link', async () => {
    const packages = [
      { name: 'has-homepage', version: '1.0.0', license: 'MIT', homepage: 'https://example.com/pkg', licenseText: null },
    ]
    const html = renderHtml(packages)
    expect(html).toContain('<a href="https://example.com/pkg">')
  })

  it('renders a non-http(s) homepage scheme as inert escaped text, not a live link', async () => {
    const packages = [
      {
        name: 'evil-homepage',
        version: '1.0.0',
        license: 'MIT',
        homepage: 'javascript:alert(1)',
        licenseText: null,
      },
    ]
    const html = renderHtml(packages)
    expect(html).not.toContain('<a href="javascript:alert(1)">')
    expect(html).not.toContain('href="javascript:')
  })
})
