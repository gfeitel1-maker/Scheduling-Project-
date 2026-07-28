import { describe, it, expect } from 'vitest'
import { readFileSync, readdirSync, existsSync, statSync } from 'node:fs'
import { join, dirname, resolve, relative, basename } from 'node:path'
import { fileURLToPath } from 'node:url'

// Deterministic governance safeguards.
//
// Every check here replaces a manual review step that has already failed at
// least once on this project. The Supabase import ban (eslint.supabase-ban.test.js)
// held for weeks while the Supabase *guidance* in .claude/agents/security.md rotted
// undetected — because code had a test and documents didn't. This file is that test.
//
// Per docs/governance/constitution/CONSTITUTION.md Art. II rule 1: evidence
// outranks consensus. A governance rule nobody can mechanically check is a
// preference, not a rule.

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const p = (...s) => join(ROOT, ...s)

function walk(dir, out = []) {
  if (!existsSync(dir)) return out
  for (const e of readdirSync(dir)) {
    const full = join(dir, e)
    if (statSync(full).isDirectory()) walk(full, out)
    else if (e.endsWith('.md')) out.push(full)
  }
  return out
}

const rel = (f) => relative(ROOT, f)
const read = (f) => readFileSync(f, 'utf8')

const AGENT_DIR = p('.claude', 'agents')
const agentFiles = readdirSync(AGENT_DIR).filter((f) => f.endsWith('.md')).map((f) => join(AGENT_DIR, f))

// Documents that carry current authority or describe current reality.
const ACTIVE_DOCS = [
  ...agentFiles,
  ...walk(p('docs', 'governance', 'constitution')),
  ...walk(p('docs', 'governance', 'standards')),
  ...walk(p('docs', 'governance', 'references')),
  p('docs', 'governance', 'GOVERNANCE_INDEX.md'),
  ...walk(p('docs', 'work')),
  ...walk(p('docs', 'current')),
  ...walk(p('docs', 'adr')),
  p('CLAUDE.md'),
  p('README.md'),
  p('SECURITY.md'),
].filter(existsSync)

const ARCHIVED_DOCS = walk(p('docs', 'archive'))

function frontmatter(text) {
  if (!text.startsWith('---\n')) return null
  const end = text.indexOf('\n---', 4)
  if (end === -1) return null
  const out = {}
  for (const line of text.slice(4, end).split('\n')) {
    const m = /^([a-z_]+):\s*(.*)$/.exec(line)
    if (m) out[m[1]] = m[2].trim()
  }
  return out
}

describe('agent roster integrity', () => {
  it('every agent name: matches its filename', () => {
    const mismatches = agentFiles
      .map((f) => ({ file: basename(f, '.md'), name: frontmatter(read(f))?.name }))
      .filter(({ file, name }) => name !== file)
    expect(mismatches).toEqual([])
  })

  it('the constitution roster matches the agents on disk exactly', () => {
    const onDisk = agentFiles.map((f) => basename(f, '.md')).sort()
    const constitution = read(p('docs', 'governance', 'constitution', 'CONSTITUTION.md'))
    const section = constitution.slice(constitution.indexOf('## Article VI'))
    const missing = onDisk.filter((a) => {
      const label = a.replace(/-/g, ' ')
      return !new RegExp(`\\*\\*${label}\\*\\*`, 'i').test(section)
    })
    expect(missing).toEqual([])
  })

  it('every agent referenced by Governor resolves to a real file', () => {
    const governor = read(p('.claude', 'agents', 'governor.md'))
    const refs = [...governor.matchAll(/`(\.claude\/agents\/[a-z-]+\.md)`/g)].map((m) => m[1])
    expect(refs.length).toBeGreaterThan(0)
    expect(refs.filter((r) => !existsSync(p(r)))).toEqual([])
  })
})

describe('link integrity', () => {
  it('every relative markdown link in an active document resolves', () => {
    const broken = []
    for (const f of ACTIVE_DOCS) {
      for (const m of read(f).matchAll(/\]\(([^)]+)\)/g)) {
        const target = m[1].split('#')[0]
        if (!target || /^(https?|mailto):/.test(target)) continue
        if (!existsSync(resolve(dirname(f), target))) broken.push(`${rel(f)} -> ${target}`)
      }
    }
    expect(broken).toEqual([])
  })

  it('CLAUDE.md routes into the governance index', () => {
    expect(read(p('CLAUDE.md'))).toContain('docs/governance/GOVERNANCE_INDEX.md')
  })

  it('the governance index links to every standard that exists', () => {
    const index = read(p('docs', 'governance', 'GOVERNANCE_INDEX.md'))
    const unlisted = readdirSync(p('docs', 'governance', 'standards'))
      .filter((f) => f.endsWith('.md') && !index.includes(f))
    expect(unlisted).toEqual([])
  })
})

describe('required metadata', () => {
  it('every governance and work document declares document_type and status', () => {
    const targets = [
      ...walk(p('docs', 'governance', 'constitution')),
      ...walk(p('docs', 'governance', 'standards')),
      p('docs', 'governance', 'GOVERNANCE_INDEX.md'),
      ...walk(p('docs', 'work')),
      ...walk(p('docs', 'adr')),
    ].filter(existsSync)
    const bad = targets.filter((f) => {
      const fm = frontmatter(read(f))
      return !fm || !fm.document_type || !(fm.status || fm.risk)
    })
    expect(bad.map(rel)).toEqual([])
  })

  it('every active spec and ticket names its governing documents', () => {
    const targets = [...walk(p('docs', 'work', 'specs')), ...walk(p('docs', 'work', 'tickets'))]
    const bad = targets.filter((f) => {
      const fm = frontmatter(read(f))
      if (!fm) return true
      if (fm.status === 'completed') return false
      return !fm.governing_docs && !fm.parent_spec
    })
    expect(bad.map(rel)).toEqual([])
  })

  it('every governing_docs path points at a real file', () => {
    const broken = []
    for (const f of walk(p('docs', 'work'))) {
      const fm = frontmatter(read(f))
      const raw = fm?.governing_docs
      if (!raw) continue
      for (const d of raw.replace(/[[\]]/g, '').split(',').map((s) => s.trim()).filter(Boolean)) {
        if (!existsSync(p(d))) broken.push(`${rel(f)} -> ${d}`)
      }
    }
    expect(broken).toEqual([])
  })
})

describe('retired technology stays retired', () => {
  // These identifiers belong exclusively to the retired Supabase backend.
  // Their presence in an ACTIVE governing document means that document is
  // instructing an agent to reason about an architecture that no longer exists —
  // the exact defect that sat in .claude/agents/security.md undetected.
  const FORBIDDEN = [/get_my_camp_id/i, /service[_ -]?role/i, /anon key/i, /\bRLS\b(?! means)/]
  const RETIREMENT_CONTEXT = /\b(no|not|never|retired|removed|archiv|legacy|historical|ban|superseded|deprecated|former|old|era|previously)\b/i

  it('no active governing document prescribes a retired mechanism', () => {
    const hits = []
    for (const f of ACTIVE_DOCS) {
      read(f).split('\n').forEach((line, i) => {
        if (RETIREMENT_CONTEXT.test(line)) return
        if (FORBIDDEN.some((re) => re.test(line))) hits.push(`${rel(f)}:${i + 1} ${line.trim().slice(0, 90)}`)
      })
    }
    expect(hits).toEqual([])
  })

  it('no active governing document points into the archive as current guidance', () => {
    const hits = []
    for (const f of ACTIVE_DOCS) {
      read(f).split('\n').forEach((line, i) => {
        if (!/docs\/archive\//.test(line)) return
        if (RETIREMENT_CONTEXT.test(line) || /must not|never/i.test(line)) return
        hits.push(`${rel(f)}:${i + 1}`)
      })
    }
    expect(hits).toEqual([])
  })
})

describe('archive is labelled', () => {
  it('every archived document carries a non-authoritative header', () => {
    const unlabelled = ARCHIVED_DOCS.filter((f) => !read(f).startsWith('> **ARCHIVED'))
    expect(unlabelled.map(rel)).toEqual([])
  })

  it('archive headers link to a governance index that exists', () => {
    const broken = []
    for (const f of ARCHIVED_DOCS) {
      const m = /\]\((\.\.[^)]+GOVERNANCE_INDEX\.md)\)/.exec(read(f).slice(0, 400))
      if (!m) broken.push(`${rel(f)} (no index link)`)
      else if (!existsSync(resolve(dirname(f), m[1]))) broken.push(`${rel(f)} -> ${m[1]}`)
    }
    expect(broken).toEqual([])
  })
})

describe('naming convention', () => {
  const all = [...ACTIVE_DOCS, ...ARCHIVED_DOCS]

  it('no document filename contains a space', () => {
    expect(all.filter((f) => basename(f).includes(' ')).map(rel)).toEqual([])
  })

  it('no document uses a numeric duplicate suffix', () => {
    expect(all.filter((f) => / \d+\.md$/.test(basename(f))).map(rel)).toEqual([])
  })

  it('no two active documents share a basename', () => {
    const seen = new Map()
    const dupes = []
    for (const f of ACTIVE_DOCS) {
      const b = basename(f)
      if (seen.has(b)) dupes.push(`${b}: ${rel(seen.get(b))} vs ${rel(f)}`)
      else seen.set(b, f)
    }
    expect(dupes).toEqual([])
  })
})

describe('dev mock fidelity', () => {
  // TESTING_STANDARD.md §2: localhost:5200 runs src/localClient.mock.js, not the
  // real data layer. When the mock and the real client diverge, the dev
  // environment silently lies — this already cost the project a blocking bug
  // where every write no-op'd. This test pins the divergence so it can only shrink.
  // Emptied by T11 — the mock now implements every method the renderer calls.
  // Keep the list (not the check) if a future divergence is ever deliberately
  // accepted; an empty array means "no divergence is tolerated".
  const KNOWN_UNIMPLEMENTED = []

  const invoked = [...new Set(
    [...read(p('src', 'localClient.js')).matchAll(/shoresh\??\.([a-zA-Z]+)\s*\(/g)].map((m) => m[1])
  )].sort()
  const mocked = [...new Set(
    [...read(p('src', 'localClient.mock.js')).matchAll(/^ {2}(?:async )?([a-zA-Z]+)\s*\(/gm)].map((m) => m[1])
  )].sort()

  it('the mock implements every window.shoresh method the renderer calls, except the pinned gap', () => {
    const missing = invoked.filter((m) => !mocked.includes(m))
    // Adding a method here requires a deliberate edit — new divergence fails the build.
    expect(missing.sort()).toEqual([...KNOWN_UNIMPLEMENTED].sort())
  })

  it('the pinned gap does not grow', () => {
    expect(invoked.filter((m) => !mocked.includes(m)).length).toBeLessThanOrEqual(KNOWN_UNIMPLEMENTED.length)
  })
})
