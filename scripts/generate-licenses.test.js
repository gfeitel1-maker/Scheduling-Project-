import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
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

let root

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'licenses-test-'))
})

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true })
})

describe('buildLicenseManifest', () => {
  it('throws a HARD failure (not a silent skip) when a production package from the lockfile is missing from node_modules', () => {
    writeLock(root, {
      'node_modules/missing-pkg': { version: '1.0.0' },
    })
    // deliberately not writing missing-pkg to disk
    expect(() => buildLicenseManifest(root)).toThrow(/missing-pkg/)
    expect(() => buildLicenseManifest(root)).toThrow(/npm ci/)
  })

  it('throws on a package with a missing/unclassifiable license field', () => {
    writeLock(root, {
      'node_modules/no-license-pkg': { version: '1.0.0' },
    })
    writePkg(root, 'node_modules/no-license-pkg', { name: 'no-license-pkg', version: '1.0.0' }) // no `license` field
    expect(() => buildLicenseManifest(root)).toThrow(/no-license-pkg/)
  })

  it('succeeds with an honest licenseText: null when the LICENSE file is absent but the field is valid', () => {
    writeLock(root, {
      'node_modules/no-file-pkg': { version: '2.0.0' },
    })
    writePkg(root, 'node_modules/no-file-pkg', { name: 'no-file-pkg', version: '2.0.0', license: 'MIT' })
    const packages = buildLicenseManifest(root)
    expect(packages).toEqual([
      { name: 'no-file-pkg', version: '2.0.0', license: 'MIT', homepage: null, licenseText: null },
    ])
  })

  it('deliberately skips a package whose lockfile entry excludes the current platform, without error', () => {
    writeLock(root, {
      'node_modules/other-platform-pkg': { version: '1.0.0', os: ['not-a-real-platform'] },
    })
    // deliberately not writing it to disk — this is the "not installed on this
    // platform, and that's expected" case the os/cpu gate exists to recognize
    const packages = buildLicenseManifest(root)
    expect(packages).toEqual([])
  })

  it('does NOT skip an optionalDependency with no os/cpu restriction just because it is optional — missing means it should have installed and failed to, which is a hard failure', () => {
    writeLock(root, {
      'node_modules/flaky-optional-pkg': { version: '1.0.0', optional: true },
    })
    expect(() => buildLicenseManifest(root)).toThrow(/flaky-optional-pkg/)
  })

  it('includes an optionalDependency with no os/cpu restriction when it IS installed', () => {
    writeLock(root, {
      'node_modules/flaky-optional-pkg': { version: '1.0.0', optional: true },
    })
    writePkg(root, 'node_modules/flaky-optional-pkg', { name: 'flaky-optional-pkg', version: '1.0.0', license: 'MIT' })
    const packages = buildLicenseManifest(root)
    expect(packages.map((p) => p.name)).toEqual(['flaky-optional-pkg'])
  })

  it('includes a transitive dependency nested under another package in node_modules', () => {
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
    const packages = buildLicenseManifest(root)
    const names = packages.map((p) => p.name)
    expect(names).toContain('has-transitive')
    expect(names).toContain('the-transitive-dep')
  })

  it('never includes a devDependency, even one nested under a production package', () => {
    writeLock(root, {
      'node_modules/has-devdep': { version: '1.0.0' },
      'node_modules/root-devdep': { version: '1.0.0', dev: true },
      'node_modules/has-devdep/node_modules/nested-devdep': { version: '1.0.0', dev: true },
    })
    writePkg(root, 'node_modules/has-devdep', { name: 'has-devdep', version: '1.0.0', license: 'MIT' })
    // Neither devDependency exists on disk — if the walk ever tried to resolve
    // them by looking outside the lockfile's dev-flagged entries this would
    // throw, proving the omission is a real filter and not an accidental miss.
    const packages = buildLicenseManifest(root)
    const names = packages.map((p) => p.name)
    expect(names).not.toContain('root-devdep')
    expect(names).not.toContain('nested-devdep')
    expect(names).toEqual(['has-devdep'])
  })

  it('collects name, version, license, homepage, and verbatim license text', () => {
    writeLock(root, {
      'node_modules/full-pkg': { version: '1.2.3' },
    })
    writePkg(
      root,
      'node_modules/full-pkg',
      { name: 'full-pkg', version: '1.2.3', license: 'Apache-2.0', homepage: 'https://example.com/full-pkg' },
      { LICENSE: 'THE FULL LICENSE TEXT\n' }
    )
    const packages = buildLicenseManifest(root)
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

  it('sorts output by name then version, deterministically', () => {
    writeLock(root, {
      'node_modules/zzz': { version: '1.0.0' },
      'node_modules/aaa': { version: '1.0.0' },
    })
    writePkg(root, 'node_modules/zzz', { name: 'zzz', version: '1.0.0', license: 'MIT' })
    writePkg(root, 'node_modules/aaa', { name: 'aaa', version: '1.0.0', license: 'MIT' })
    const packages = buildLicenseManifest(root)
    expect(packages.map((p) => p.name)).toEqual(['aaa', 'zzz'])
  })

  it('deduplicates a package installed at two different nested paths with the same name and version', () => {
    writeLock(root, {
      'node_modules/dupe': { version: '1.0.0' },
      'node_modules/has-transitive/node_modules/dupe': { version: '1.0.0' },
    })
    writePkg(root, 'node_modules/dupe', { name: 'dupe', version: '1.0.0', license: 'MIT' })
    writePkg(root, 'node_modules/has-transitive/node_modules/dupe', { name: 'dupe', version: '1.0.0', license: 'MIT' })
    const packages = buildLicenseManifest(root)
    expect(packages.filter((p) => p.name === 'dupe')).toHaveLength(1)
  })

  it('finds a license file deterministically when multiple candidates exist, regardless of directory-entry order', () => {
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
    const packages = buildLicenseManifest(root)
    // Neither filename is exactly "LICENSE" — both carry an extension — so
    // preference falls through to lexicographic: LICENSE.APACHE < LICENSE.MIT.
    expect(packages[0].licenseText).toBe('APACHE TEXT')
  })

  it('prefers a bare LICENSE file over LICENCE or COPYING, regardless of directory order', () => {
    writeLock(root, {
      'node_modules/multi-file': { version: '1.0.0' },
    })
    writePkg(
      root,
      'node_modules/multi-file',
      { name: 'multi-file', version: '1.0.0', license: 'MIT' },
      { COPYING: 'COPYING TEXT', LICENCE: 'LICENCE TEXT', LICENSE: 'LICENSE TEXT' }
    )
    const packages = buildLicenseManifest(root)
    expect(packages[0].licenseText).toBe('LICENSE TEXT')
  })
})

describe('renderJson / renderHtml determinism and escaping', () => {
  it('renderJson produces stable byte output with no timestamps or absolute paths', () => {
    const packages = [{ name: 'a', version: '1.0.0', license: 'MIT', homepage: null, licenseText: null }]
    const out1 = renderJson(packages)
    const out2 = renderJson(packages)
    expect(out1).toBe(out2)
    expect(out1).not.toMatch(/\d{4}-\d{2}-\d{2}T/) // no ISO timestamp
    expect(out1).not.toMatch(root) // no machine-specific path baked in
  })

  it('renderHtml HTML-escapes interpolated license text and names', () => {
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

  it('renderHtml visibly marks a package with no distributed license text', () => {
    const packages = [{ name: 'no-text', version: '1.0.0', license: 'MIT', homepage: null, licenseText: null }]
    const html = renderHtml(packages)
    expect(html).toMatch(/full text not distributed/i)
  })

  it('renders an http(s) homepage as a live link', () => {
    const packages = [
      { name: 'has-homepage', version: '1.0.0', license: 'MIT', homepage: 'https://example.com/pkg', licenseText: null },
    ]
    const html = renderHtml(packages)
    expect(html).toContain('<a href="https://example.com/pkg">')
  })

  it('renders a non-http(s) homepage scheme as inert escaped text, not a live link', () => {
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
