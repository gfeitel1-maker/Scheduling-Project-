// @vitest-environment node
//
// Stage 5c review round: Finding 1 (never start the sync node against an unseeded doc) and
// Finding 2 (coalesce a wide remote-ops batch into one full-sync event). Pure-function tests,
// no Electron.
import { describe, it, expect, vi } from 'vitest'
import { resolveStartupDoc, dispatchRemoteOps, REMOTE_OPS_COALESCE_THRESHOLD } from './startupGuard.js'

describe('resolveStartupDoc — Finding 1', () => {
  it('returns null when neither liveDoc nor a persisted doc exists (caller must refuse to start)', () => {
    expect(resolveStartupDoc({ liveDoc: null, persistedDoc: null })).toBeNull()
  })

  it('prefers liveDoc over the persisted doc when both exist', () => {
    const liveDoc = { marker: 'live' }
    const persistedDoc = { marker: 'persisted' }
    expect(resolveStartupDoc({ liveDoc, persistedDoc })).toBe(liveDoc)
  })

  it('falls back to the persisted doc when liveDoc has not been loaded yet', () => {
    const persistedDoc = { marker: 'persisted' }
    expect(resolveStartupDoc({ liveDoc: null, persistedDoc })).toBe(persistedDoc)
  })

  it('never fabricates a document — there is no third fallback', () => {
    // Regression guard against reintroducing `?? createEmptyDoc()`: with both inputs falsy the
    // result must be exactly null, not an object.
    const result = resolveStartupDoc({ liveDoc: undefined, persistedDoc: undefined })
    expect(result).toBeNull()
  })
})

describe('dispatchRemoteOps — Finding 2', () => {
  it('sends one op-applied event per field, sanitized, when at or below the threshold', () => {
    const send = vi.fn()
    const sanitizeOpForIpc = vi.fn((e) => ({ ...e, sanitized: true }))
    const events = Array.from({ length: REMOTE_OPS_COALESCE_THRESHOLD }, (_, i) => ({ field: `f${i}` }))

    dispatchRemoteOps(events, { send, sanitizeOpForIpc })

    expect(sanitizeOpForIpc).toHaveBeenCalledTimes(REMOTE_OPS_COALESCE_THRESHOLD)
    expect(send).toHaveBeenCalledTimes(REMOTE_OPS_COALESCE_THRESHOLD)
    for (const [channel, payload] of send.mock.calls) {
      expect(channel).toBe('shoresh:op-applied')
      expect(payload.sanitized).toBe(true)
    }
  })

  it('sends a single full-sync-applied event, unsanitized, above the threshold', () => {
    const send = vi.fn()
    const sanitizeOpForIpc = vi.fn((e) => e)
    const events = Array.from({ length: REMOTE_OPS_COALESCE_THRESHOLD + 1 }, (_, i) => ({ field: `f${i}` }))

    dispatchRemoteOps(events, { send, sanitizeOpForIpc })

    expect(send).toHaveBeenCalledTimes(1)
    expect(send).toHaveBeenCalledWith('shoresh:full-sync-applied')
    expect(sanitizeOpForIpc).not.toHaveBeenCalled()
  })

  it('sends nothing when there are no events', () => {
    const send = vi.fn()
    dispatchRemoteOps([], { send, sanitizeOpForIpc: (e) => e })
    expect(send).not.toHaveBeenCalled()
  })

  it('honors a custom threshold override', () => {
    const send = vi.fn()
    dispatchRemoteOps([{ field: 'a' }, { field: 'b' }, { field: 'c' }], {
      send,
      sanitizeOpForIpc: (e) => e,
      threshold: 2,
    })
    expect(send).toHaveBeenCalledTimes(1)
    expect(send).toHaveBeenCalledWith('shoresh:full-sync-applied')
  })
})
