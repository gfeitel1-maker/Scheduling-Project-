// @vitest-environment jsdom
// T359 slice 4 - the director's router-opening flag. null (unknown, flag off, mapper not started)
// renders nothing; 'mapped' is deliberately silent; every other status is one line plus a plain why.
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import { STATUSES, PERMANENT_LEASE_REASON } from '../../electron/sync/automerge/portMapping.js'

vi.mock('../localClient', () => ({ localClient: { getPortMappingStatus: vi.fn() } }))

import PortMappingFlag from './PortMappingFlag'
import { localClient } from '../localClient'

function payloadFor(status) {
  return status === 'permanent-lease' ? { status, reason: PERMANENT_LEASE_REASON } : { status }
}

beforeEach(() => vi.clearAllMocks())

describe('PortMappingFlag', () => {
  it('renders nothing when the getter returns null (flag off, mapper not started, unknown)', async () => {
    localClient.getPortMappingStatus.mockResolvedValue(null)
    const { container } = render(<PortMappingFlag />)
    await waitFor(() => expect(localClient.getPortMappingStatus).toHaveBeenCalled())
    await new Promise((r) => setTimeout(r, 20))
    expect(container.innerHTML).toBe("")
  })

  it('renders nothing when the getter rejects', async () => {
    localClient.getPortMappingStatus.mockRejectedValue(new Error('no ipc'))
    const { container } = render(<PortMappingFlag />)
    await waitFor(() => expect(localClient.getPortMappingStatus).toHaveBeenCalled())
    await new Promise((r) => setTimeout(r, 20))
    expect(container.innerHTML).toBe("")
  })

  it('renders nothing for mapped: a working opening needs no attention', async () => {
    localClient.getPortMappingStatus.mockResolvedValue(payloadFor('mapped'))
    const { container } = render(<PortMappingFlag />)
    await waitFor(() => expect(localClient.getPortMappingStatus).toHaveBeenCalled())
    await new Promise((r) => setTimeout(r, 20))
    expect(container.innerHTML).toBe("")
  })

  it('permanent-lease shows the router-keeps-the-opening reason', async () => {
    localClient.getPortMappingStatus.mockResolvedValue(payloadFor('permanent-lease'))
    render(<PortMappingFlag />)
    expect(await screen.findByText(new RegExp(PERMANENT_LEASE_REASON, 'i'))).toBeTruthy()
  })

  const flagged = STATUSES.filter((s) => s !== 'mapped')
  it.each(flagged)('%s renders a one-line flag and a why, with no raw status string or jargon', async (status) => {
    localClient.getPortMappingStatus.mockResolvedValue(payloadFor(status))
    render(<PortMappingFlag />)
    const flag = await screen.findByTestId('port-mapping-flag')
    expect(flag.dataset.status).toBe(status)
    expect(screen.getByTestId('port-mapping-flag-line').textContent.length).toBeGreaterThan(10)
    expect(screen.getByTestId('port-mapping-flag-why').textContent.length).toBeGreaterThan(20)
    expect(flag.textContent).not.toContain(status)
    expect(flag.textContent).not.toMatch(/\b(NAT|UPnP|IGDA?|lease|externalIp)\b/i)
    expect(screen.queryByRole('button')).toBeNull()
  })

  it('shows nothing for a status it does not know', async () => {
    localClient.getPortMappingStatus.mockResolvedValue({ status: 'something-new' })
    const { container } = render(<PortMappingFlag />)
    await waitFor(() => expect(localClient.getPortMappingStatus).toHaveBeenCalled())
    await new Promise((r) => setTimeout(r, 20))
    expect(container.innerHTML).toBe("")
  })
})
