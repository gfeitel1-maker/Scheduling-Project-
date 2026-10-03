// @vitest-environment jsdom
//
// REGRESSION (T337, CI #736): relayEnablement.js must LOAD under Vite's browser-environment
// transform without a resolve failure — the property holds whether @libp2p/dcutr is ABSENT (the
// pre-T336 clean-install state) or PRESENT (today, after 377c28f0). The hazard this guards against:
// a transform-resolvable `import('@libp2p/dcutr')` makes Vite's import-analysis hard-fail at
// TRANSFORM time when the package is absent ("Failed to resolve import @libp2p/dcutr"), which took
// down every jsdom/browser-env suite whose import graph transitively reaches the sync stack (the
// elective *.integration.test.jsx suite failed to LOAD, not on an assertion). The probe therefore
// uses require.resolve, which Vite does not rewrite as an import — so this module transforms cleanly
// in either package state. (AutoNAT is not part of the foundation and not installed — T336 ships
// dcutr only; the probe keys off dcutr alone.)
//
// This guard is intentionally a .jsx / jsdom test: the node-environment (.js) relay unit tests do
// NOT exercise Vite's import-analysis and cannot catch this class of break — that is exactly why
// the targeted node-env relay suite passed locally while CI's full browser-env suite went red.
import { describe, it, expect } from 'vitest'

describe('T337/T336 — relayEnablement loads cleanly under browser-env transform', () => {
  it('imports without a Vite resolve failure and reports the foundation present (dcutr installed)', async () => {
    const mod = await import('./relayEnablement.js')
    expect(typeof mod.holePunchFoundationPresent).toBe('function')
    // @libp2p/dcutr is installed (T336 foundation) → require.resolve succeeds → probe reports present.
    // The point of this test is that the import above does not throw a Vite transform-time resolve
    // error regardless of that truth value.
    await expect(mod.holePunchFoundationPresent()).resolves.toBe(true)
  })
})
