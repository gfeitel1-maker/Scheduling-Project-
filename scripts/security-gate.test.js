import { describe, it, expect } from 'vitest'
import { auditFindings, scanSecrets, scanDangerous, FAILING_SEVERITIES } from './security-gate.js'

describe('auditFindings', () => {
  it('fails on high and critical, ignores moderate/low/info', () => {
    const json = {
      vulnerabilities: {
        pkgA: { severity: 'high' },
        pkgB: { severity: 'critical' },
        pkgC: { severity: 'moderate' },
        pkgD: { severity: 'low' },
        pkgE: { severity: 'info' },
      },
    }
    const names = auditFindings(json).map((f) => f.name).sort()
    expect(names).toEqual(['pkgA', 'pkgB'])
  })

  it('is empty when there are no vulnerabilities', () => {
    expect(auditFindings({ vulnerabilities: {} })).toEqual([])
    expect(auditFindings({})).toEqual([])
    expect(auditFindings(null)).toEqual([])
  })

  it('the failing set is exactly high + critical (pinned)', () => {
    expect([...FAILING_SEVERITIES].sort()).toEqual(['critical', 'high'])
  })
})

describe('scanSecrets', () => {
  it('flags a private key block, an AWS key id, and a github token', () => {
    const files = [
      { path: 'a.js', content: 'const k = "-----BEGIN PRIVATE KEY-----"' },
      { path: 'b.js', content: 'AKIAIOSFODNN7EXAMPLE' },
      { path: 'c.js', content: 'ghp_0123456789012345678901234567890123ab' }, // security-gate:allow (this test file is not self-skipped, so mark it)
    ]
    // the c.js content itself matches; the ALLOW marker above is on THIS line, not in content
    const findings = scanSecrets(files)
    expect(findings.map((f) => f.pattern)).toEqual(
      expect.arrayContaining(['private-key-block', 'aws-access-key-id', 'github-token'])
    )
  })

  it('honours the allow marker on the offending line', () => {
    const files = [{ path: 'x.js', content: 'AKIAIOSFODNN7EXAMPLE // security-gate:allow' }]
    expect(scanSecrets(files)).toEqual([])
  })

  it('does not scan its own source files', () => {
    const files = [{ path: 'scripts/security-gate.js', content: 'AKIAIOSFODNN7EXAMPLE' }]
    expect(scanSecrets(files)).toEqual([])
  })

  it('flags a generic long api-key assignment but not a short value', () => {
    const long = [{ path: 'x.js', content: 'const apiKey = "abcdefghijklmnopqrstuvwxyz012345"' }]
    const short = [{ path: 'y.js', content: 'const token = "abc123"' }]
    expect(scanSecrets(long).length).toBe(1)
    expect(scanSecrets(short)).toEqual([])
  })
})

describe('scanDangerous', () => {
  it('does NOT flag interpolated SQL — identifier interpolation is pervasive and safe here', () => {
    // SQL review is the Security agent's data-flow-aware job, not this regex gate's; the gate
    // must not fire on the schema-identifier interpolation this codebase uses everywhere.
    const internal = [{ path: 'electron/x.js', content: 'db.prepare(`SELECT ${fields} FROM ${table}`)' }]
    const externalLooking = [{ path: 'electron/x.js', content: 'db.prepare(`SELECT * FROM t WHERE id = ${req.query.id}`)' }]
    expect(scanDangerous(internal)).toEqual([])
    expect(scanDangerous(externalLooking)).toEqual([])
  })

  it('scans code files only — a doc that says "static eval" is not a finding', () => {
    const doc = [{ path: 'docs/x.md', content: 'we did a static eval (by hand)' }]
    expect(scanDangerous(doc)).toEqual([])
  })

  it('does not flag member access like foo.eval(', () => {
    const ok = [{ path: 'src/a.js', content: 'thing.eval(x)' }]
    expect(scanDangerous(ok)).toEqual([])
  })

  it('flags eval and dangerouslySetInnerHTML', () => {
    const files = [
      { path: 'src/a.js', content: 'eval(userInput)' },
      { path: 'src/b.jsx', content: '<div dangerouslySetInnerHTML={{__html: x}} />' },
    ]
    expect(scanDangerous(files).map((f) => f.pattern).sort()).toEqual(['dangerouslySetInnerHTML', 'eval'])
  })

  it('honours the allow marker', () => {
    const files = [{ path: 'electron/x.js', content: 'db.exec(`DROP ${t}`) // security-gate:allow' }]
    expect(scanDangerous(files)).toEqual([])
  })
})
