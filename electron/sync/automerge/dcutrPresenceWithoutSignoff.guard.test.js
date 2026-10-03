// TIER-4 ENFORCEABLE BOUNDARY GUARD, sibling to transportBoundary.guard.test.js — T337 gate-fix
// round 3 (Red Hat MEDIUM): closes the presence-not-signoff gap in relayEnablement.js.
//
// relayEnablement.js's coupling checks whether `@libp2p/dcutr`/`@libp2p/autonat` are IMPORTABLE,
// not whether the `dcutr` capability row is actually SIGNED OFF (transportCapabilities.js's own
// header forbids production code from reading `signoff` at runtime, so that coupling cannot be
// any tighter at the SOURCE level). The gap this leaves: the moment T336 lands those packages —
// even transitively, before `dcutr.signoff` is written — relayEnablement.js's probe silently
// flips from false to true, and (per the T337 round-3 doc correction: a relay reservation is
// STANDING, not disposable) that is the exact "relay as the only path, indefinitely" shape this
// whole program exists to avoid. This guard makes that window a LOUD, mechanical build failure
// instead of a silent promotion: either both packages are absent from the resolved dependency
// tree, or `dcutr.signoff` is non-null. One of those two must always be true.
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { forbiddenPackagesPresent } from './internetRendezvousScan.js'
import { TRANSPORT_CAPABILITIES } from './transportCapabilities.js'

const __dirname = dirname(fileURLToPath(import.meta.url))
const repoRoot = join(__dirname, '..', '..', '..')

const DCUTR_PACKAGES = ['@libp2p/dcutr', '@libp2p/autonat']

describe('dcutr-present-without-signoff guard (T337 gate-fix round 3)', () => {
  it('invariant: dcutr/autonat are absent from the resolved tree, OR dcutr.signoff is non-null', () => {
    const lockfile = JSON.parse(readFileSync(join(repoRoot, 'package-lock.json'), 'utf8'))
    const present = forbiddenPackagesPresent(lockfile.packages, DCUTR_PACKAGES)
    const signedOff = TRANSPORT_CAPABILITIES.dcutr.signoff != null

    expect(
      present.length === 0 || signedOff,
      `@libp2p/dcutr/@libp2p/autonat present in the resolved dependency tree (${present.join(', ')}) ` +
        `while TRANSPORT_CAPABILITIES.dcutr.signoff is still null. relayEnablement.js's presence-` +
        `based coupling would now read these as "the hole-punch foundation exists" and could flip ` +
        `relay to runtime-eligible even though the dcutr capability itself has not cleared its own ` +
        `review gate. Either hold off landing these packages until dcutr.signoff is written in the ` +
        `SAME change, or do not write a signoff without the packages actually present.`
    ).toBe(true)
  })

  // Non-vacuity, red-before-green (per the T337 round-3 instruction): prove the assertion above
  // actually fires on a planted violation, using the SAME helper the real assertion uses, before
  // trusting that it passes today for the right reason (packages absent) rather than vacuously.
  it('RED: a synthetic lockfile with @libp2p/dcutr present + dcutr.signoff null fails the invariant', () => {
    const syntheticLockfilePackages = {
      'node_modules/@libp2p/dcutr': {},
    }
    const present = forbiddenPackagesPresent(syntheticLockfilePackages, DCUTR_PACKAGES)
    const signedOffInThisScenario = false // mirrors the real registry's current dcutr.signoff: null

    expect(present).toEqual(['@libp2p/dcutr'])
    expect(present.length === 0 || signedOffInThisScenario).toBe(false) // the invariant WOULD fail here
  })

  it('GREEN today: the real resolved tree has neither package present (confirmed against package-lock.json)', () => {
    const lockfile = JSON.parse(readFileSync(join(repoRoot, 'package-lock.json'), 'utf8'))
    expect(forbiddenPackagesPresent(lockfile.packages, DCUTR_PACKAGES)).toEqual([])
  })

  // Companion non-vacuity: the invariant must also tolerate the OTHER honest resolution (packages
  // present AND signed off) — it should not be structured as "packages must always be absent".
  it('the invariant also accepts the opposite honest state: present AND signed off', () => {
    const present = ['@libp2p/dcutr', '@libp2p/autonat']
    const signedOff = true
    expect(present.length === 0 || signedOff).toBe(true)
  })
})
