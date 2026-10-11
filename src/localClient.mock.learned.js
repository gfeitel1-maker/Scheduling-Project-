// Browser-dev stand-in for the answer-memory view's data. ?learned=empty|many|readonly|error picks a
// state for `npm run dev` screenshots. Writes mutate the in-memory list so Forget / Change / Keep show.
const DANA = { by: 'u-dana', name: 'Dana Cohen' }
const ME = { by: 'u-me', name: 'Greg Feitel' }

const ans = (id, name, over = {}) => ({
  id, qkind: 'classify', role: 'instance', name, verdict: 'accept', label: 'Fixed event', features: {}, explicit: true, bulk: false,
  confirmed_at: '2026-07-03T10:00:00Z', confirmed_by: DANA.by, confirmedByName: DANA.name, asRecorded: false, former: false,
  camp_shape: { groups: 4, days: 5 }, ...over,
})
const progress = (over = {}) => ({
  agreeing: 3, needed: 3, imports: 2, importsNeeded: 2, explicit: 1, explicitNeeded: 1, missing: [], neverAutoApply: false, neverReason: null, band: 'established', ...over,
})

function populated() {
  const answers = [
    ans('a1', 'Lunch 1'), ans('a2', 'Lunch 2'),
    ans('a3', 'Lunch 3', { confirmed_by: ME.by, confirmedByName: ME.name, confirmed_at: '2026-10-12T10:00:00Z' }),
    ans('a4', 'Lunch 4', { confirmed_by: ME.by, confirmedByName: ME.name, confirmed_at: '2026-10-12T10:05:00Z' }),
    ans('a5', 'Snack 1', { confirmed_by: 'u-gone', confirmedByName: null, asRecorded: true, former: true, confirmed_at: '2026-07-04T10:00:00Z' }),
    ans('x1', 'Boys Cabin Day', { qkind: 'exclusion', verdict: 'all_camp', label: 'All camp', confirmed_at: '2026-07-05T10:00:00Z' }),
    ans('x2', 'Color War', { qkind: 'exclusion', verdict: 'all_camp', label: 'All camp', confirmed_at: '2026-07-06T10:00:00Z' }),
    ans('v1', 'Swim Test', { qkind: 'value', verdict: 'keep', label: 'keep', confirmed_by: ME.by, confirmedByName: ME.name, confirmed_at: '2026-10-10T10:00:00Z' }),
    ans('s1', 'Swim Return', { qkind: 'split', verdict: 'decline', label: 'decline', confirmed_at: '2026-07-07T10:00:00Z' }),
  ]
  const patterns = [
    {
      template: 'T1', key: 'fixed_event|lunch', qkind: 'classify', band: 'established', verdict: 'accept', label: 'Fixed event', agree: 4, disagree: 1,
      names: ['Lunch 4', 'Lunch 3', 'Lunch 2'], progress: progress({ agreeing: 4 }), answerIds: ['a4', 'a3', 'a2', 'a1'],
    },
    {
      template: 'T3', key: 'cit', qkind: 'exclusion', band: 'suggest', verdict: 'all_camp', label: 'All camp', agree: 2, disagree: 0,
      names: ['Color War', 'Boys Cabin Day'], progress: progress({ agreeing: 2, neverAutoApply: true, neverReason: 'kind', band: 'suggest', missing: [] }), answerIds: ['x2', 'x1'],
    },
  ]
  return { answers, patterns }
}

function many() {
  const base = populated()
  const extra = Array.from({ length: 26 }, (_, i) => ans(`m${i}`, `Specialty ${i + 1}`, { confirmed_at: `2026-08-${String(1 + (i % 27)).padStart(2, '0')}T10:00:00Z` }))
  return { answers: [...base.answers, ...extra], patterns: base.patterns }
}

export function createMockLearned(search = '') {
  const mode = new URLSearchParams(search).get('learned')
  const seed = mode === 'empty' ? { answers: [], patterns: [] } : mode === 'many' ? many() : populated()
  let state = { answers: [...seed.answers], patterns: [...seed.patterns] }
  let counter = 100
  const view = () => ({
    answers: state.answers, patterns: state.patterns, vetoes: 0, formerUserAnswers: state.answers.filter((a) => a.asRecorded).length,
    canWrite: mode !== 'readonly', viewerUserId: ME.by, diagnostics: { discarded: 0, tombstoned: 0 },
  })
  return {
    async listLearned() {
      if (mode === 'error') throw new Error('mock load failure')
      return view()
    },
    async changeImportAnswer({ memoryId, verdict }) {
      const found = state.answers.find((a) => a.id === memoryId)
      if (!found) return { ok: false, error: 'NOT_FOUND' }
      const id = `n${counter += 1}`
      state = { ...state, answers: state.answers.map((a) => (a.id === memoryId ? { ...a, id, verdict, asRecorded: false, former: false } : a)) }
      return { ok: true, id }
    },
    async forgetImportAnswer({ memoryId }) {
      if (!state.answers.some((a) => a.id === memoryId)) return { ok: false, error: 'NOT_FOUND' }
      state = { ...state, answers: state.answers.filter((a) => a.id !== memoryId) }
      return { ok: true, retired: [memoryId] }
    },
    async forgetImportPattern({ template, key }) {
      if (!state.patterns.some((p) => p.template === template && p.key === key)) return { ok: false, error: 'NOT_FOUND' }
      state = { ...state, patterns: state.patterns.filter((p) => !(p.template === template && p.key === key)) }
      return { ok: true }
    },
    async keepImportAnswer({ memoryId }) {
      const id = `k${counter += 1}`
      state = { ...state, answers: state.answers.map((a) => (a.id === memoryId ? { ...a, id, asRecorded: false, former: false, confirmed_by: ME.by, confirmedByName: ME.name } : a)) }
      return { ok: true, id }
    },
  }
}
