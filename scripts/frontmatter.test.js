import { describe, it, expect } from 'vitest'
import { parseFrontmatter, asList } from './frontmatter.js'

// The parser deliberately covers only the YAML subset this repository's
// frontmatter actually uses. It is not a YAML implementation and must not grow
// into one — anything it cannot parse should be rewritten in the document, not
// accommodated here. Adding a YAML dependency for 43 files of `key: value` was
// the alternative and was rejected.

describe('parseFrontmatter', () => {
  it('returns null data when the file has no frontmatter block', () => {
    expect(parseFrontmatter('# Just a heading\n').data).toBe(null)
  })

  it('requires the block to open on the very first line', () => {
    // A `---` further down is a horizontal rule, not frontmatter.
    expect(parseFrontmatter('\n---\ntitle: x\n---\n').data).toBe(null)
  })

  it('reads scalars', () => {
    const { data } = parseFrontmatter('---\ntitle: Work Record Standard\nround: 1\n---\n')
    expect(data.title).toBe('Work Record Standard')
    expect(data.round).toBe(1)
  })

  it('strips quotes from a quoted scalar, keeping inner colons', () => {
    const { data } = parseFrontmatter('---\ntitle: "Plural schedules: two routes"\n---\n')
    expect(data.title).toBe('Plural schedules: two routes')
  })

  it('reads null and empty as distinct from absent', () => {
    const { data } = parseFrontmatter('---\nverdict: null\nnote:\n---\n')
    expect(data.verdict).toBe(null)
    expect(data.note).toBe('')
    expect('missing' in data).toBe(false)
  })

  it('reads an inline list', () => {
    const { data } = parseFrontmatter('---\nagents: [maker, verifier, code-reviewer]\n---\n')
    expect(data.agents).toEqual(['maker', 'verifier', 'code-reviewer'])
  })

  it('reads an empty inline list as an empty array, not a string', () => {
    // This distinction is load-bearing: `[]` means "none apply and I checked",
    // an absent key means "nobody said". The checker treats them differently.
    expect(parseFrontmatter('---\nhuman_gates: []\n---\n').data.human_gates).toEqual([])
  })

  it('reads a block list', () => {
    const { data } = parseFrontmatter('---\naffects:\n  - docs/a.md\n  - docs/b.md\n---\n')
    expect(data.affects).toEqual(['docs/a.md', 'docs/b.md'])
  })

  it('reads a block list of maps', () => {
    const src = [
      '---',
      'omitted_agents:',
      '  - agent: designer',
      '    reason: not-applicable',
      '    note: no UI surface',
      '  - agent: security',
      '    reason: no-predicate',
      '---',
      '',
    ].join('\n')
    expect(parseFrontmatter(src).data.omitted_agents).toEqual([
      { agent: 'designer', reason: 'not-applicable', note: 'no UI surface' },
      { agent: 'security', reason: 'no-predicate' },
    ])
  })

  it('returns the body separately so the prose is never rewritten', () => {
    const { body } = parseFrontmatter('---\ntitle: x\n---\n# Heading\n\ntext\n')
    expect(body).toBe('# Heading\n\ntext\n')
  })

  it('reports malformed frontmatter rather than throwing', () => {
    const { data, error } = parseFrontmatter('---\ntitle: x\nno colon here\n---\n')
    expect(data).toBe(null)
    expect(error).toMatch(/no colon here/)
  })

  it('reports an unterminated block rather than silently eating the document', () => {
    const { data, error } = parseFrontmatter('---\ntitle: x\n\n# Heading\n')
    expect(data).toBe(null)
    expect(error).toMatch(/unterminated/i)
  })
})

describe('asList', () => {
  it('passes an array through', () => {
    expect(asList(['a'])).toEqual(['a'])
  })

  it('wraps a bare string, because that malformation is common and recoverable', () => {
    // WORK_RECORD_STANDARD.md §2 requires a list. The checker reports the bare
    // string as a defect; the index builder still needs the edge, because
    // dropping it would hide a real reference behind a formatting mistake.
    expect(asList('docs/a.md')).toEqual(['docs/a.md'])
  })

  it('treats absent and null as empty', () => {
    expect(asList(undefined)).toEqual([])
    expect(asList(null)).toEqual([])
  })
})
