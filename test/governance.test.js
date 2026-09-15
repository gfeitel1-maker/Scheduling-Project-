import { describe, it, expect } from 'vitest'
import { readFileSync, readdirSync, existsSync, statSync } from 'node:fs'
import { join, dirname, resolve, relative, basename } from 'node:path'
import { fileURLToPath } from 'node:url'
import { AGENTS, INDEPENDENT_AGENTS, checkTicketNumberUniqueness, checkRunRecordFiled, checkRunRecordsFilledIn } from '../scripts/check-governance.js'
import { readDocs } from '../scripts/build-work-index.js'

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

  // check-governance.js's AGENTS is Article VII's *loop* roster, not Article VI's full
  // roster: every name in it must be selected-or-omitted in every run record, so adding
  // one retroactively invalidates every older record. The three independent agents belong
  // to Article VI but not to the loop. Pinning the partition means a newly added agent
  // fails here until someone consciously places it on one side or the other, instead of
  // being silently absent from both (or, worse, added to AGENTS and breaking the corpus).
  it('the loop roster and the independent agents together are exactly the Article VI roster', () => {
    const constitution = read(p('docs', 'governance', 'constitution', 'CONSTITUTION.md'))
    const section = constitution.slice(
      constitution.indexOf('## Article VI'),
      constitution.indexOf('## Article VII'),
    )
    // Require a real two-column table row — `| **Name** | description |` — so a bolded callout
    // or footer row inside Article VI cannot be smuggled into the roster and surface as a
    // confusing "the constitution and the code disagree" diff. Names may contain hyphens or
    // digits; previously such a row was silently dropped instead of failing. (Red Hat, 44b49c6.)
    const roster = [...section.matchAll(/^\| \*\*([A-Za-z][A-Za-z0-9 -]*)\*\*\s*\|[^|]*\|/gm)]
      .map((m) => m[1].trim().toLowerCase().replace(/\s+/g, '-'))
      .sort()
    expect(roster.length).toBeGreaterThan(0)
    // Red Hat's real concern was the failure MESSAGE, not the match: a stray two-column bolded
    // row still parses as a roster entry, and the resulting set-diff reads as "the constitution
    // and the code disagree about the roster" — inviting someone to delete a legitimate entry to
    // make it green. Name the culprit first, so the stray row is obvious.
    const notAnAgent = roster.filter((r) => !existsSync(p('.claude', 'agents', `${r}.md`)))
    expect(notAnAgent, 'Article VI row(s) with no matching .claude/agents file — a stray bolded '
      + 'table row, or an agent whose file is missing').toEqual([])
    // The prose count and the table must agree; they drifted once already (13 rows vs "Twelve").
    const stated = /^([A-Z][a-z]+) agents\./m.exec(section)?.[1]?.toLowerCase()
    const words = { ten: 10, eleven: 11, twelve: 12, thirteen: 13, fourteen: 14, fifteen: 15 }
    if (stated && words[stated]) expect(words[stated]).toBe(roster.length)
    expect([...AGENTS, ...INDEPENDENT_AGENTS].sort()).toEqual(roster)
    expect(AGENTS.filter((a) => INDEPENDENT_AGENTS.includes(a))).toEqual([])
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

// T177 — two tickets must never share a number.
//
// The reason this is a gate rather than tidiness: `resolveIds` matches a
// completion reference against the PATH, so a duplicated number resolves to
// every file carrying it, and `checkStatusDrift` then reports drift for each
// unclosed match. That is strict and correct — a duplicate can never make the
// gate falsely PASS.
//
// The hazard runs the other way, and is worse because it is actionable: closing
// YOUR ticket demands closure of SOMEONE ELSE'S unrelated open one, and the
// obvious way to turn a red gate green is to flip the status it names. The gate
// that exists to stop a ticket silently looking closed can, through a number
// collision, push someone into closing one.
//
// Measured twice in two days across concurrent sessions (T165, then T175), for a
// structural reason: each picks "the next free number" by listing the directory
// and cannot see the other's uncommitted file.
describe('ticket numbers are unique', () => {
  const ticket = (path, status = 'open') => ({ path, data: { document_type: 'ticket', status } })

  it('is silent when every number is used once', () => {
    expect(checkTicketNumberUniqueness([ticket('docs/work/tickets/T900-a.md'), ticket('docs/work/tickets/T901-b.md')])).toEqual([])
  })

  it('reports a collision, naming both files', () => {
    const out = checkTicketNumberUniqueness([ticket('docs/work/tickets/T900-a.md'), ticket('docs/work/tickets/T900-b.md')])
    expect(out).toHaveLength(1)
    expect(out[0].message).toMatch(/T900-a\.md and docs\/work\/tickets\/T900-b\.md/)
  })

  it('reports a collision even when both are CLOSED, unless grandfathered', () => {
    // Closed-and-closed is dormant rather than safe: the ambiguity is still in
    // the history, and a reopen brings it back. New ones are never waved through
    // on the grounds that nothing is demanded today.
    const out = checkTicketNumberUniqueness([
      ticket('docs/work/tickets/T900-a.md', 'completed'),
      ticket('docs/work/tickets/T900-b.md', 'completed'),
    ])
    expect(out).toHaveLength(1)
  })

  it('grandfathers the historical duplicates ONLY while all of them stay closed', () => {
    // T82/T107/T110 predate this check and all their tickets are closed;
    // renumbering would break references in commits and ADRs that cannot be
    // rewritten. The pass is conditional and re-earned every run.
    const closed = [
      ticket('docs/work/tickets/T82-one.md', 'completed'),
      ticket('docs/work/tickets/T82-two.md', 'completed'),
    ]
    expect(checkTicketNumberUniqueness(closed)).toEqual([])

    // Reopen one and the hazard is live again, so the gate speaks up.
    const reopened = [
      ticket('docs/work/tickets/T82-one.md', 'completed'),
      ticket('docs/work/tickets/T82-two.md', 'in-progress'),
    ]
    expect(checkTicketNumberUniqueness(reopened)).toHaveLength(1)
  })

  it('ignores ADRs and specs, which are addressed by filename rather than number', () => {
    expect(checkTicketNumberUniqueness([
      { path: 'docs/adr/T900-a.md', data: { document_type: 'adr' } },
      { path: 'docs/adr/T900-b.md', data: { document_type: 'adr' } },
    ])).toEqual([])
  })

  it('THE REAL REPO PASSES — the check reflects the corpus, not an aspiration', () => {
    // If this fails, two tickets in this repository share a number right now.
    const docs = readDocs(process.cwd())
    expect(checkTicketNumberUniqueness(docs).map((f) => f.message)).toEqual([])
  })
})

// T167 part 2 — a merged change that closes something must ADD a run record.
//
// 283 commits landed between 2026-08-25 and 2026-09-14 with zero run records,
// and this file could not detect it: it validated records that EXIST and had no
// rule that work must produce one. A gate that checks what is there cannot see
// what is missing — the same shape as T171's missing results file and T174's
// audit row that could never be written.
describe('a change that closes something must file a run record', () => {
  it('is silent when the change closes nothing', () => {
    // Most commits close nothing. The rule must not tax them.
    expect(checkRunRecordFiled(['chore: tidy up', 'perf: faster'], [])).toEqual([])
  })

  it('fails a closure that adds no record, and names what it claims to close', () => {
    const out = checkRunRecordFiled(['closes T900: a thing'], [])
    expect(out).toHaveLength(1)
    expect(out[0].message).toMatch(/T900/)
    expect(out[0].message).toMatch(/newRunRecord\.js/)
  })

  it('passes when the change adds one', () => {
    expect(checkRunRecordFiled(['closes T900: a thing'], ['docs/work/runs/2026-09-15-a-thing.md'])).toEqual([])
  })

  it('ABOUT THE CHANGE, NOT THE TICKET — an existing record elsewhere does not satisfy it', () => {
    // "Some record somewhere mentions T900" would be satisfied by a part-1
    // record when part 2 lands. That is this author's own next commit, and is
    // how the rule would first have been evaded without anyone noticing. The
    // added-files list is the only input, so a pre-existing record cannot count.
    expect(checkRunRecordFiled(['closes T900: part 2'], [])).toHaveLength(1)
  })

  it('ignores a revert, which quotes a prior subject rather than claiming a closure', () => {
    expect(checkRunRecordFiled(['Revert "closes T900: a thing"'], [])).toEqual([])
  })

  it('does not count the template as a filed record', () => {
    expect(checkRunRecordFiled(['closes T900: x'], ['docs/work/runs/TEMPLATE.md'])).toHaveLength(1)
  })
})

describe('a generated-and-forgotten record is not a filed one', () => {
  const read = (map) => (p) => {
    const hit = Object.entries(map).find(([k]) => p.endsWith(k))
    if (!hit) throw new Error('nope')
    return hit[1]
  }

  it('fails a record still carrying NEEDS JUDGEMENT markers', () => {
    // Without this, making filing cheap would only make producing EMPTY records
    // cheap, and the artifact becomes decoration — worse than the 283 missing
    // ones, because decoration looks like evidence.
    const docs = [{ path: 'docs/work/runs/2026-09-15-x.md' }]
    const out = checkRunRecordsFilledIn('/root', docs, read({ 'x.md': 'verdict: <<NEEDS JUDGEMENT>>' }))
    expect(out).toHaveLength(1)
    expect(out[0].message).toMatch(/decoration, not evidence/)
  })

  it('passes a filled-in record', () => {
    const docs = [{ path: 'docs/work/runs/2026-09-15-x.md' }]
    expect(checkRunRecordsFilledIn('/root', docs, read({ 'x.md': 'verdict: pass' }))).toEqual([])
  })

  it('catches a marker in a LIST ITEM reason, not only a top-level field', () => {
    const docs = [{ path: 'docs/work/runs/2026-09-15-x.md' }]
    const text = '  - agent: maker\n    reason: <<NEEDS JUDGEMENT>>'
    expect(checkRunRecordsFilledIn('/root', docs, read({ 'x.md': text }))).toHaveLength(1)
  })

  it('catches the generator\'s body stub, which begins with the marker', () => {
    const docs = [{ path: 'docs/work/runs/2026-09-15-x.md' }]
    const text = '## Agents\n\n<<NEEDS JUDGEMENT>> — name who ran'
    expect(checkRunRecordsFilledIn('/root', docs, read({ 'x.md': text }))).toHaveLength(1)
  })

  it('does NOT flag a record that merely DISCUSSES the markers in prose', () => {
    // The first version matched the bare string and flagged this ticket's own
    // run record — fully filled in, and describing the rule it implements. A
    // check that cannot tell a placeholder from a description of one makes
    // writing about the mechanism impossible, and the record explaining the rule
    // is the one most likely to mention it.
    const docs = [{ path: 'docs/work/runs/2026-09-15-x.md' }]
    const text = 'verdict: pass\n\nThe rule refuses a record keeping its `<<NEEDS JUDGEMENT>>` markers.'
    expect(checkRunRecordsFilledIn('/root', docs, read({ 'x.md': text }))).toEqual([])
  })

  it('exempts the template, which is supposed to carry placeholders', () => {
    const docs = [{ path: 'docs/work/runs/TEMPLATE.md' }]
    expect(checkRunRecordsFilledIn('/root', docs, read({ 'TEMPLATE.md': '<<NEEDS JUDGEMENT>>' }))).toEqual([])
  })

  it('ignores documents outside docs/work/runs', () => {
    const docs = [{ path: 'docs/work/tickets/T1-x.md' }]
    expect(checkRunRecordsFilledIn('/root', docs, read({ 'T1-x.md': '<<NEEDS JUDGEMENT>>' }))).toEqual([])
  })

  it('THE REAL REPO PASSES — no filed record is left half-written', () => {
    const docs = readDocs(process.cwd())
    expect(checkRunRecordsFilledIn(process.cwd(), docs).map((f) => f.message)).toEqual([])
  })
})
