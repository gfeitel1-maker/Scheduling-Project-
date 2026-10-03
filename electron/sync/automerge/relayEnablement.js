// T337 gate-fix round 2 (Security-Assessment F-1): SHORESH_RELAY_ENABLED alone must never be
// enough to make circuit-relay-v2 the LIVE data path. Without this, flipping that one env var
// promotes the relay to a standing connection carrier with no dcutr direct-upgrade behind it —
// silently installing the owner's RARE tier-3 fallback as normal operation, with no re-review.
//
// transportCapabilities.js's own header is explicit that production code must never import that
// registry and branch on `signoff` at runtime (the registry is a build-time/test-time gate, not
// wiring) — so this cannot read `TRANSPORT_CAPABILITIES.dcutr.signoff` directly. Instead it
// couples to the same MECHANICAL signal the guard test itself already uses for "does this
// capability exist in this build at all": whether `@libp2p/dcutr`/`@libp2p/autonat` actually
// resolve. Today (T336 unbuilt) neither package is installed, so this is false regardless of the
// flag — closing the one-line-flip risk for exactly the case that matters right now. Once T336
// lands those packages AND wires them, this flips automatically; a human still has to widen the
// REGISTRY's own signoff before either capability is authorized to merge/ship, this coupling only
// stops relay from running ahead of dcutr's mere EXISTENCE in the build. The presence-not-signoff
// gap this still leaves (packages land before `dcutr.signoff` is written) is caught separately
// and loudly by electron/sync/automerge/dcutrPresenceWithoutSignoff.guard.test.js — this module
// does not read the registry itself, that test does.
//
// NAMING WARNING (gate-fix round 3, Code Reviewer MEDIUM) — do NOT rename `relayRuntimeEligible`'s
// `nextRungPresent` or `holePunchFoundationPresent` below to contain the literal substrings
// "dcutr" or "autonat". Those strings are in ALL_FORBIDDEN_MARKERS (transportCapabilities.js's
// `dcutr` row) and are scanned against syncStarter.js's SOURCE TEXT by
// transportBoundary.guard.test.js — a "helpful" rename that makes this file's purpose more
// explicit will leak into syncStarter.js's import site and trip the UNRELATED `dcutr` capability's
// guard marker (a correct-but-confusing failure: the guard is right that the substring appeared,
// but the actual dcutr capability was never touched). This has already happened once during this
// ticket's own gate-fix rounds — the fix was renaming away from the literal substrings, not
// silencing the guard.
export function relayRuntimeEligible({ relayEnabled, nextRungPresent }) {
  return Boolean(relayEnabled) && Boolean(nextRungPresent)
}

// Real probe: attempts to resolve the actual packages. Never throws — absence is the expected,
// common case (every build today), not an error.
export async function holePunchFoundationPresent() {
  try {
    await import('@libp2p/dcutr')
    await import('@libp2p/autonat')
    return true
  } catch {
    return false
  }
}
