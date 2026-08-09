import { describe, it, expect } from 'vitest'
import {
  checkDoc, checkIndexFreshness, AGENTS,
  parseCompletionRefs, resolveIds, isClosed, checkStatusDrift, checkAll,
} from './check-governance.js'

// The checker's whole job is to fail on things a human reading one file would
// not notice. These tests are therefore written as "the defect it must catch",
// not as "the happy path it must allow".

const exists = (p) => p.startsWith('docs/real/')

const run = (over = {}) => ({
  path: 'docs/work/runs/2026-07-30-x.md',
  data: {
    task: 'T1', document_type: 'run', date: '2026-07-30', round: 1,
    status: 'in-progress', task_class: 'database-sync',
    governing_docs: [], related_tickets: [], related_specs: [], related_adrs: [],
    selected_agents: ['governor', 'maker', 'verifier'],
    omitted_agents: AGENTS
      .filter((a) => !['governor', 'maker', 'verifier'].includes(a))
      .map((agent) => ({ agent, reason: 'not-applicable' })),
    deterministic_checks: ['test'], human_gates: [],
    verdict: null, completion_evidence: [], archive_when: 'done',
    ...over,
  },
  error: null,
})

const codes = (doc) => checkDoc(doc, exists).map((f) => f.code)

describe('checkDoc — schema', () => {
  it('passes a conforming run record', () => {
    expect(checkDoc(run(), exists)).toEqual([])
  })

  it('reports unparseable frontmatter without throwing', () => {
    const bad = { path: 'docs/work/runs/x.md', data: null, error: 'unterminated frontmatter block' }
    expect(codes(bad)).toContain('frontmatter-unparseable')
  })

  it('reports a document with no frontmatter at all', () => {
    expect(codes({ path: 'docs/work/runs/x.md', data: null, error: null })).toContain('frontmatter-missing')
  })

  it('reports a missing required field', () => {
    expect(codes(run({ archive_when: undefined }))).toContain('field-missing')
  })

  it('reports a status outside the enum for that document type', () => {
    // `completed` is a plausible-looking value that means nothing here.
    expect(codes(run({ status: 'completed' }))).toContain('enum-violation')
  })

  it('reports a task_class that is not a row in GOVERNANCE_INDEX §3-8', () => {
    // This is exactly the defect found in the 2026-07-26 record: `navigation-ia`
    // routed against a class that never existed.
    expect(codes(run({ task_class: 'navigation-ia' }))).toContain('enum-violation')
  })

  it('reports a bare string where the standard requires a list', () => {
    expect(codes(run({ related_tickets: 'docs/real/a.md' }))).toContain('not-a-list')
  })

  it('distinguishes an empty list from an absent key', () => {
    // `human_gates: []` asserts "checked, none apply". Omitting the key asserts
    // nothing, and the standard requires the assertion.
    expect(codes(run({ human_gates: [] }))).not.toContain('field-missing')
    expect(codes(run({ human_gates: undefined }))).toContain('field-missing')
  })
})

describe('checkDoc — references', () => {
  it('reports a reference to a file that does not exist', () => {
    expect(codes(run({ governing_docs: ['docs/nope/gone.md'] }))).toContain('dangling-reference')
  })

  it('accepts a reference that resolves', () => {
    expect(codes(run({ governing_docs: ['docs/real/standard.md'] }))).toEqual([])
  })
})

describe('checkDoc — the run-record rules that matter', () => {
  it('reports an agent that is neither selected nor omitted', () => {
    // Article VII requires the omission to be recorded. Silence is the defect.
    const partial = run({ omitted_agents: [{ agent: 'designer', reason: 'not-applicable' }] })
    expect(codes(partial)).toContain('agent-unaccounted')
  })

  it('reports an agent both selected and omitted', () => {
    expect(codes(run({ omitted_agents: [{ agent: 'maker', reason: 'not-applicable' }] })))
      .toContain('agent-contradiction')
  })

  it('reports an omission reason outside the enum', () => {
    const doc = run()
    doc.data.omitted_agents[0].reason = 'seemed unnecessary'
    expect(codes(doc)).toContain('enum-violation')
  })

  it('requires a verbatim note on a human-waived omission', () => {
    const doc = run()
    doc.data.omitted_agents[0] = { agent: doc.data.omitted_agents[0].agent, reason: 'human-waived' }
    expect(codes(doc)).toContain('waiver-unquoted')
  })

  it('reports a pass verdict with no completion evidence', () => {
    // A pass asserted with nothing attached is the exact provenance failure
    // this system exists to prevent.
    expect(codes(run({ verdict: 'pass', completion_evidence: [] })))
      .toContain('evidence-missing')
  })

  it('accepts a pass verdict that carries evidence', () => {
    expect(codes(run({ verdict: 'pass', completion_evidence: ['npm run test: 678 passed'] })))
      .toEqual([])
  })

  it('reports a round above 2 — Article VII escalates instead', () => {
    expect(codes(run({ round: 3 }))).toContain('enum-violation')
  })

  it('applies none of the run rules to a ticket', () => {
    const ticket = {
      path: 'docs/work/tickets/T1-x.md',
      data: {
        title: 'T1', document_type: 'ticket', status: 'open',
        created: '2026-07-01', archive_when: 'resolved',
      },
      error: null,
    }
    expect(checkDoc(ticket, exists)).toEqual([])
  })
})

describe('checkDoc — corrections found by running it on the real corpus', () => {
  const ticket = (over) => ({
    path: 'docs/work/tickets/T1-x.md',
    data: {
      title: 'T1', document_type: 'ticket', status: 'completed',
      created: '2026-07-01', archive_when: 'resolved', ...over,
    },
    error: null,
  })

  it('accepts `completed`, which is what 18 tickets actually say', () => {
    // The first draft of this enum invented `resolved`. One file used it and
    // eighteen used `completed`. The corpus was right and the enum was wrong.
    expect(checkDoc(ticket(), exists)).toEqual([])
  })

  it('accepts a commit SHA in resolved_by without trying to open it as a file', () => {
    // resolved_by points at the commit that closed the ticket. It is not a
    // doc-to-doc edge and must not be resolved against the filesystem.
    expect(checkDoc(ticket({ resolved_by: 'af6a9d8' }), exists)).toEqual([])
  })

  it('still reports a resolved_by path that does not exist', () => {
    expect(codes(ticket({ resolved_by: 'docs/work/runs/gone.md' }))).toContain('dangling-reference')
  })

  it('reports a resolved_by value that is neither a path nor a SHA', () => {
    expect(codes(ticket({ resolved_by: 'fixed it last tuesday' }))).toContain('unresolvable-reference')
  })

  it('never checks the blank template — its placeholders are not defects', () => {
    const template = {
      path: 'docs/work/runs/TEMPLATE.md',
      data: { document_type: 'run', status: 'in-progress', task_class: '<pick one>' },
      error: null,
    }
    expect(checkDoc(template, exists)).toEqual([])
  })
})

describe('parseCompletionRefs', () => {
  it('matches "closes T##"', () => {
    expect(parseCompletionRefs('closes T76')).toEqual(['T76'])
  })

  it('matches "Merge S##" with optional slice letter', () => {
    expect(parseCompletionRefs('Merge S5b: onboarding')).toEqual(['S5b'])
  })

  it('is case-insensitive on the keyword', () => {
    expect(parseCompletionRefs('CLOSES t76')).toEqual(['t76'])
  })

  it('does not match a bare mention without a completion keyword', () => {
    expect(parseCompletionRefs('relates to T40 see also')).toEqual([])
  })

  it('collects every match in one subject', () => {
    expect(parseCompletionRefs('Merge S5: x (closes T75)')).toEqual(['S5', 'T75'])
  })
})

describe('isClosed', () => {
  it('a ticket is closed when status is completed, closed, or wont-fix', () => {
    expect(isClosed({ document_type: 'ticket', status: 'completed' })).toBe(true)
    expect(isClosed({ document_type: 'ticket', status: 'closed' })).toBe(true)
    expect(isClosed({ document_type: 'ticket', status: 'wont-fix' })).toBe(true)
    expect(isClosed({ document_type: 'ticket', status: 'open' })).toBe(false)
  })

  it('an adr is closed only when implemented and not proposed', () => {
    expect(isClosed({ document_type: 'adr', status: 'accepted', implementation_state: 'implemented' })).toBe(true)
    expect(isClosed({ document_type: 'adr', status: 'proposed', implementation_state: 'implemented' })).toBe(false)
    expect(isClosed({ document_type: 'adr', status: 'accepted', implementation_state: 'not-started' })).toBe(false)
  })

  it('adr — terminal statuses (superseded, rejected) are closed regardless of implementation_state', () => {
    expect(isClosed({ document_type: 'adr', status: 'superseded', implementation_state: 'not-started' })).toBe(true)
    expect(isClosed({ document_type: 'adr', status: 'superseded', implementation_state: null })).toBe(true)
    expect(isClosed({ document_type: 'adr', status: 'rejected', implementation_state: 'not-started' })).toBe(true)
    expect(isClosed({ document_type: 'adr', status: 'proposed', implementation_state: 'not-started' })).toBe(false)
  })

  it('a spec is closed when approved, implemented, or superseded', () => {
    expect(isClosed({ document_type: 'spec', status: 'approved' })).toBe(true)
    expect(isClosed({ document_type: 'spec', status: 'implemented' })).toBe(true)
    expect(isClosed({ document_type: 'spec', status: 'superseded' })).toBe(true)
    expect(isClosed({ document_type: 'spec', status: 'draft' })).toBe(false)
  })

  it('treats any other document_type as not closed', () => {
    expect(isClosed({ document_type: 'run', status: 'pass' })).toBe(false)
  })
})

describe('checkStatusDrift', () => {
  const ticketDoc = (id, status, path) => ({
    path: path || `docs/work/tickets/${id}-thing.md`,
    data: { title: id, document_type: 'ticket', status, created: '2026-08-01', archive_when: 'x' },
    error: null,
  })

  const adrDoc = (path, status, implementation_state) => ({
    path,
    data: { title: path, document_type: 'adr', status, date: '2026-08-01', authority: 'normative', implementation_state },
    error: null,
  })

  it('reports ticket drift when the referenced ticket is not closed', () => {
    const docs = [ticketDoc('T76', 'open')]
    const findings = checkStatusDrift(['closes T76'], docs)
    expect(findings.map((f) => f.code)).toContain('status-drift')
  })

  it('reports slice drift when the referenced adr is not closed', () => {
    const docs = [adrDoc('docs/adr/2026-08-01-thing-s5.md', 'proposed', 'not-started')]
    const findings = checkStatusDrift(['Merge S5: x'], docs)
    expect(findings.map((f) => f.code)).toContain('status-drift')
  })

  it('reports an unresolvable reference when no doc matches the id', () => {
    const findings = checkStatusDrift(['closes T99'], [])
    expect(findings.map((f) => f.code)).toContain('status-drift-unresolvable-reference')
  })

  it('passes when every referenced id resolves to a closed doc', () => {
    const docs = [
      ticketDoc('T76', 'completed'),
      adrDoc('docs/adr/2026-08-01-thing-s5.md', 'accepted', 'implemented'),
    ]
    expect(checkStatusDrift(['closes T76', 'Merge S5: x'], docs)).toEqual([])
  })

  it('does not flag a bare mention with no completion keyword', () => {
    const findings = checkStatusDrift(['refactor grid', 'relates to T40 see also'], [])
    expect(findings).toEqual([])
  })

  it('disambiguates T7 from T70 — a T7 reference must not match a T70 doc', () => {
    const docs = [ticketDoc('T70', 'open')]
    const findings = checkStatusDrift(['closes T7'], docs)
    expect(findings.map((f) => f.code)).toEqual(['status-drift-unresolvable-reference'])
  })

  it('reports drift when an id resolves to multiple docs and one is unclosed', () => {
    const docs = [
      adrDoc('docs/adr/2026-08-01-a-s5.md', 'accepted', 'implemented'),
      adrDoc('docs/adr/2026-08-02-b-s5.md', 'proposed', 'not-started'),
    ]
    const findings = checkStatusDrift(['Merge S5: x'], docs)
    expect(findings.map((f) => f.code)).toEqual(['status-drift'])
  })

  it('ignores a revert subject when called directly, not only via checkAll', () => {
    const docs = [{ path: 'docs/work/tickets/T76-a.md', data: { document_type: 'ticket', status: 'open' }, error: null }]
    expect(checkStatusDrift(['Revert "feat: x (closes T76)"'], docs)).toEqual([])
  })
})

describe('checkAll — git subject gathering', () => {
  it('ignores a revert commit subject so it does not re-fire the gate', () => {
    const execFn = () => 'Revert "feat: x (closes T76)"'
    const findings = checkAll('/fake/root', execFn)
    expect(findings.filter((f) => f.code.startsWith('status-drift'))).toEqual([])
  })

  it('when the git log call throws, skips silently on findings (no status-drift findings) without throwing', () => {
    const execFn = () => { throw new Error('no origin/main') }
    expect(() => checkAll('/fake/root', execFn)).not.toThrow()
    const findings = checkAll('/fake/root', execFn)
    expect(findings.filter((f) => f.code.startsWith('status-drift'))).toEqual([])
  })
})

describe('resolveIds', () => {
  it('matches a ticket by T-number prefix, not a numeric substring', () => {
    const docs = [
      { path: 'docs/work/tickets/T7-thing.md', data: { document_type: 'ticket' }, error: null },
      { path: 'docs/work/tickets/T70-other.md', data: { document_type: 'ticket' }, error: null },
    ]
    const matches = resolveIds('T7', docs)
    expect(matches.map((d) => d.path)).toEqual(['docs/work/tickets/T7-thing.md'])
  })

  it('matches a slice id as a hyphen-delimited filename segment', () => {
    const docs = [
      { path: 'docs/adr/2026-08-01-thing-s5b.md', data: { document_type: 'adr' }, error: null },
      { path: 'docs/adr/2026-08-01-thing-s5.md', data: { document_type: 'adr' }, error: null },
    ]
    const matches = resolveIds('S5b', docs)
    expect(matches.map((d) => d.path)).toEqual(['docs/adr/2026-08-01-thing-s5b.md'])
  })
})

describe('checkIndexFreshness', () => {
  it('reports nothing when the committed index matches what would be generated', () => {
    expect(checkIndexFreshness('same bytes', 'same bytes')).toEqual([])
  })

  it('reports a stale index, so a forgotten regeneration surfaces as a finding', () => {
    expect(checkIndexFreshness('old', 'new').map((f) => f.code)).toEqual(['index-stale'])
  })

  it('reports a missing index rather than treating absence as fresh', () => {
    expect(checkIndexFreshness(null, 'new').map((f) => f.code)).toEqual(['index-missing'])
  })
})
