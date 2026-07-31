import { describe, it, expect } from 'vitest'
import { buildGraph, renderIndex, GENERATED_HEADER } from './build-work-index.js'

// Fixtures are hand-written rather than read from docs/, so these tests keep
// passing while the real documents change. A test that reads the live corpus
// tests the corpus, not the builder.

const doc = (path, data) => ({ path, data })

const TICKET = doc('docs/work/tickets/T9-thing.md', {
  title: 'T9 — a thing',
  document_type: 'ticket',
  status: 'open',
  created: '2026-07-29',
  task_class: 'database-sync',
  related_adrs: ['docs/adr/2026-07-25-decision.md'],
})

const ADR = doc('docs/adr/2026-07-25-decision.md', {
  title: 'A decision',
  document_type: 'adr',
  status: 'accepted',
  date: '2026-07-25',
  implementation_state: 'not-started',
})

describe('buildGraph', () => {
  it('inverts edges into backlinks — the layer that does not exist in the raw files', () => {
    const { backlinks } = buildGraph([TICKET, ADR])
    expect(backlinks.get('docs/adr/2026-07-25-decision.md')).toEqual([
      { from: 'docs/work/tickets/T9-thing.md', field: 'related_adrs' },
    ])
  })

  it('does not invent a backlink from a document to itself', () => {
    const selfRef = doc('docs/adr/a.md', {
      document_type: 'adr', status: 'accepted', date: '2026-07-01',
      affects: ['docs/adr/a.md'],
    })
    const { backlinks } = buildGraph([selfRef])
    expect(backlinks.get('docs/adr/a.md')).toBeUndefined()
  })

  it('reports a reference whose target does not exist', () => {
    const { dangling } = buildGraph([TICKET])
    expect(dangling).toEqual([{
      from: 'docs/work/tickets/T9-thing.md',
      field: 'related_adrs',
      to: 'docs/adr/2026-07-25-decision.md',
    }])
  })

  it('accepts a bare string reference so a formatting mistake does not hide a real edge', () => {
    const bare = doc('docs/work/tickets/T1-x.md', {
      document_type: 'ticket', status: 'open', created: '2026-07-01',
      related_adrs: 'docs/adr/2026-07-25-decision.md',
    })
    const { dangling, backlinks } = buildGraph([bare, ADR])
    expect(dangling).toEqual([])
    expect(backlinks.get('docs/adr/2026-07-25-decision.md')).toHaveLength(1)
  })

  it('counts a document with no edges in either direction as an orphan', () => {
    const lonely = doc('docs/work/specs/2026-07-01-alone.md', {
      document_type: 'spec', status: 'draft', created: '2026-07-01',
    })
    const { orphans } = buildGraph([lonely, TICKET, ADR])
    expect(orphans).toEqual(['docs/work/specs/2026-07-01-alone.md'])
  })

  it('does not call a referenced document an orphan even when it references nothing', () => {
    // The ADR points at nothing, but the ticket points at it. It is connected.
    const { orphans } = buildGraph([TICKET, ADR])
    expect(orphans).not.toContain('docs/adr/2026-07-25-decision.md')
  })

  it('never treats the generated index or a template as a document', () => {
    const noise = [
      doc('docs/work/INDEX.md', { document_type: 'index', status: 'active' }),
      doc('docs/work/runs/TEMPLATE.md', { document_type: 'run', status: 'in-progress' }),
    ]
    expect(buildGraph([...noise, ADR]).docs.map((d) => d.path)).toEqual(['docs/adr/2026-07-25-decision.md'])
  })
})

describe('renderIndex', () => {
  const render = (docs) => renderIndex(buildGraph(docs))

  it('marks the file as generated so nobody hand-edits it', () => {
    expect(render([ADR])).toContain(GENERATED_HEADER)
  })

  it('is deterministic — the same input renders byte-identically', () => {
    // This is what lets check:governance detect staleness by comparison.
    expect(render([TICKET, ADR])).toBe(render([TICKET, ADR]))
  })

  it('does not depend on input order', () => {
    expect(render([TICKET, ADR])).toBe(render([ADR, TICKET]))
  })

  it('lists an open ticket under its task class', () => {
    const out = render([TICKET, ADR])
    expect(out).toMatch(/database-sync/)
    expect(out).toContain('T9 — a thing')
  })

  it('omits a resolved ticket from open work', () => {
    const done = doc('docs/work/tickets/T8-done.md', {
      title: 'T8 — done', document_type: 'ticket', status: 'resolved', created: '2026-07-01',
    })
    expect(render([done, ADR])).not.toContain('T8 — done')
  })

  it('shows an accepted-but-unimplemented ADR as such, because that gap is real', () => {
    expect(render([ADR])).toMatch(/not-started/)
  })

  it('lists runs — the artifact the whole standard exists to produce', () => {
    const run = doc('docs/work/runs/2026-07-30-x.md', {
      task: 'T9 — a thing', document_type: 'run', date: '2026-07-30',
      status: 'in-progress', task_class: 'database-sync', verdict: null,
    })
    const out = render([run, ADR])
    expect(out).toMatch(/## Runs/)
    expect(out).toContain('T9 — a thing')
  })

  it('shows a run with no verdict as unverified rather than blank', () => {
    // A blank cell reads as "nothing to report". No verdict means Verifier has
    // not returned, which is a different and more important claim.
    const run = doc('docs/work/runs/2026-07-30-x.md', {
      task: 'x', document_type: 'run', date: '2026-07-30',
      status: 'in-progress', task_class: 'database-sync', verdict: null,
    })
    expect(render([run, ADR])).toMatch(/no verdict yet/)
  })

  it('orders runs newest first, because the recent one is the one being read', () => {
    const mk = (date) => doc(`docs/work/runs/${date}-x.md`, {
      task: date, document_type: 'run', date, status: 'pass',
      task_class: 'database-sync', verdict: 'pass',
    })
    const out = render([mk('2026-07-26'), mk('2026-07-30'), ADR])
    expect(out.indexOf('2026-07-30')).toBeLessThan(out.indexOf('2026-07-26'))
  })

  it('surfaces dangling references rather than rendering a broken link', () => {
    expect(render([TICKET])).toMatch(/Dangling/)
  })

  it('says so explicitly when there is nothing to report in a section', () => {
    // An empty section must read as "checked, none found" — not as a section
    // that was skipped. Silence and zero are different claims.
    expect(render([TICKET, ADR])).toMatch(/None\./)
  })
})
