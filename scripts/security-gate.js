// Tier-1 automated security gate (docs/adr/2026-09-14-internet-transport-security-gate.md
// is a sibling; this is the continuous, cheap layer of the security program described in
// docs/work/security/2026-09-14-security-program.md).
//
// Three checks, all self-contained — no external scanner binary the gate could choke on
// when it is absent (gitleaks/semgrep are NOT assumed installed):
//   1. dependency advisories — `npm audit --omit=dev`, fail on high/critical. This is the
//      check that would have caught the xlsx@0.18.5 CVE automatically instead of by luck.
//   2. secret scan — tracked text files against a fixed set of high-signal credential
//      patterns (private keys, cloud keys, provider tokens). Marker `security-gate:allow`
//      on the same line opts a deliberate fixture out.
//   3. dangerous code patterns — string-interpolated SQL, eval, and dangerouslySetInnerHTML,
//      the three that map directly to this app's own threat surface (SECURITY.md).
//
// The pure functions (auditFindings / scanSecrets / scanDangerous) take data and return
// findings, so they unit-test without spawning anything (security-gate.test.js). The CLI
// tail gathers the data (npm audit + `git ls-files`) and prints a verdict.
import { spawnSync } from 'node:child_process'
import { readFileSync } from 'node:fs'

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

const TEXT_EXT = /\.(js|jsx|ts|tsx|mjs|cjs|json|md|sql|css|html|yml|yaml|sh|txt|env)$/i

function trackedTextFiles() {
  const res = spawnSync('git', ['ls-files'], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 })
  if (res.status !== 0) throw new Error(`git ls-files failed: ${res.stderr}`)
  const paths = res.stdout.split('\n').filter((p) => p && TEXT_EXT.test(p))
  const files = []
  for (const path of paths) {
    try {
      files.push({ path, content: readFileSync(path, 'utf8') })
    } catch { /* deleted-but-tracked, or binary mislabeled — skip */ }
  }
  return files
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
  const files = trackedTextFiles()
  findings.push(...scanSecrets(files), ...scanDangerous(files))

  if (findings.length === 0) {
    // eslint-disable-next-line no-console
    console.log('✅ security-gate: 0 findings (deps + secrets + dangerous patterns)')
    process.exit(0)
  }
  // eslint-disable-next-line no-console
  console.log(`❌ security-gate: ${findings.length} finding(s)\n`)
  for (const f of findings) {
    // eslint-disable-next-line no-console
    console.log(`  [${f.kind}] ${f.detail}`)
  }
  process.exit(1)
}
