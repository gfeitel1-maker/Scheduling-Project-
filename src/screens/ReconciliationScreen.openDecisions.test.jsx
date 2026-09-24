// @vitest-environment jsdom
//
// T237 — entry="openDecisions" is the second, fileless door into this
// screen (docs/work/tickets/T237-attention-rows-open-the-reconciliation-
// flow.md). No baseInputs, no mount-time dry run, no triage/commit
// machinery — read/navigate only.
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, waitFor, fireEvent } from '@testing-library/react'

vi.mock('../localClient', () => ({
  localClient: {
    list: vi.fn().mockResolvedValue([]),
    ingestReconcile: vi.fn(),
    ingestCommit: vi.fn(),
    confirmAlias: vi.fn(),
    getCamp: vi.fn().mockResolvedValue({ id: 'camp-1' }),
    latestOpSeq: vi.fn().mockResolvedValue(0),
    ingestUndo: vi.fn(),
    listOpenReconciliationDecisions: vi.fn(() => Promise.resolve([])),
    dismissOpenReconciliationDecisions: vi.fn(() => Promise.resolve({ ok: true, dismissed: 0 })),
  },
}))

import ReconciliationScreen from './ReconciliationScreen.jsx'
import { localClient } from '../localClient'

beforeEach(() => {
  localClient.ingestReconcile.mockReset()
  localClient.ingestCommit.mockReset()
  localClient.listOpenReconciliationDecisions.mockReset().mockResolvedValue([])
  localClient.dismissOpenReconciliationDecisions.mockReset().mockResolvedValue({ ok: true, dismissed: 0 })
})

describe('ReconciliationScreen entry="openDecisions" (T237)', () => {
  it('never runs the mount-time dry run and renders with no baseInputs', async () => {
    render(<ReconciliationScreen entry="openDecisions" onNavigate={() => {}} />)
    await waitFor(() => expect(screen.queryByText('Open items')).not.toBeNull())
    expect(localClient.ingestReconcile).not.toHaveBeenCalled()
  })

  it('shows no triage/commit control — no progress bar, no apply/commit button', async () => {
    localClient.listOpenReconciliationDecisions.mockResolvedValue([
      { id: 'dec-1', kind: 'confirm_value', domain_key: 'Scheduling', child_key: 'Activities', entity_id: 'a1', entity_name: 'Waterfront', reason: 'No location matched.' },
    ])
    render(<ReconciliationScreen entry="openDecisions" onNavigate={() => {}} />)
    await waitFor(() => expect(screen.queryByText('Waterfront')).not.toBeNull())

    expect(screen.queryByText(/questions answered/)).toBeNull()
    expect(screen.queryByRole('button', { name: /^Apply$/ })).toBeNull()
    expect(screen.queryByRole('button', { name: /Applying/ })).toBeNull()
  })

  it('shows the calm empty state when there are no open decisions', async () => {
    render(<ReconciliationScreen entry="openDecisions" onNavigate={() => {}} />)
    await waitFor(() => expect(screen.queryByText('Nothing needs you right now.')).not.toBeNull())
  })

  it('"Open in {label} →" navigates to the resolved screen', async () => {
    localClient.listOpenReconciliationDecisions.mockResolvedValue([
      { id: 'dec-1', kind: 'confirm_value', domain_key: 'Scheduling', child_key: 'Activities', entity_id: 'a1', entity_name: 'Waterfront', reason: 'No location matched.' },
    ])
    const onNavigate = vi.fn()
    render(<ReconciliationScreen entry="openDecisions" onNavigate={onNavigate} />)
    await waitFor(() => expect(screen.queryByText('Waterfront')).not.toBeNull())

    fireEvent.click(screen.getByRole('button', { name: 'Open in Activities →' }))
    expect(onNavigate).toHaveBeenCalledWith('activities')
  })

  it('"Mark handled" dismisses the decision via the mutation, surfacing a failure through describeWriteFailure', async () => {
    localClient.listOpenReconciliationDecisions.mockResolvedValue([
      { id: 'dec-1', kind: 'confirm_value', domain_key: 'Scheduling', child_key: 'Activities', entity_id: 'a1', entity_name: 'Waterfront', reason: 'No location matched.' },
    ])
    localClient.dismissOpenReconciliationDecisions.mockResolvedValue({ ok: true, dismissed: 1 })
    render(<ReconciliationScreen entry="openDecisions" onNavigate={() => {}} />)
    await waitFor(() => expect(screen.queryByText('Waterfront')).not.toBeNull())

    fireEvent.click(screen.getByRole('button', { name: 'Mark handled' }))
    await waitFor(() => expect(localClient.dismissOpenReconciliationDecisions).toHaveBeenCalledWith(['dec-1']))
  })

  it('surfaces a failed "Mark handled" mutation rather than swallowing it', async () => {
    localClient.listOpenReconciliationDecisions.mockResolvedValue([
      { id: 'dec-1', kind: 'confirm_value', domain_key: 'Scheduling', child_key: 'Activities', entity_id: 'a1', entity_name: 'Waterfront', reason: 'No location matched.' },
    ])
    localClient.dismissOpenReconciliationDecisions.mockRejectedValue(new Error('write timed out after 5000ms'))
    render(<ReconciliationScreen entry="openDecisions" onNavigate={() => {}} />)
    await waitFor(() => expect(screen.queryByText('Waterfront')).not.toBeNull())

    fireEvent.click(screen.getByRole('button', { name: 'Mark handled' }))
    await waitFor(() => expect(screen.queryByText(/Could not mark this item handled/)).not.toBeNull())
  })

  it('an unrecognised "Mark handled" failure does not point the director at a log they cannot open', async () => {
    localClient.listOpenReconciliationDecisions.mockResolvedValue([
      { id: 'dec-1', kind: 'confirm_value', domain_key: 'Scheduling', child_key: 'Activities', entity_id: 'a1', entity_name: 'Waterfront', reason: 'No location matched.' },
    ])
    localClient.dismissOpenReconciliationDecisions.mockRejectedValue(new Error('boom, something truly unrecognised'))
    render(<ReconciliationScreen entry="openDecisions" onNavigate={() => {}} />)
    await waitFor(() => expect(screen.queryByText('Waterfront')).not.toBeNull())

    fireEvent.click(screen.getByRole('button', { name: 'Mark handled' }))
    await waitFor(() => expect(screen.queryByText(/Could not mark this item handled/)).not.toBeNull())
    expect(screen.queryByText(/the log/)).toBeNull()
    expect(screen.queryByText(/try again/i)).not.toBeNull()
  })

  it('tells the director what "Mark handled" actually does — not destructive, not undoable here', async () => {
    localClient.listOpenReconciliationDecisions.mockResolvedValue([
      { id: 'dec-1', kind: 'confirm_value', domain_key: 'Scheduling', child_key: 'Activities', entity_id: 'a1', entity_name: 'Waterfront', reason: 'No location matched.' },
    ])
    render(<ReconciliationScreen entry="openDecisions" onNavigate={() => {}} />)
    await waitFor(() => expect(screen.queryByText('Waterfront')).not.toBeNull())

    expect(screen.getByText(/mark it handled/i).textContent).toMatch(/won't change|doesn't change|does not change/i)
    expect(screen.getByText(/mark it handled/i).textContent).toMatch(/can't be undone|cannot be undone/i)
  })

  it('entry="import" (the default) is unaffected — the normal dry run still runs', async () => {
    localClient.ingestReconcile.mockResolvedValue({ planItems: [] })
    render(<ReconciliationScreen baseInputs={{ approved: {}, cohort_id: null, mode: 'add' }} sourceLabel="test.xlsx" onNavigate={() => {}} />)
    await waitFor(() => expect(localClient.ingestReconcile).toHaveBeenCalled())
    expect(localClient.listOpenReconciliationDecisions).not.toHaveBeenCalled()
  })
})
