// T337 gate-fix round 2 (Security-Assessment F-1): SHORESH_RELAY_ENABLED=true alone must never
// be sufficient to activate the relay as a live data path — it must also require dcutr to exist
// in this build, closing the "one-line flag flip silently promotes relay to primary" risk.
import { describe, it, expect } from 'vitest'
import { relayRuntimeEligible, holePunchFoundationPresent } from './relayEnablement.js'

describe('relayRuntimeEligible — composition logic', () => {
  it('requires BOTH the flag and dcutr presence', () => {
    expect(relayRuntimeEligible({ relayEnabled: true, nextRungPresent: true })).toBe(true)
    expect(relayRuntimeEligible({ relayEnabled: true, nextRungPresent: false })).toBe(false)
    expect(relayRuntimeEligible({ relayEnabled: false, nextRungPresent: true })).toBe(false)
    expect(relayRuntimeEligible({ relayEnabled: false, nextRungPresent: false })).toBe(false)
  })
})

describe('holePunchFoundationPresent — real probe against this build', () => {
  // Against the actually-installed tree (org-source-verification): T336 landed @libp2p/dcutr@3.0.28
  // (377c28f0), so the hole-punch foundation IS present and this probe resolves TRUE. (AutoNAT is
  // not part of the foundation and not installed — see relayEnablement.js header; the probe keys off
  // dcutr alone.) Presence of the package does NOT by itself activate anything: relayRuntimeEligible
  // still requires SHORESH_RELAY_ENABLED, which defaults false — asserted in relayEnablement's
  // composition table above and in holePunchInertnessWithPackages.test.js.
  it('resolves true — @libp2p/dcutr is installed in this build (T336 foundation)', async () => {
    await expect(holePunchFoundationPresent()).resolves.toBe(true)
  })
})
