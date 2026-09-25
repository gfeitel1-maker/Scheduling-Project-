import { describe, it, expect } from 'vitest'
import { createHash, randomBytes } from 'node:crypto'
import { auditFindings, scanSecrets, scanDangerous, scanPrivacy, FAILING_SEVERITIES } from './security-gate.js'

// Builds a fresh random token of the given length and its digest, without ever holding
// the real identity token. Used to prove the hashed-identity mechanism without the plaintext.
function freshTokenAndDigest(length) {
  const token = randomBytes(length * 2).toString('hex').replace(/[0-9]/g, 'a').slice(0, length)
  const digest = createHash('sha256').update(token.toLowerCase()).digest('hex')
  return { token, digest }
}

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

describe('scanPrivacy', () => {
  it('flags an absolute home path in a doc file', () => {
    const files = [{ path: 'docs/x.md', content: 'Run it from /Users/realname/dev/shoresh first.' }]
    const findings = scanPrivacy(files)
    expect(findings.some((f) => f.pattern === 'home-path')).toBe(true)
  })

  it('flags an absolute home path in a code file', () => {
    const files = [{ path: 'src/x.js', content: "const p = '/home/realname/data'" }]
    const findings = scanPrivacy(files)
    expect(findings.some((f) => f.pattern === 'home-path')).toBe(true)
  })

  it('does not flag a placeholder home path', () => {
    const files = [{ path: 'test/fixture.md', content: '/Users/x/dev/shoresh' }]
    expect(scanPrivacy(files).some((f) => f.pattern === 'home-path')).toBe(false)
  })

  it('flags a hashed identity token in file contents, without ever holding the real token', () => {
    const { token, digest } = freshTokenAndDigest(10)
    const files = [{ path: 'docs/note.md', content: `session for ${token} today` }]
    const findings = scanPrivacy(files, new Set([digest]))
    expect(findings.some((f) => f.pattern === 'identity-token' && f.path === 'docs/note.md')).toBe(true)
  })

  it('flags a hashed identity token planted in a filename — the case a contents-only scan misses', () => {
    const { token, digest } = freshTokenAndDigest(5)
    const files = [{ path: `docs/x/campB-${token}-by-day.txt`, content: 'unrelated' }]
    const findings = scanPrivacy(files, new Set([digest]))
    const found = findings.find((f) => f.pattern === 'identity-token')
    expect(found).toBeTruthy()
    expect(found.line).toBeFalsy()
  })

  it('a filename identity-token finding has no line and is not suppressible by the allow marker', () => {
    const { token, digest } = freshTokenAndDigest(10)
    const files = [{ path: `-Users-${token}-dev-shoresh/session.txt // security-gate:allow`, content: 'unrelated' }]
    // path itself carries the marker text, but marker only suppresses CONTENT findings
    const findings = scanPrivacy(files, new Set([digest]))
    expect(findings.some((f) => f.pattern === 'identity-token')).toBe(true)
  })

  it('the dash-delimited slug form tokenizes the same as the slash form', () => {
    const { token, digest } = freshTokenAndDigest(10)
    const files = [{ path: `-Users-${token}-dev-shoresh`, content: 'x' }]
    const findings = scanPrivacy(files, new Set([digest]))
    expect(findings.some((f) => f.pattern === 'identity-token')).toBe(true)
  })

  it('flags an email address', () => {
    const files = [{ path: 'docs/x.md', content: 'contact person@realdomain.com for access' }]
    expect(scanPrivacy(files).some((f) => f.pattern === 'email')).toBe(true)
  })

  it('flags a phone number', () => {
    const files = [{ path: 'docs/x.md', content: 'call (555) 123-4567' }]
    expect(scanPrivacy(files).some((f) => f.pattern === 'phone')).toBe(true)
    const files2 = [{ path: 'docs/x.md', content: 'call 555-123-4567' }]
    expect(scanPrivacy(files2).some((f) => f.pattern === 'phone')).toBe(true)
  })

  it('does not flag package-lock.json content containing an email', () => {
    const files = [{ path: 'package-lock.json', content: '"author": "someone@realdomain.com"' }]
    expect(scanPrivacy(files)).toEqual([])
  })

  it('does not flag electron/third-party-licenses.json content containing an email', () => {
    const files = [{ path: 'electron/third-party-licenses.json', content: '"author": "someone@realdomain.com"' }]
    expect(scanPrivacy(files)).toEqual([])
  })

  it('does not flag a placeholder home path (/Users/x/dev/shoresh)', () => {
    const files = [{ path: 'docs/x.md', content: '/Users/x/dev/shoresh' }]
    expect(scanPrivacy(files).some((f) => f.pattern === 'home-path')).toBe(false)
  })

  it('does not flag fetched-pkg@1.0.0.json as an email', () => {
    const files = [{ path: 'scripts/generate-licenses.test.js', content: "'fetched-pkg@1.0.0.json'" }]
    expect(scanPrivacy(files).some((f) => f.pattern === 'email')).toBe(false)
  })

  it('does not flag allowlisted non-PII addresses', () => {
    const files = [{ path: 'docs/x.md', content: 'git@github.com and noreply@anthropic.com and you@example.com' }]
    expect(scanPrivacy(files).some((f) => f.pattern === 'email')).toBe(false)
  })

  it('honours the allow marker on a content line', () => {
    const files = [{ path: 'docs/x.md', content: 'contact person@realdomain.com // security-gate:allow' }]
    expect(scanPrivacy(files).some((f) => f.pattern === 'email')).toBe(false)
  })
})
