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
