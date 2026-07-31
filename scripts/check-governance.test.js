import { describe, it, expect } from 'vitest'
import { checkDoc, checkIndexFreshness, AGENTS } from './check-governance.js'

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
