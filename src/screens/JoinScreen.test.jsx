// @vitest-environment jsdom
//
// W12b (docs/work/specs/2026-08-22-brand-placement-round2.md §2) — the
// 📡 emoji in the "no camps found" empty state is replaced with the sliced
// decorative-magnifier tile. The searching state is untouched.
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'

vi.mock('../localClient', () => ({
  localClient: { discoverHosts: vi.fn() },
}))

import JoinScreen from './JoinScreen'
import { localClient } from '../localClient'

beforeEach(() => {
  vi.clearAllMocks()
})

describe('JoinScreen brand placement', () => {
  it('shows the magnifier icon, not the 📡 emoji, when no camps are found', async () => {
    localClient.discoverHosts.mockResolvedValue([])
    render(<JoinScreen onBack={vi.fn()} onSelectHost={vi.fn()} />)

    await waitFor(() => expect(screen.getByText('No camps found nearby')).toBeTruthy())
    expect(screen.getByAltText('')).toBeTruthy()
    expect(screen.queryByText('📡')).toBeNull()
  })

  it('does not add imagery to the searching state', () => {
    localClient.discoverHosts.mockReturnValue(new Promise(() => {})) // never resolves
    render(<JoinScreen onBack={vi.fn()} onSelectHost={vi.fn()} />)

    expect(screen.getByText(/Looking for a camp on your network/)).toBeTruthy()
    expect(screen.queryByAltText('')).toBeNull()
  })
})

// PRIVACY (electron/sync/discovery.js): the mDNS broadcast carries an opaque
// camp tag, never the camp's human-readable name. The picker must therefore
// identify a Host by address, and must never render a name it was handed —
// there is none to render.
describe('JoinScreen host picker — no camp name on screen', () => {
  const host = { campTag: 'camp-1a2b3c4d5e6f7a8b', host: '192.168.1.42', port: 7000 }

  it('identifies a discovered host by address and opaque tag', async () => {
    localClient.discoverHosts.mockResolvedValue([host])
    render(<JoinScreen onBack={vi.fn()} onSelectHost={vi.fn()} />)

    await waitFor(() => expect(screen.getByText('192.168.1.42')).toBeTruthy())
    expect(screen.getByText(/camp-1a2b3c4d5e6f7a8b/)).toBeTruthy()
    expect(screen.getByText(/Camp names aren't broadcast/)).toBeTruthy()
  })

  it('passes the discovered host through to onSelectHost', async () => {
    const onSelectHost = vi.fn()
    localClient.discoverHosts.mockResolvedValue([host])
    render(<JoinScreen onBack={vi.fn()} onSelectHost={onSelectHost} />)

    await waitFor(() => expect(screen.getByText('192.168.1.42')).toBeTruthy())
    screen.getByText('192.168.1.42').closest('button').click()
    expect(onSelectHost).toHaveBeenCalledWith(host)
  })
})
