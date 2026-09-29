// @vitest-environment jsdom
//
// T297 — the localClient WRAPPER forwards every argument it is given.
//
// WHY THIS FILE EXISTS, because it looks like testing a one-line passthrough.
// `src/localClient.js` enumerates arguments explicitly rather than spreading —
// deliberately, so a caller-supplied token cannot override the real one — and the
// cost of that rule is that a new argument has to be added by hand at the
// wrapper, at the preload channel, AND at the main-process handler. Miss any one
// and the field is dropped silently: the call still succeeds, the op still
// writes, and only the BEHAVIOUR the argument controls quietly disappears.
//
// That happened here. `replacesPreferenceId` was enumerated at the op and at the
// screen and at neither hop between, so every edit the UI made fell through to
// the "add" branch — the scope-inheritance design was unreachable from the
// screen while its own unit tests passed. ipcSurfaceParity.test.js cannot catch
// it: that gate reads the KEYS of the two surfaces, never their arguments.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

// THIS ENVIRONMENT'S localStorage IS INERT, and that is worth stating rather
// than working around silently: under this repo's jsdom, `localStorage` exists as
// an object whose `setItem`/`getItem` are undefined (confirmed by probing —
// href is http://localhost:3000 and the object is there, the methods are not).
// No other renderer test notices, because they all mock `localClient` wholesale
// and so never reach its `currentToken()`. This file is testing that very
// function's neighbour, so it supplies a real one.
const store = new Map()
beforeEach(() => {
  vi.resetModules()
  store.clear()
  vi.stubGlobal('localStorage', {
    getItem: (k) => (store.has(k) ? store.get(k) : null),
    setItem: (k, v) => store.set(k, String(v)),
    removeItem: (k) => store.delete(k),
    clear: () => store.clear(),
  })
  localStorage.setItem('shoresh-token', 'tok-1')
})

afterEach(() => {
  delete window.shoresh
  vi.unstubAllGlobals()
})

// The real wrapper, in front of a recording channel. `window.shoresh` has to be
// set BEFORE the module is imported, because localClient.js picks the channel up
// at load time and falls back to the dev mock otherwise.
async function clientWith(channel) {
  window.shoresh = channel
  const { localClient } = await import('./localClient.js')
  return localClient
}

describe('localClient.setElectivePreference', () => {
  it('forwards every argument the op acts on, replacesPreferenceId included', async () => {
    const setElectivePreference = vi.fn(async () => ({ ok: true }))
    const client = await clientWith({ setElectivePreference })

    await client.setElectivePreference({
      runId: 'run-1', camperId: 'cam-1', occurrenceId: 'occ-1', choiceId: 'choice-1',
      rank: 2, rankKind: 'ordered-fallback', replacesPreferenceId: 'pref-1',
    })

    expect(setElectivePreference).toHaveBeenCalledTimes(1)
    // The whole argument object, asserted exhaustively rather than field by
    // field: a NEW argument added at the op and forgotten here is the defect
    // this file exists for, and only an exhaustive assertion notices one.
    expect(setElectivePreference.mock.calls[0][0]).toEqual({
      token: 'tok-1',
      runId: 'run-1', camperId: 'cam-1', occurrenceId: 'occ-1', choiceId: 'choice-1',
      rank: 2, rankKind: 'ordered-fallback', replacesPreferenceId: 'pref-1',
    })
  })

  it('sends explicit nulls for the optional arguments rather than omitting them', async () => {
    // `undefined` does not survive Electron's structured clone the way null does,
    // and the handler distinguishes "not given" from "given as null".
    const setElectivePreference = vi.fn(async () => ({ ok: true }))
    const client = await clientWith({ setElectivePreference })
    await client.setElectivePreference({
      runId: 'run-1', camperId: 'cam-1', occurrenceId: 'occ-1', choiceId: 'choice-1',
    })
    expect(setElectivePreference.mock.calls[0][0]).toMatchObject({
      rank: null, rankKind: null, replacesPreferenceId: null,
    })
  })
})

describe('localClient.removeElectivePreference', () => {
  it('forwards the run and the preference', async () => {
    const removeElectivePreference = vi.fn(async () => ({ ok: true }))
    const client = await clientWith({ removeElectivePreference })
    await client.removeElectivePreference({ runId: 'run-1', preferenceId: 'pref-1' })
    expect(removeElectivePreference.mock.calls[0][0]).toEqual({
      token: 'tok-1', runId: 'run-1', preferenceId: 'pref-1',
    })
  })
})
