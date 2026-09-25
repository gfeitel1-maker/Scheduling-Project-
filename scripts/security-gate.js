// Tier-1 automated security gate (docs/adr/2026-09-14-internet-transport-security-gate.md
// is a sibling; this is the continuous, cheap layer of the security program described in
// docs/work/security/2026-09-14-security-program.md).
//
// Four checks, all self-contained — no external scanner binary the gate could choke on
// when it is absent (gitleaks/semgrep are NOT assumed installed):
//   1. dependency advisories — `npm audit --omit=dev`, fail on high/critical. This is the
//      check that would have caught the xlsx@0.18.5 CVE automatically instead of by luck.
//   2. secret scan — tracked text files against a fixed set of high-signal credential
//      patterns (private keys, cloud keys, provider tokens). Marker `security-gate:allow`
//      on the same line opts a deliberate fixture out.
//   3. dangerous code patterns — string-interpolated SQL, eval, and dangerouslySetInnerHTML,
//      the three that map directly to this app's own threat surface (SECURITY.md).
//   4. privacy scan (T263) — absolute home paths, hashed identity tokens (camp name +
//      developer username), and PII shapes (email/phone), across both file CONTENTS and
//      PATHS. Precondition for making this repository public: everything in tracked files
//      is about to be published, and every future commit publishes live.
//
// SCOPE OF `security-gate:allow` — stated because omitting it actively misled someone (2026-09-17).
// The marker is honoured by the SECRET scan (2), the DANGEROUS-PATTERN scan (3), and the
// PRIVACY scan (4)'s CONTENT findings ONLY. `auditFindings` (1) has NO allowlist of any kind: a
// high/critical advisory cannot be excepted, annotated, or deferred here, and the only way to a
// green gate is to fix the dependency. The privacy scan's PATH findings (4) also have no marker
// escape hatch, deliberately — see scanPrivacy below. Describing the marker without its scope
// read as "advisories can be excepted too", and a session went looking for how to do that during
// the GHSA-vrf4-mx87-p53w response. A mechanism documented without its limits invites exactly
// that misreading — the same rule the boundary guards follow when they state their own blind
// spots.
//
// The pure functions (auditFindings / scanSecrets / scanDangerous / scanPrivacy) take data and
// return findings, so they unit-test without spawning anything (security-gate.test.js). The CLI
// tail gathers the data (npm audit + `git ls-files`) and prints a verdict.
import { spawnSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { createHash } from 'node:crypto'

const ALLOW = 'security-gate:allow'

// ── 1. Dependency advisories ────────────────────────────────────────────────
// `npm audit --json` shape: { vulnerabilities: { <name>: { severity, via: [...] } }, ... }.
// We fail on any advisory of severity high or critical. Moderate/low are reported as notes
// but do not fail — tunable here, deliberately, so the gate's teeth match the threat model.
export const FAILING_SEVERITIES = new Set(['high', 'critical'])

export function auditFindings(auditJson) {
  const vulns = auditJson?.vulnerabilities ?? {}
  const findings = []
  for (const [name, v] of Object.entries(vulns)) {
    if (FAILING_SEVERITIES.has(v?.severity)) {
      findings.push({ kind: 'dependency', severity: v.severity, name,
        detail: `${name}: ${v.severity} advisory (npm audit) — run \`npm audit\` for the chain` })
    }
  }
  return findings
}

// ── 2. Secret scan ───────────────────────────────────────────────────────────
export const SECRET_PATTERNS = [
  { name: 'private-key-block', re: /-----BEGIN (?:RSA |EC |OPENSSH |PGP )?PRIVATE KEY-----/ },
  { name: 'aws-access-key-id', re: /\bAKIA[0-9A-Z]{16}\b/ },
  { name: 'github-token', re: /\bghp_[A-Za-z0-9]{36}\b/ },
  { name: 'slack-token', re: /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/ },
  { name: 'generic-api-key-assignment',
    re: /\b(?:api[_-]?key|secret|token|password|passwd)\b\s*[:=]\s*['"][A-Za-z0-9/+_-]{24,}['"]/i },
]

// files: [{ path, content }]. Returns one finding per matched line (skips lines carrying the
// ALLOW marker, and skips the two files that legitimately CONTAIN these patterns as source).
export function scanSecrets(files) {
  const findings = []
  const selfFiles = new Set(['scripts/security-gate.js', 'scripts/security-gate.test.js'])
  for (const { path, content } of files) {
    if (selfFiles.has(path)) continue
    const lines = content.split('\n')
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i]
      if (line.includes(ALLOW)) continue
      for (const { name, re } of SECRET_PATTERNS) {
        if (re.test(line)) {
          findings.push({ kind: 'secret', pattern: name, path, line: i + 1,
            detail: `${path}:${i + 1} — possible ${name}. If intentional (a test fixture), append \`// ${ALLOW}\` to the line.` })
        }
      }
    }
  }
  return findings
}

// ── 3. Dangerous code patterns ─────────────────────────────────────────────
// Narrow on purpose: only the sinks this app's threat model names, scanned in CODE files
// only (see CODE_EXT in the CLI — a doc that says "static eval" is not a call). Each rule
// carries an ALLOW escape hatch for a reviewed, deliberate exception.
//
// SQL injection is deliberately NOT one of these rules. Deciding whether an interpolated value
// is attacker-controlled needs data-flow analysis a regex cannot do, and this app interpolates
// schema identifiers (table/column/field names known at authoring time) pervasively and by
// design — a regex flags ~100 of those, all safe, and a gate with 100 false positives gets
// blanket-allowed and becomes worse than no gate. SQL review is the Security agent's job
// (`.claude/agents/security.md` "Always check" → SQL injection), where the data flow is
// actually traced. This automated layer keeps only the checks a regex does RELIABLY.
export const DANGEROUS_PATTERNS = [
  { name: 'eval', appliesTo: () => true, re: (line) => /(?:^|[^.\w])eval\s*\(/.test(line) },
  { name: 'dangerouslySetInnerHTML', appliesTo: (p) => /\.(jsx?|tsx?)$/.test(p),
    re: (line) => /dangerouslySetInnerHTML/.test(line) },
]

// Dangerous-pattern scanning is CODE-only: a doc or a JSON blob is data, not a call site.
export const CODE_EXT = /\.(js|jsx|ts|tsx|mjs|cjs)$/i

export function scanDangerous(files) {
  const findings = []
  const selfFiles = new Set(['scripts/security-gate.js', 'scripts/security-gate.test.js'])
  for (const { path, content } of files) {
    if (selfFiles.has(path)) continue
    if (!CODE_EXT.test(path)) continue
    const lines = content.split('\n')
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i]
      if (line.includes(ALLOW)) continue
      for (const { name, re, appliesTo } of DANGEROUS_PATTERNS) {
        if (appliesTo(path) && re(line)) {
          findings.push({ kind: 'dangerous', pattern: name, path, line: i + 1,
            detail: `${path}:${i + 1} — ${name}. If reviewed and intentional, append \`// ${ALLOW}\` to the line.` })
        }
      }
    }
  }
  return findings
}

// ── 4. Privacy scan (T263) ──────────────────────────────────────────────────
// Files that legitimately carry the patterns below — third-party metadata (npm package
// authors' emails, bundled license texts) or fixtures for this check's own tests. The
// ticket's own list (package-lock.json, this file's test, test/fuzz/**) measured short by
// three: electron/license-texts/**, electron/third-party-licenses.json and the single file
// electron/third-party-licenses.html (not ".html" files in general — only this one path is
// exempt) carry 40+ upstream-author addresses from bundled license text and are exempted here too.
const PRIVACY_EXEMPT_FILES = new Set([
  'package-lock.json',
  'scripts/security-gate.js',
  'scripts/security-gate.test.js',
  'electron/third-party-licenses.json',
  'electron/third-party-licenses.html',
])
const PRIVACY_EXEMPT_PREFIXES = ['test/fuzz/', 'electron/license-texts/']

function isPrivacyExempt(path) {
  if (PRIVACY_EXEMPT_FILES.has(path)) return true
  return PRIVACY_EXEMPT_PREFIXES.some((p) => path.startsWith(p))
}

// Rule 2 — hashed identity tokens (camp name + developer macOS username). The guard must
// never hold either in plaintext: a denylist written into this file would itself be the leak,
// committed and published. These are SHA-256 digests of the two lowercased tokens.
//
// HONEST LIMITATION: a SHA-256 of a short lowercase word is trivially brute-forced from a
// wordlist, so this digest is NOT a secret and this is NOT confidentiality. It prevents the
// string being present, greppable, and search-indexed in a public repo — that is the actual
// goal, and no stronger claim is made.
//
// COUPLING (Fix 4): IDENTITY_TOKEN_DIGESTS and IDENTITY_TOKEN_LENGTHS must change together.
// A digest here of a plaintext length not present in IDENTITY_TOKEN_LENGTHS is filtered out
// before it is ever hashed — the check silently becomes a no-op for that digest. Adding a
// digest REQUIRES adding its plaintext length below, in the same change.
export const IDENTITY_TOKEN_DIGESTS = new Set([
  '2a123e7bdd96337aef54d45a21c2a25a61a3fe8f96cee351751dc47c47b6f5bf',
  'f95c3e4db9977fccda1aee1dcf25f6f4452d4e2c399e2f622db36626dc14e443',
])
// Plaintext token lengths (not digest lengths) the two identity tokens are known to have.
// Restricting candidates to these lengths before hashing is what keeps this check cheap:
// we hash only the unique short/mid-length tokens a file actually contains, not every token.
// COUPLING (Fix 4): see IDENTITY_TOKEN_DIGESTS above — a length omitted here means any digest
// of that length silently never matches. Keep the two in lockstep.
const IDENTITY_TOKEN_LENGTHS = new Set([5, 10])

// Splits on non-letter runs AND on a lower/digit → upper case transition, so CamelCase
// concatenation ("CampTokenSpec") separates into its parts the way a human reads it.
function tokenize(str) {
  return str.replace(/([a-z0-9])([A-Z])/g, '$1 $2').toLowerCase().split(/[^a-z]+/).filter(Boolean)
}

// Candidate identity tokens for a string: every base token (case/non-letter split) at a
// known length, PLUS the prefix/suffix window of each known length for a longer token — so
// a plural/possessive/adjectival suffix with no separator ("<token>s") or a prefix with no
// separator ("x<token>") still surfaces the bare token. Cheap on purpose: at most two extra
// substrings per base token per known length, not a sliding window over every position.
// HONEST BLIND SPOT: an infix with no case or non-letter boundary on EITHER side
// ("xx<token>yy") is still missed — neither a prefix nor a suffix window lands on it.
function identityCandidates(str) {
  const candidates = new Set()
  for (const tok of tokenize(str)) {
    if (IDENTITY_TOKEN_LENGTHS.has(tok.length)) candidates.add(tok)
    for (const len of IDENTITY_TOKEN_LENGTHS) {
      if (tok.length > len) {
        candidates.add(tok.slice(0, len))
        candidates.add(tok.slice(-len))
      }
    }
  }
  return candidates
}

function sha256(str) {
  return createHash('sha256').update(str).digest('hex')
}

// Rule 1 — absolute home paths, generic by SHAPE (not a denylist of one username), so a
// different machine's path is caught too. A placeholder allowlist keeps synthetic fixtures
// (`/Users/x`, `/home/user`) from firing — this is still shape-generic, not a real-username
// denylist, since nobody can choose their real account name to BE one of these placeholders.
// HONEST BLIND SPOT: a real account literally named one of these placeholders (e.g. an account
// named "test") would pass uncaught.
const HOME_PATH_PLACEHOLDERS = new Set([
  'x', 'y', 'u', 'user', 'users', 'someone', 'test', 'me', 'name',
  'alice', 'bob', 'foo', 'bar', '<user>', '$user', '$home', '~',
])
const HOME_PATH_RE = /\/(?:Users|home)\/([^/\s'"]+)/g

// Rule 3 — PII shapes. Email: the label immediately before the TLD must contain a letter, so
// `fetched-pkg@1.0.0.json` (a real filename in scripts/generate-licenses.test.js) does not
// match — its label-before-TLD is "0", all digits. Allowlisted by shape: placeholder domains
// and non-PII local-parts this repo legitimately carries (git@github.com, noreply@anthropic.com).
//
// Fix 1 (ReDoS): a single combined regex `[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}` lets
// the domain class `[A-Za-z0-9.-]+` overlap the following `\.[A-Za-z]{2,}`, so on a long
// domain-shaped run with no valid ending the engine backtracks catastrophically. Replaced with
// a linear scan: find each `@`, expand the local part left and the domain run right by
// character class (no ambiguity — a single class, no overlap), then locate the TLD ending
// inside that already-bounded domain run with a small non-overlapping regex.
const LOCAL_CHAR_RE = /[A-Za-z0-9._%+-]/
const DOMAIN_CHAR_RE = /[A-Za-z0-9.-]/
const TLD_RE = /\.[A-Za-z]{2,}/g
const EMAIL_ALLOW_DOMAINS = /@(?:example\.com|example\.org|example\.net|localhost)\b/i
const EMAIL_ALLOW_LOCALPARTS = /^(?:noreply|no-reply|git)@/i

// Finds email-shaped substrings in `line` without backtracking: '@' can only be preceded/
// followed by bounded character-class runs, so total work is linear in line length.
function findEmailCandidates(line) {
  const matches = []
  for (let i = 0; i < line.length; i++) {
    if (line[i] !== '@') continue
    if (i === 0 || !LOCAL_CHAR_RE.test(line[i - 1])) continue
    let start = i
    while (start > 0 && LOCAL_CHAR_RE.test(line[start - 1])) start--
    let domainEnd = i + 1
    while (domainEnd < line.length && DOMAIN_CHAR_RE.test(line[domainEnd])) domainEnd++
    const domainRun = line.slice(i + 1, domainEnd)
    TLD_RE.lastIndex = 0
    let tldMatch
    let lastTld = null
    while ((tldMatch = TLD_RE.exec(domainRun))) lastTld = tldMatch
    if (!lastTld) continue
    const domain = domainRun.slice(0, lastTld.index + lastTld[0].length)
    matches.push(line.slice(start, i + 1) + domain)
  }
  return matches
}

function isPlausibleEmail(match) {
  const domain = match.slice(match.indexOf('@') + 1)
  const parts = domain.split('.')
  if (parts.length < 2) return false
  return /[a-z]/i.test(parts[parts.length - 2])
}

function isAllowedEmail(match) {
  return EMAIL_ALLOW_DOMAINS.test(match) || EMAIL_ALLOW_LOCALPARTS.test(match)
}

// Phone: kept tight on purpose. Measured zero matches in the current tree with this shape;
// a looser pattern fires on version strings and hashes instead.
const PHONE_RES = [/\(\d{3}\)\s\d{3}-\d{4}/, /\b\d{3}[-. ]\d{3}[-. ]\d{4}\b/]

// files: [{ path, content }], where content may be null/absent — a path-only entry still
// gets Rule 2's path check (Fix 2: every tracked file's PATH is scanned regardless of
// whether its content is text-shaped or was even read). digests is injectable so tests can
// prove the hashed-identity mechanism with a freshly generated token instead of the real
// plaintext.
export function scanPrivacy(files, digests = IDENTITY_TOKEN_DIGESTS) {
  const findings = []
  for (const { path, content } of files) {
    if (isPrivacyExempt(path)) continue

    // Rule 2, path — no line number, and deliberately NO allow-marker escape hatch: a
    // sensitive filename must be renamed, not annotated. Runs regardless of content.
    const pathTokens = identityCandidates(path)
    for (const t of pathTokens) {
      if (digests.has(sha256(t))) {
        findings.push({ kind: 'privacy', pattern: 'identity-token', path, line: null,
          detail: `${path} — filename contains a hashed identity token. Rename the file; there is no allow-marker escape for path findings.` })
        break
      }
    }

    // RESIDUAL BLIND SPOT (Fix 2): a binary/opaque format (.xlsx, .docx, .pdf, images,
    // .sqlite) has content: null here — only its PATH was checked above. Its CONTENTS are
    // never scanned; extracting text from those formats is explicitly out of scope.
    if (content == null) continue
    const lines = content.split('\n')

    // Rule 2, content — build the unique candidate set once per file, hash only those, and
    // only if one matches do a second pass to locate the offending line(s).
    const contentCandidates = identityCandidates(content)
    const matchedTokens = new Set()
    for (const t of contentCandidates) {
      if (digests.has(sha256(t))) matchedTokens.add(t)
    }

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i]
      const allowed = line.includes(ALLOW)

      if (!allowed && matchedTokens.size > 0) {
        const lineTokens = identityCandidates(line)
        if ([...lineTokens].some((t) => matchedTokens.has(t))) {
          findings.push({ kind: 'privacy', pattern: 'identity-token', path, line: i + 1,
            detail: `${path}:${i + 1} — hashed identity token present in content. If intentional (a test fixture), append \`// ${ALLOW}\` to the line.` })
        }
      }
      if (allowed) continue

      // Rule 1 — home path
      HOME_PATH_RE.lastIndex = 0
      let hp
      while ((hp = HOME_PATH_RE.exec(line))) {
        // Strip wrapping punctuation (`<name>`, trailing `:`/`…`) before comparing against the
        // placeholder set, so meta-notation in prose (`/Users/<someone>/dev/shoresh`) reads as
        // its bare word. A segment with no identifier-shaped core left (e.g. a bare "…" elision)
        // has nothing to flag.
        const core = hp[1].replace(/^[^A-Za-z0-9$~]+/, '').replace(/[^A-Za-z0-9$~]+$/, '')
        if (core && !HOME_PATH_PLACEHOLDERS.has(core.toLowerCase())) {
          findings.push({ kind: 'privacy', pattern: 'home-path', path, line: i + 1,
            detail: `${path}:${i + 1} — absolute home path. If intentional (a test fixture), append \`// ${ALLOW}\` to the line.` })
        }
      }

      // Rule 3 — email
      for (const match of findEmailCandidates(line)) {
        if (!isPlausibleEmail(match) || isAllowedEmail(match)) continue
        findings.push({ kind: 'privacy', pattern: 'email', path, line: i + 1,
          detail: `${path}:${i + 1} — possible email address. If intentional (a test fixture), append \`// ${ALLOW}\` to the line.` })
      }

      // Rule 3 — phone
      if (PHONE_RES.some((re) => re.test(line))) {
        findings.push({ kind: 'privacy', pattern: 'phone', path, line: i + 1,
          detail: `${path}:${i + 1} — possible phone number. If intentional (a test fixture), append \`// ${ALLOW}\` to the line.` })
      }
    }
  }
  return findings
}

// ── CLI plumbing (impure) ─────────────────────────────────────────────────
function runAudit() {
  const res = spawnSync('npm', ['audit', '--omit=dev', '--json'], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 })
  // npm audit exits non-zero WHEN vulnerabilities exist; that is not a tool failure, so we
  // parse stdout regardless of exit code. A genuine tool failure yields unparseable output.
  try {
    return JSON.parse(res.stdout)
  } catch {
    throw new Error(`npm audit produced no parseable JSON (exit ${res.status}): ${(res.stderr || '').slice(0, 400)}`)
  }
}

// Text-shaped extensions whose CONTENT gets read and scanned. csv/tsv added (Fix 2) — this
// repo's ingestion workflow writes plain-text data files into docs/ under these extensions.
// Any tracked path NOT matching this (images, .xlsx/.docx/.pdf/.sqlite, etc.) still gets its
// PATH scanned by trackedFiles() below — only its content is skipped.
export const TEXT_EXT = /\.(js|jsx|ts|tsx|mjs|cjs|json|md|sql|css|html|yml|yaml|sh|txt|env|csv|tsv)$/i

// Every tracked file, content included only when it is text-shaped (TEXT_EXT) and readable.
// A binary/opaque file, or a text-shaped file that fails to read (deleted-but-tracked), comes
// back with content: null — scanPrivacy still scans its PATH; scanSecrets/scanDangerous need
// real content and skip null entries entirely (see call sites below).
function trackedFiles() {
  const res = spawnSync('git', ['ls-files'], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 })
  if (res.status !== 0) throw new Error(`git ls-files failed: ${res.stderr}`)
  const paths = res.stdout.split('\n').filter(Boolean)
  const files = []
  let unreadable = 0
  for (const path of paths) {
    if (!TEXT_EXT.test(path)) {
      files.push({ path, content: null })
      continue
    }
    try {
      files.push({ path, content: readFileSync(path, 'utf8') })
    } catch {
      // deleted-but-tracked, or a text extension whose actual bytes aren't readable as utf8
      files.push({ path, content: null })
      unreadable++
    }
  }
  return { files, unreadable }
}

const invokedDirectly =
  process.argv[1] && process.argv[1].replace(/\\/g, '/').endsWith('scripts/security-gate.js')
if (invokedDirectly) {
  const findings = []
  try {
    findings.push(...auditFindings(runAudit()))
  } catch (e) {
    // eslint-disable-next-line no-console
    console.error(`security-gate: dependency audit could not run — ${e.message}`)
    process.exit(2)
  }
  const { files, unreadable } = trackedFiles()
  const textFiles = files.filter((f) => f.content != null)
  findings.push(...scanSecrets(textFiles), ...scanDangerous(textFiles), ...scanPrivacy(files))

  // Fix 5: "0 findings" must be distinguishable from "never read the file" — print how many
  // tracked files this run could not read, so a green verdict isn't silently vacuous.
  const unreadableNote = unreadable > 0 ? `, ${unreadable} file(s) unreadable and skipped` : ''

  if (findings.length === 0) {
    // eslint-disable-next-line no-console
    console.log(`✅ security-gate: 0 findings (deps + secrets + dangerous patterns + privacy)${unreadableNote}`)
    process.exit(0)
  }
  // eslint-disable-next-line no-console
  console.log(`❌ security-gate: ${findings.length} finding(s)${unreadableNote}\n`)
  for (const f of findings) {
    // eslint-disable-next-line no-console
    console.log(`  [${f.kind}] ${f.detail}`)
  }
  process.exit(1)
}
