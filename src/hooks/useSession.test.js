// @vitest-environment node
// src/hooks/useSession.test.js
import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('../supabase', () => ({
  supabase: {
    auth: {
      getSession: vi.fn(),
      onAuthStateChange: vi.fn(() => ({ data: { subscription: { unsubscribe: vi.fn() } } })),
    },
    from: vi.fn(),
  },
}))

import { supabase } from '../supabase'

describe('useSession', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('resolves campId when a session and camp row exist', async () => {
    const fakeSession = { user: { id: 'user-123' } }
    const fakeCamp = { id: 'camp-abc' }

    supabase.from.mockReturnValue({
      select: vi.fn().mockReturnValue({
        eq: vi.fn().mockReturnValue({
          maybeSingle: vi.fn().mockResolvedValue({ data: fakeCamp }),
        }),
      }),
    })

    const { resolveCampId } = await import('./useSession.js')
    const campId = await resolveCampId(fakeSession)
    expect(campId).toBe('camp-abc')
  })

  it('returns null campId when session is null', async () => {
    const { resolveCampId } = await import('./useSession.js')
    const campId = await resolveCampId(null)
    expect(campId).toBeNull()
  })
})
