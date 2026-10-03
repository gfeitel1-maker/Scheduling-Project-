// @vitest-environment jsdom
//
// REGRESSION (T337, CI #736): relayEnablement.js must LOAD under Vite's browser-environment
// transform when @libp2p/dcutr / @libp2p/autonat are ABSENT — the real pre-T336, clean-install
// state (they are not in package.json). A transform-resolvable `import('@libp2p/dcutr')` makes
// Vite's import-analysis hard-fail at TRANSFORM time ("Failed to resolve import @libp2p/dcutr"),
// which took down every jsdom/browser-env suite whose import graph transitively reaches the sync
// stack (the elective *.integration.test.jsx suite failed to LOAD, not on an assertion). The probe
// therefore uses require.resolve, which Vite does not rewrite as an import.
//
// This guard is intentionally a .jsx / jsdom test: the node-environment (.js) relay unit tests do
// NOT exercise Vite's import-analysis and cannot catch this class of break — that is exactly why
// the targeted node-env relay suite passed locally while CI's full browser-env suite went red.
//
// It also re-confirms the owner's load-bearing inertness premise in the faithful state: with the
// foundation absent, holePunchFoundationPresent() is false, so relayRuntimeEligible is false
// regardless of the flag and the relay is never constructed.
import { describe, it, expect } from 'vitest'

describe('T337 — relayEnablement loads under browser-env transform with dcutr absent', () => {
  it('imports without a Vite resolve failure and reports the hole-punch foundation absent', async () => {
    const mod = await import('./relayEnablement.js')
    expect(typeof mod.holePunchFoundationPresent).toBe('function')
    // dcutr/autonat are absent from package.json → require.resolve throws → probe reports absent.
    await expect(mod.holePunchFoundationPresent()).resolves.toBe(false)
  })
})
