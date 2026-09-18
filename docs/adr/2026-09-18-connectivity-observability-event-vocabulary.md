---
title: "Connectivity observability event vocabulary: a pure, sink-injectable emitter for the discovery/dial/auth seam"
document_type: adr
authority: normative
status: accepted
implementation_state: proposed
date: 2026-09-18
program: security-hardening
affects:
  - electron/sync/automerge/connectivityEvents.js
  - electron/sync/automerge/mutualAuth.js
  - docs/work/tickets/T212-wan-connectivity-measurement.md
  - docs/adr/2026-09-17-wan-rendezvous-seam.md
  - docs/work/specs/2026-09-17-rendezvous-wan-connectivity.md
---

# Connectivity observability event vocabulary

This ADR settles the **contract** for T212's instrumentation: an event vocabulary and emission
module for the discovery → dial → mutual-auth seam. It does not implement rendezvous (T211 stays
parked behind the owner's Tier-4 gate) and does not touch `transport.js`.

## Context

`electron/sync/automerge/mutualAuth.js` currently reports every outcome as an ad-hoc
`console.error`/`console.warn` string. There is no way to answer, from logs alone, whether a WAN
pairing failure happened because the peer was never discovered, because it was discovered but the
direct dial never succeeded, or because it dialed and mutual auth rejected it. T212 requires this
distinction because the D/F NAT-traversal decision (`docs/adr/2026-09-17-wan-rendezvous-seam.md`)
must rest on measured failure-layer data, not assumption. The vocabulary must also anticipate a
`source: 'rendezvous'` discriminator so a future, still-parked rendezvous adapter (T211) slots into
the same events instead of inventing a second scheme — without importing or wiring anything from
`electron/sync/automerge/rendezvous*.js` into a running path today.

## Decision 1 — One pure emitter module, sink injectable, default sink is `console`

New file `electron/sync/automerge/connectivityEvents.js`. Interface:

```js
createConnectivityEmitter({ sink = defaultConsoleSink, verboseAddrs = false } = {}) -> { emit }
emit(eventName, fields) -> void
```

- No imports from libp2p, `automerge`, better-sqlite3, or any file under `electron/sync/automerge/`
  other than a shared address-classification helper it owns itself. Unit-testable with a plain
  array-collecting fake `sink`, no libp2p or SQLite required (satisfies constraint 4).
- `emit` never throws: it validates against a fixed per-event field allowlist (unknown fields are
  dropped, not passed through — this is itself a leak guard, see Decision 2), JSON-stringifies, and
  calls `sink(line)` inside a `try/catch` that swallows and reports via a single, static
  `console.error('connectivityEvents: sink threw ...')` fallback. A broken sink must never break
  libp2p's event dispatch or the auth path.
- Default sink writes one JSON line per event via `console.log` (not `console.error` — these are
  structured data, not operator alarms; existing `console.error`/`warn` lines in `mutualAuth.js`
  are **kept as-is**, this is an addition, not a replacement of human-readable operational logging).
- `verboseAddrs` (default `false`) is the single opt-in described in Decision 2.

This is a deep module by the codebase-design measure: one call (`emit(name, fields)`) hides field
validation, redaction-by-default, address classification, and crash-proofing. Callers (mutualAuth)
never touch a redaction policy directly.

## Decision 2 — Redaction policy: peer ids in full, multiaddrs classified by default, literal addresses opt-in

**Peer ids are logged in full, at every level.** A peer id is already exchanged in the clear over
mDNS multicast and is not a secret by this app's own trust model (`SECURITY.md`: trust comes from
`authorize()` re-querying device/role state, never from possessing a peer id). Redacting it would
make the very correlation this ticket exists to enable — "did this specific peer ever get
discovered" — impossible.

**Multiaddrs are the actual privacy boundary and are classified, not logged literally, by
default.** A multiaddr on a residential or camp Wi-Fi network *is* a personal/institutional
network location — for a children's camp, this is exactly the class of thing SECURITY.md and the
spec's own reconciliation (§2.3, "Privacy is a first-class finding") already worry about for the
still-parked rendezvous board. The default-emitted shape replaces each multiaddr with a class:
`loopback` | `private` (RFC1918/link-local) | `public`, plus a count — e.g.
`{ multiaddrClasses: ['private', 'public'], multiaddrCount: 2 }`. This is enough to answer the
ticket's question (did this peer even present a public-reachable address at all?) without writing
a single IP to disk by default.

**Literal multiaddrs are opt-in**, via `verboseAddrs: true` passed to
`createConnectivityEmitter` (wired to an env var, e.g. `SHORESH_CONNECTIVITY_LOG_ADDRS=1`, by the
call site that constructs the emitter — not by this module reading `process.env` itself, keeping
it dependency-free). An operator running the WAN test matrix by hand opts in deliberately; the
default shipped behavior never does.

**Never logged, at any level, by this module:** tokens, PINs, signing keys, device ids beyond the
peer id already covered above, namespace values, Automerge document content, or raw error objects
(error values are reduced to a fixed `errorClass` enum before reaching `emit` — see Decision 3 —
never `err.message` verbatim, because a libp2p dial error message can itself embed a multiaddr).

## Decision 3 — Event vocabulary

All events share `{ ts, peerId, source }` plus their own fields. `source` is `'mdns'` today; the
field exists now specifically so a `'rendezvous'` value requires no schema change later (Decision
1's stated purpose). `errorClass` throughout is a small closed enum
(`timeout`|`refused`|`reset`|`unreachable`|`unknown`) derived from the caught error by a
non-secret-bearing classifier in `connectivityEvents.js`, never the raw message.

| Event | Fires when | Payload (beyond the shared fields) | What it lets an analyst conclude that they cannot today |
|---|---|---|---|
| `PEER_DISCOVERED` | A discovery mechanism yields a candidate, before any trust filtering. | `multiaddrCount`, `multiaddrClasses[]` | Whether discovery happened at all, and whether the discovered peer presented any public-class address — the prerequisite fact for everything below. |
| `TRUST_CHECK_REJECTED` | `isPeerTrusted` returns falsy, or throws. | `reason: 'untrusted'\|'trust_check_error'` | Distinguishes "never became a candidate for dialing" from "was dialed and failed" — without this, both look identical in today's logs (no log line at all for a silently-dropped untrusted peer). |
| `DIAL_FAILED` | The direct `dial()` call throws, in **either** branch of `mutualAuth.js` — the no-reuse branch (line ~179, a real, unrecovered dial failure) and the reused-inbound-then-redial branch (line ~208, where a fresh dial is attempted because the previously-listed connection turned out dead). | `reused: boolean`, `errorClass` | **This is the ticket's load-bearing distinction's second half.** `PEER_DISCOVERED` with no matching `DIAL_FAILED`/auth event within a bounded window means the failure was discovery-layer; `PEER_DISCOVERED` followed by `DIAL_FAILED` means the peer was found but the direct dial never succeeded — the two failure classes the ticket says today's logs cannot tell apart. |
| `ATTEMPT_STALLED` | The `attemptTimeoutMs` watchdog fires (line ~136) before dial+auth resolved either way. | `attemptTimeoutMs` | A third failure shape distinct from an explicit dial/auth failure: the attempt hung rather than failed cleanly. Operationally different fix (timeout tuning / detecting a black-hole endpoint) from either `DIAL_FAILED` or `AUTH_REJECTED`. |
| `AUTH_REJECTED` | Peer replies but `reply.type !== 'auth_ok'` (line ~211). | `retried: boolean` (whether this followed a redial) | Direct dial **succeeded** — proves the network path works — but mutual auth was refused. Distinct fix from a dial failure: this is a trust/credential problem, not a NAT/reachability problem. |
| `AUTH_ERROR` | `authenticateWith` throws and is not recovered by the one-shot redial (final catch, line ~228). | `retried: boolean`, `errorClass` | Dialed successfully but the authenticate exchange itself broke (stream reset, protocol mismatch) — a third bucket, neither a clean rejection nor a dial failure. |
| `AUTH_OK` | `reply.type === 'auth_ok'` (currently has **no log line at all** — this is a genuine gap this design closes, not a duplicate). | *(none beyond shared fields)* | The success case. Needed as the denominator: failure rates are meaningless without knowing how many attempts succeeded. |
| `RENDEZVOUS_UNAVAILABLE` | **Vocabulary only — not emitted by any code today.** Reserved shape for the still-parked rendezvous adapter (T211): `reason: 'disabled'\|'http_error'\|'timeout'\|'unreachable'`. | — | The operational failure class the ticket says the spec lacks: "the rendezvous service is gone/unreachable/turned off" as distinct from "your network is bad" (`DIAL_FAILED`/`ATTEMPT_STALLED`, which mean the *peer's* network is the problem, not the *rendezvous board's*). See Deliverable D — this cannot be built or emitted before T211 unparks, because nothing may call it from a running path today. |

`DISCOVERY_FAILED` (named in the ticket) is **not a new emission** — it is the *absence* of any
`PEER_DISCOVERED` event for an expected peer within a test's observation window, plus (if it
occurs) a raw mDNS/libp2p discovery-mechanism error, which is out of scope to instrument here
because `transport.js` is deliberately left unmodified (Deliverable C explains why). This is stated
explicitly in the module's test-facing documentation so a test author defines "discovery failed" as
"no `PEER_DISCOVERED` for peer X by deadline T", not as a fourth event this module emits.

## Decision 4 — Emission lives entirely in `mutualAuth.js`; `transport.js` is untouched

Every event above fires from `mutualAuth.js`'s existing branches (see the ticket brief's
Deliverable C for the exact line-level mapping). `transport.js`'s `onPeerDiscovery` callback
delivers `{ id, multiaddrs }` unchanged; `mutualAuth.js`'s own discovery handler is where
`multiaddrs` is read for classification, since today it is destructured to `{ id }` and dropped.
Keeping the seam singular (one file instruments, one file stays pure networking) matches this
codebase's existing module boundary — `transport.js` is the libp2p adapter, `mutualAuth.js` is
already the "connectivity outcomes" module — and keeps the Tier-4 guard's job simple: the guard
scans `transport.js` and `main.js`; it never has to reason about whether a logging change altered
the transport boundary, because logging never touches that file.

## Does not require rendezvous, does not touch the Tier-4 guard

No file under `electron/sync/automerge/rendezvous*.js` is created, imported, or referenced by
running code. `connectivityEvents.js` performs no network call, imports no libp2p package, and
contains no `http(s)://` literal — it cannot trip `internetRendezvousScan.js`, and no change to
`transportBoundary.guard.test.js` is proposed or needed.

## Consequences

- `mutualAuth.js` gains a required (but defaultable-to-no-op) collaborator; existing callers/tests
  that don't pass an emitter get the default `console`-backed one, so this is additive, not
  breaking, to `wireMutualAuth`'s existing signature.
- Any future change that adds a field to a discovery or auth payload that downstream code branches
  on should also ask "does this event vocabulary need updating" — the same discipline the seam ADR
  already calls out for trust-relevant fields.
- The vocabulary is deliberately small and closed (7 live events + 1 reserved). Extending it for a
  genuinely new failure mode later is expected; silently overloading an existing event's meaning is
  not — that would be exactly the kind of drift `internetRendezvousScan.js`'s own header warns
  against for guards, and applies equally to a vocabulary a security decision will be read from.
