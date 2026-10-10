// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'

vi.mock('../localClient', () => ({
  localClient: {
    listToolAuthorizations: vi.fn(),
    grantToolAuthorization: vi.fn(),
    revokeToolAuthorization: vi.fn(),
  },
}))

import ConnectedToolsPanel from './ConnectedToolsPanel'
import { localClient } from '../localClient'

const tool = (o = {}) => ({ id: 't1', label: 'MCP', scope: 'read', created_at: '2026-10-08T00:00:00.000Z', revoked_at: null, ...o })

beforeEach(() => {
  vi.clearAllMocks()
  localClient.listToolAuthorizations.mockResolvedValue([])
})

describe('ConnectedToolsPanel', () => {
  it('lists tools with their access and a Revoke control; revoked ones show no control', async () => {
    localClient.listToolAuthorizations.mockResolvedValue([tool(), tool({ id: 't2', label: 'Old', revoked_at: '2026-10-09T00:00:00.000Z' })])
    render(<ConnectedToolsPanel />)
    expect(await screen.findByText('MCP')).toBeTruthy()
    expect(screen.getAllByRole('button', { name: 'Revoke' })).toHaveLength(1)
    expect(screen.getByText(/Revoked/)).toBeTruthy()
  })

  it('grant shows the secret once and clears it on dismiss', async () => {
    localClient.grantToolAuthorization.mockResolvedValue({ secret: 'abc.def', authorization: tool() })
    render(<ConnectedToolsPanel />)
    await userEvent.type(await screen.findByLabelText('Tool name'), 'MCP')
    await userEvent.selectOptions(screen.getByLabelText('Access'), 'read-write')
    await userEvent.click(screen.getByRole('button', { name: 'Authorize tool' }))
    expect(localClient.grantToolAuthorization).toHaveBeenCalledWith('MCP', 'read-write')
    expect(await screen.findByText('abc.def')).toBeTruthy()
    await userEvent.click(screen.getByRole('button', { name: /saved it/ }))
    expect(screen.queryByText('abc.def')).toBeNull()
  })

  it('surfaces a grant failure and a revoke failure', async () => {
    localClient.grantToolAuthorization.mockRejectedValue(new Error('admin role required'))
    localClient.listToolAuthorizations.mockResolvedValue([tool()])
    localClient.revokeToolAuthorization.mockRejectedValue(new Error('Tool authorization not found'))
    render(<ConnectedToolsPanel />)
    await userEvent.type(await screen.findByLabelText('Tool name'), 'X')
    await userEvent.click(screen.getByRole('button', { name: 'Authorize tool' }))
    expect((await screen.findByRole('alert')).textContent).toMatch(/admin role required/)
    await userEvent.click(screen.getByRole('button', { name: 'Revoke' }))
    await waitFor(() => expect(screen.getByRole('alert').textContent).toMatch(/not found/))
  })

  it('keeps the explanation to one plain line; the caveats live in SECURITY.md', async () => {
    render(<ConnectedToolsPanel />)
    expect(await screen.findByText(/Revoke any of them at any time/)).toBeTruthy()
    expect(screen.queryByText(/not a lock/)).toBeNull()
  })
})
