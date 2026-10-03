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
// stops relay from running ahead of dcutr's mere EXISTENCE in the build.
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
