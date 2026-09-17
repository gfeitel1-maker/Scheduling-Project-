import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { buildLicenseManifest, renderJson, renderHtml } from './generate-licenses.js'

// Builds a synthetic node_modules tree so the walk is exercised against real
// files on disk rather than mocks — see memory: plant-the-defect-the-guard-cannot-see.
function writePkg(dir, name, json, files = {}) {
  const pkgDir = path.join(dir, 'node_modules', name)
  fs.mkdirSync(pkgDir, { recursive: true })
  fs.writeFileSync(path.join(pkgDir, 'package.json'), JSON.stringify({ name, ...json }, null, 2))
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
  it('throws on an unresolvable REQUIRED dependency and writes nothing partial', () => {
    fs.writeFileSync(
      path.join(root, 'package.json'),
      JSON.stringify({ name: 'root', dependencies: { 'missing-pkg': '^1.0.0' } })
    )
    expect(() => buildLicenseManifest(root)).toThrow(/missing-pkg/)
  })

  it('throws on a package with a missing/unclassifiable license field', () => {
    fs.writeFileSync(
      path.join(root, 'package.json'),
      JSON.stringify({ name: 'root', dependencies: { 'no-license-pkg': '^1.0.0' } })
    )
    writePkg(root, 'no-license-pkg', { version: '1.0.0' }) // no `license` field at all
    expect(() => buildLicenseManifest(root)).toThrow(/no-license-pkg/)
  })

  it('succeeds with an honest licenseText: null when the LICENSE file is absent but the field is valid', () => {
    fs.writeFileSync(
      path.join(root, 'package.json'),
      JSON.stringify({ name: 'root', dependencies: { 'no-file-pkg': '^1.0.0' } })
    )
    writePkg(root, 'no-file-pkg', { version: '2.0.0', license: 'MIT' })
    const packages = buildLicenseManifest(root)
    expect(packages).toEqual([
      { name: 'no-file-pkg', version: '2.0.0', license: 'MIT', homepage: null, licenseText: null },
    ])
  })

  it('skips an uninstalled OPTIONAL dependency without error', () => {
    fs.writeFileSync(
      path.join(root, 'package.json'),
      JSON.stringify({ name: 'root', optionalDependencies: { 'not-installed-pkg': '^1.0.0' } })
    )
    // deliberately not writing the package to node_modules at all
    const packages = buildLicenseManifest(root)
    expect(packages).toEqual([])
  })

  it('includes a transitive dependency reachable only through another dependency', () => {
    fs.writeFileSync(
      path.join(root, 'package.json'),
      JSON.stringify({ name: 'root', dependencies: { 'has-transitive': '^1.0.0' } })
    )
    writePkg(root, 'has-transitive', {
      version: '1.0.0',
      license: 'MIT',
      dependencies: { 'the-transitive-dep': '^1.0.0' },
    })
    writePkg(root, 'the-transitive-dep', { version: '3.1.4', license: 'ISC' })
    const packages = buildLicenseManifest(root)
    const names = packages.map((p) => p.name)
    expect(names).toContain('has-transitive')
    expect(names).toContain('the-transitive-dep')
  })

  it('never includes a devDependency of a production package', () => {
    fs.writeFileSync(
      path.join(root, 'package.json'),
      JSON.stringify({
        name: 'root',
        dependencies: { 'has-devdep': '^1.0.0' },
        devDependencies: { 'root-devdep': '^1.0.0' },
      })
    )
    writePkg(root, 'has-devdep', {
      version: '1.0.0',
      license: 'MIT',
      devDependencies: { 'nested-devdep': '^1.0.0' },
    })
    // Neither devDependency exists on disk at all — if the walk ever tried to
    // resolve them this would throw, proving the omission is a real skip and
    // not an accidental miss of an unresolvable-but-ignored path.
    const packages = buildLicenseManifest(root)
    const names = packages.map((p) => p.name)
    expect(names).not.toContain('root-devdep')
    expect(names).not.toContain('nested-devdep')
    expect(names).toEqual(['has-devdep'])
  })

  it('collects name, version, license, homepage, and verbatim license text', () => {
    fs.writeFileSync(
      path.join(root, 'package.json'),
      JSON.stringify({ name: 'root', dependencies: { 'full-pkg': '^1.0.0' } })
    )
    writePkg(
      root,
      'full-pkg',
      { version: '1.2.3', license: 'Apache-2.0', homepage: 'https://example.com/full-pkg' },
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
    fs.writeFileSync(
      path.join(root, 'package.json'),
      JSON.stringify({ name: 'root', dependencies: { zzz: '^1.0.0', aaa: '^1.0.0' } })
    )
    writePkg(root, 'zzz', { version: '1.0.0', license: 'MIT' })
    writePkg(root, 'aaa', { version: '1.0.0', license: 'MIT' })
    const packages = buildLicenseManifest(root)
    expect(packages.map((p) => p.name)).toEqual(['aaa', 'zzz'])
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
})
