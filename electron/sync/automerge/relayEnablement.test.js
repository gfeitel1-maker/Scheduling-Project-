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
  // RED/documenting baseline, against the actually-installed tree (org-source-verification):
  // T336 is unbuilt — @libp2p/dcutr and @libp2p/autonat are not in package.json/package-lock.json
  // today (confirmed: `grep '"@libp2p/dcutr"' package.json` finds nothing). So this probe must
  // return false, REGARDLESS of SHORESH_RELAY_ENABLED, until T336 actually lands those packages.
  it('resolves false today — dcutr/autonat are not installed in this build', async () => {
    await expect(holePunchFoundationPresent()).resolves.toBe(false)
  })
})
