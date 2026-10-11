// @vitest-environment jsdom
//
// Packaged audit: on a re-import showing "0 of 18 questions answered", clicking "Add it" on ONE card made
// the counter read "1 of 1" and the other 17 vanished. The dry run after an answer is folded with the
// answers, and a fold withholds every UNANSWERED confirm_value from the plan, so the next report stopped
// raising them. The fake below behaves like the real planner in that one respect: it only plans what the
// folded inputs still approve.
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'

vi.mock('../localClient', () => ({
  localClient: {
    list: vi.fn(),
    ingestReconcile: vi.fn(),
    ingestCommit: vi.fn(),
    confirmAlias: vi.fn().mockResolvedValue({}),
    getCamp: vi.fn().mockResolvedValue({ id: 'camp-1' }),
    latestOpSeq: vi.fn().mockResolvedValue(0),
    ingestUndo: vi.fn(),
    matchImportAnswers: vi.fn().mockResolvedValue({}),
    rememberImportAnswers: vi.fn(),
    recordImportDecisions: vi.fn(),
    forgetImportAnswer: vi.fn(),
    listLearned: vi.fn(async () => ({ canWrite: true, answers: [], patterns: [] })),
  },
}))

import ReconciliationScreen from './ReconciliationScreen.jsx'
import { importSessions } from './importSessions.js'
import { localClient } from '../localClient'

const NAMES = ['Sports', 'Archery', 'Swim']
const baseInputs = { approved: { activities: [...NAMES] }, cohort_id: null, mode: 'add' }

beforeEach(() => {
  vi.clearAllMocks()
  importSessions.clear()
  const mem = {}
  vi.stubGlobal('localStorage', { getItem: (k) => mem[k] ?? null, setItem: (k, v) => { mem[k] = v }, removeItem: (k) => { delete mem[k] } })
  localClient.list.mockResolvedValue([{ id: 'x' }])
  localClient.matchImportAnswers.mockResolvedValue({})
  localClient.ingestReconcile.mockImplementation(async (inputs) => ({
    planItems: (inputs.approved?.activities ?? []).map((name) => ({
      op: 'create', entity: 'activities', entity_id: null, _name: name, _humanFields: [], evidence: { tier: 'low' },
      fields: { name: { from: null, to: name, source: 'import' } },
    })),
    fixedEventsReport: { created: [] }, legacyPriorityActivities: [], fieldProvenance: {}, evidenceSupport: {},
  }))
})

describe('the question counter after one card is answered', () => {
  it('keeps the unanswered cards in the count', async () => {
    render(<ReconciliationScreen baseInputs={baseInputs} sourceLabel="camp.xlsx" onCommitted={vi.fn()} onDiscard={vi.fn()} onNavigate={vi.fn()} />)
    await screen.findByText(/0 of 3 questions answered/)
    await userEvent.click(screen.getAllByText('Add it')[0])
    await waitFor(() => expect(localClient.ingestReconcile).toHaveBeenCalledTimes(2), { timeout: 2000 })
    await screen.findByText(/1 of 3 questions answered/)
  })
})
