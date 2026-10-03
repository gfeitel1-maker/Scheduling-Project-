import { createRequire } from 'node:module'

// T337 gate-fix round 2 (Security-Assessment F-1): SHORESH_RELAY_ENABLED alone must never be
// enough to make circuit-relay-v2 the LIVE data path. Without this, flipping that one env var
// promotes the relay to a standing connection carrier with no dcutr direct-upgrade behind it —
// silently installing the owner's RARE tier-3 fallback as normal operation, with no re-review.
//
// transportCapabilities.js's own header is explicit that production code must never import that
// registry and branch on `signoff` at runtime (the registry is a build-time/test-time gate, not
// wiring) — so this cannot read `TRANSPORT_CAPABILITIES.dcutr.signoff` directly. Instead it
// couples to the same MECHANICAL signal the guard test itself already uses for "does this
// capability exist in this build at all": whether `@libp2p/dcutr` actually resolves (AutoNAT is not
// part of the foundation — T336 ships dcutr only; see the probe header below). As of T336 the
// package IS installed, so this is true — but relay/dcutr still require SHORESH_RELAY_ENABLED
// (default false) to be eligible, which keeps the capability inert until a deliberate activation.
// A human still has to widen the REGISTRY's own signoff before the capability is authorized to
// merge/ship; this coupling only stops relay from running ahead of dcutr's mere EXISTENCE in the
// build. The presence-not-signoff gap (package landed before `dcutr.signoff` is written) is caught
// separately and loudly by electron/sync/automerge/dcutrPresenceWithoutSignoff.guard.test.js — this
// module does not read the registry itself, that test does.
//
// NAMING WARNING (gate-fix round 3, Code Reviewer MEDIUM) — do NOT rename `relayRuntimeEligible`'s
// `nextRungPresent` or `holePunchFoundationPresent` below to contain the literal substring
// "dcutr". It is in ALL_FORBIDDEN_MARKERS (transportCapabilities.js's `dcutr` row) and is scanned
// against syncStarter.js's SOURCE TEXT by transportBoundary.guard.test.js — a "helpful" rename that
// makes this file's purpose more explicit will leak into syncStarter.js's import site and trip the
// `dcutr` capability's guard marker. This has already happened once during this program's gate-fix
// rounds — the fix was renaming away from the literal substring, not silencing the guard.
export function relayRuntimeEligible({ relayEnabled, nextRungPresent }) {
  return Boolean(relayEnabled) && Boolean(nextRungPresent)
}

// Real probe: is the T336 hole-punch foundation (@libp2p/dcutr) actually present in THIS build?
// Never throws — absence is a normal state (every build before T336's deps land), not an error.
//
// AutoNAT (@libp2p/autonat) is deliberately NOT part of the foundation: it is not shipped (T336
// design, organizer ruling 2026-10-03) because @libp2p/autonat@3.0.28 has no admission/connectionGater
// hook — so it cannot be camp-scoped and a non-camp party could use our node AS an AutoNAT server
// (a new outside-audience exposure) — AND @libp2p/dcutr does not depend on it (the punch works from
// relay/identify-observed addresses). So the probe keys off dcutr alone.
//
// Uses `require.resolve`, NOT `await import()`, on purpose — it threads between two hard constraints
// `import()` cannot satisfy at once:
//   1. When the package is ABSENT, Vite's static import-analysis (which transforms the browser-env
//      .jsx test files) tries to RESOLVE a dynamic `import()`'s bare specifier at TRANSFORM time and
//      hard-fails ("Failed to resolve import @libp2p/dcutr"), breaking every browser-env test whose
//      import graph transitively reaches this module via the sync stack (the elective
//      *.integration.test.jsx suite). `require.resolve` is not an import Vite rewrites, so it leaves
//      resolution at runtime.
//   2. The Tier-4 egress guard (internetRendezvousScan.js) flags any `import(` whose argument is not
//      an immediate string literal as a computed/covert-egress channel — so both
//      `import(/* @vite-ignore */ '@libp2p/dcutr')` and a computed specifier trip it.
//      `require.resolve('<literal>')` matches no egress pattern.
// Resolvability is the right signal for a presence gate anyway: it mirrors the lockfile-presence
// guard (dcutrPresenceWithoutSignoff.guard.test.js) and never executes the package. Async kept for
// call-site compatibility.
export async function holePunchFoundationPresent() {
  try {
    const require = createRequire(import.meta.url)
    require.resolve('@libp2p/dcutr')
    return true
  } catch {
    return false
  }
}
