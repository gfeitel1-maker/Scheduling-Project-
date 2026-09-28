import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { scanDocFactsInText, checkDocFacts, DOC_FACTS } from './doc-facts.js'

describe('scanDocFactsInText', () => {
  const derived = { schema_version: '79', verify_step_count: '8' }

  it('passes when the marker value matches the derived source value', () => {
    const text = 'schema **v79** as of this writing <!-- doc-fact:schema_version value=79 -->'
    expect(scanDocFactsInText('D.md', text, derived)).toEqual([])
  })

  it('flags a stale marker (asserted != source) as doc-fact-stale with doc:line', () => {
    const text = ['line one', 'schema v78 <!-- doc-fact:schema_version value=78 -->'].join('\n')
    const found = scanDocFactsInText('D.md', text, derived)
    expect(found).toHaveLength(1)
    expect(found[0].code).toBe('doc-fact-stale')
    expect(found[0].message).toContain('D.md:2')
    expect(found[0].message).toContain('value=78')
    expect(found[0].message).toContain('79')
  })

  it('flags an unknown fact name — misuse must not pass silently', () => {
    const text = 'whatever <!-- doc-fact:not_a_real_fact value=3 -->'
    const found = scanDocFactsInText('D.md', text, derived)
    expect(found).toHaveLength(1)
    expect(found[0].message).toContain('unknown doc-fact')
  })

  it('skips comparison when the derived value is null (source unreadable), not a false pass or fail', () => {
    const text = 'schema v99 <!-- doc-fact:schema_version value=99 -->'
    expect(scanDocFactsInText('D.md', text, { schema_version: null })).toEqual([])
  })

  it('ignores an incidental number elsewhere on the marked line', () => {
    const text = 'across 79 devices the schema is v79 <!-- doc-fact:schema_version value=79 -->'
    expect(scanDocFactsInText('D.md', text, derived)).toEqual([])
  })

  it('handles multiple markers on distinct lines', () => {
    const text = [
      'schema v79 <!-- doc-fact:schema_version value=79 -->',
      'eight steps <!-- doc-fact:verify_step_count value=8 -->',
      'stale v70 <!-- doc-fact:schema_version value=70 -->',
    ].join('\n')
    const found = scanDocFactsInText('D.md', text, derived)
    expect(found).toHaveLength(1)
    expect(found[0].message).toContain('D.md:3')
  })
})

describe('checkDocFacts (wrapper over a synthetic filesystem)', () => {
  const files = {
    'electron/db/localDb.js': 'export const CURRENT_SCHEMA_VERSION = 79\n',
    'scripts/verify.js': "export const VERIFY_STEPS = [\n  'a',\n  // a comment with an apostrophe: step's cost\n  'b',\n  'c',\n]\n",
    'docs/x.md': 'v79 <!-- doc-fact:schema_version value=79 -->\ncount 3 <!-- doc-fact:verify_step_count value=3 -->',
  }
  const read = (rel) => {
    if (!(rel in files)) throw new Error(`ENOENT ${rel}`)
    return files[rel]
  }

  it('derives schema_version and verify_step_count from source and passes a correct doc', () => {
    const found = checkDocFacts('/root', { scan: ['docs/x.md'], read, warn: () => {} })
    expect(found).toEqual([])
  })

  it('counts VERIFY_STEPS literals, not stray quote characters in comments', () => {
    expect(DOC_FACTS.verify_step_count.derive(read)).toBe('3')
  })

  it('catches a doc whose marker disagrees with derived source', () => {
    const bad = { ...files, 'docs/x.md': 'v78 <!-- doc-fact:schema_version value=78 -->' }
    const found = checkDocFacts('/root', {
      scan: ['docs/x.md'],
      read: (rel) => { if (!(rel in bad)) throw new Error('ENOENT'); return bad[rel] },
      warn: () => {},
    })
    expect(found).toHaveLength(1)
    expect(found[0].message).toContain('value=78')
    expect(found[0].message).toContain('79')
  })

  it('warns (does not throw) when a source file is unreadable', () => {
    const warnings = []
    const found = checkDocFacts('/root', {
      scan: ['docs/x.md'],
      read: (rel) => { if (rel === 'electron/db/localDb.js') throw new Error('ENOENT'); return files[rel] },
      warn: (m) => warnings.push(m),
    })
    // schema_version derivation failed -> its marker is skipped, verify_step_count still checked
    expect(warnings.some((w) => w.includes('schema_version'))).toBe(true)
    expect(found).toEqual([])
  })
})

describe('DOC_FACTS derive against the real repo (integration)', () => {
  it('schema_version derives a positive integer string from the live source', () => {
    const read = (rel) => readFileSync(rel, 'utf8')
    const v = DOC_FACTS.schema_version.derive(read)
    expect(v).toMatch(/^\d+$/)
    expect(Number(v)).toBeGreaterThan(0)
  })
})
