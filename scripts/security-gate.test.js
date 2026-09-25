import { describe, it, expect } from 'vitest'
import { createHash, randomBytes } from 'node:crypto'
import { auditFindings, scanSecrets, scanDangerous, scanPrivacy, FAILING_SEVERITIES, TEXT_EXT } from './security-gate.js'

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

  // Fix 1 — ReDoS in EMAIL_RE. The old combined regex overlapped its own quantifiers
  // ([A-Za-z0-9.-]+ then \.[A-Za-z]{2,}) and backtracked catastrophically on a long
  // domain-shaped run with no valid TLD to terminate on.
  it('does not catastrophically backtrack on an adversarial email-shaped line', () => {
    const adversarial = 'a@' + 'a'.repeat(40000) + '!'
    const files = [{ path: 'docs/x.md', content: adversarial }]
    const start = Date.now()
    scanPrivacy(files)
    expect(Date.now() - start).toBeLessThan(500)
  })

  it('stays fast on a long line combining home-path and identity-token shapes', () => {
    const { digest } = freshTokenAndDigest(10)
    const adversarial = '/Users/' + 'a'.repeat(20000) + ' ' + 'b'.repeat(20000)
    const files = [{ path: 'docs/x.md', content: adversarial }]
    const start = Date.now()
    scanPrivacy(files, new Set([digest]))
    expect(Date.now() - start).toBeLessThan(500)
  })

  // Fix 2 — the guard must scan the PATH of every tracked file, even when content is
  // unreadable/binary (content: null), and must content-scan csv/tsv.
  it('scans the PATH of a file even when content is null (binary/unreadable)', () => {
    const { token, digest } = freshTokenAndDigest(5)
    const files = [{ path: `assets/camp-${token}.png`, content: null }]
    const findings = scanPrivacy(files, new Set([digest]))
    expect(findings.some((f) => f.pattern === 'identity-token' && f.line === null)).toBe(true)
  })

  it('path-scans a .csv and a .png path alike', () => {
    const { token, digest } = freshTokenAndDigest(10)
    const files = [
      { path: `data/${token}-roster.csv`, content: 'a,b,c' },
      { path: `images/${token}-logo.png`, content: null },
    ]
    const findings = scanPrivacy(files, new Set([digest]))
    const paths = findings.filter((f) => f.pattern === 'identity-token').map((f) => f.path)
    expect(paths).toEqual(expect.arrayContaining([`data/${token}-roster.csv`, `images/${token}-logo.png`]))
  })

  it('content-scans a .csv file', () => {
    const { token, digest } = freshTokenAndDigest(10)
    const files = [{ path: 'data/roster.csv', content: `name,camp\nkid,${token}` }]
    const findings = scanPrivacy(files, new Set([digest]))
    expect(findings.some((f) => f.pattern === 'identity-token' && f.path === 'data/roster.csv' && f.line === 2)).toBe(true)
  })

  it('TEXT_EXT includes csv and tsv, excludes image/binary formats', () => {
    expect(TEXT_EXT.test('data/roster.csv')).toBe(true)
    expect(TEXT_EXT.test('data/roster.tsv')).toBe(true)
    expect(TEXT_EXT.test('images/logo.png')).toBe(false)
    expect(TEXT_EXT.test('docs/spec.docx')).toBe(false)
  })

  // Fix 3 — the tokenizer misses suffix/prefix/CamelCase forms of the identity token.
  it('flags a plural suffix form (<token>s)', () => {
    const { token, digest } = freshTokenAndDigest(5)
    const files = [{ path: 'docs/x.md', content: `the ${token}s program` }]
    expect(scanPrivacy(files, new Set([digest])).some((f) => f.pattern === 'identity-token')).toBe(true)
  })

  it('flags a prefixed form (x<token>)', () => {
    const { token, digest } = freshTokenAndDigest(5)
    const files = [{ path: 'docs/x.md', content: `see x${token} here` }]
    expect(scanPrivacy(files, new Set([digest])).some((f) => f.pattern === 'identity-token')).toBe(true)
  })

  it('flags CamelCase concatenation (Camp<Token>Spec)', () => {
    const { token, digest } = freshTokenAndDigest(5)
    const capitalized = token[0].toUpperCase() + token.slice(1)
    const files = [{ path: 'docs/x.md', content: `class Camp${capitalized}Spec {}` }]
    expect(scanPrivacy(files, new Set([digest])).some((f) => f.pattern === 'identity-token')).toBe(true)
  })

  it('does not catch an infix with no case/non-letter boundary on either side (knowingly not caught)', () => {
    const { token, digest } = freshTokenAndDigest(5)
    const files = [{ path: 'docs/x.md', content: `xx${token}yy` }]
    expect(scanPrivacy(files, new Set([digest])).some((f) => f.pattern === 'identity-token')).toBe(false)
  })

  it('the suffix/prefix window check stays cheap (perf sanity, not a hard budget)', () => {
    const { digest } = freshTokenAndDigest(10)
    const big = Array.from({ length: 2000 }, (_, i) => `word${i}Suffixed and word${i}`).join(' ')
    const files = [{ path: 'docs/x.md', content: big }]
    const start = Date.now()
    scanPrivacy(files, new Set([digest]))
    expect(Date.now() - start).toBeLessThan(500)
  })

  // Fix 4 — IDENTITY_TOKEN_LENGTHS and IDENTITY_TOKEN_DIGESTS must move in lockstep;
  // a length outside the set is a documented, knowing gap, not an accidental miss.
  it('a token whose length is outside IDENTITY_TOKEN_LENGTHS is knowingly not caught (documents the coupling)', () => {
    const { token, digest } = freshTokenAndDigest(7)
    const files = [{ path: 'docs/x.md', content: `about ${token} today` }]
    expect(scanPrivacy(files, new Set([digest])).some((f) => f.pattern === 'identity-token')).toBe(false)
  })
})
