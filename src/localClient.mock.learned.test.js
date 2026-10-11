import { describe, it, expect } from 'vitest'
import { createMockLearned } from './localClient.mock.learned.js'
import { buildLearnedGroups } from './ingest/learnedView.js'

describe('the browser-dev learned mock', () => {
  it('returns data the real view model accepts: patterns first, a never-apply kind, a former user', async () => {
    const data = await createMockLearned('').listLearned()
    const groups = buildLearnedGroups(data)
    expect(groups.map((g) => g.label)).toEqual(['Classification', 'All camp except...', 'Values', 'Splits and merges'])
    expect(groups[0].patterns[0].flag.text).toBe('Applies automatically')
    expect(groups[1].patterns[0].neverApply.line).toBe('Always asks you: this kind only pre-selects.')
    expect(data.formerUserAnswers).toBe(1)
  })
  it('?learned=many goes past the 15-row search threshold; empty is empty; readonly cannot write', async () => {
    const total = (d) => buildLearnedGroups(d).reduce((n, g) => n + g.count, 0)
    expect(total(await createMockLearned('?learned=many').listLearned())).toBeGreaterThan(15)
    expect(total(await createMockLearned('?learned=empty').listLearned())).toBe(0)
    expect((await createMockLearned('?learned=readonly').listLearned()).canWrite).toBe(false)
  })
  it('Forget removes the answer', async () => {
    const m = createMockLearned('')
    await m.forgetImportAnswer({ memoryId: 'a1' })
    expect((await m.listLearned()).answers.some((a) => a.id === 'a1')).toBe(false)
  })
})
