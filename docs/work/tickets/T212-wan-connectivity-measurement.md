---
title: "Phase E — measure whether WAN failure is discovery or direct dial"
document_type: ticket
status: open
created: 2026-09-17
task_class: test-infrastructure
governing_docs: [docs/governance/GOVERNANCE_INDEX.md, docs/governance/constitution/CONSTITUTION.md, docs/governance/standards/ARCHITECTURE_STANDARD.md, docs/governance/standards/TESTING_STANDARD.md, docs/governance/standards/WORK_RECORD_STANDARD.md, SECURITY.md]
archive_when: "The WAN test matrix has been run with logs that distinguish rendezvous success from direct-dial failure, and the result is recorded as data the D/F decision can rest on"
---

# T212 — Phase E: measure before deciding on NAT traversal

## Problem

The external spec orders Phase D (UPnP — a gated, internet-facing, production-behaviour-changing
capability) **before** Phase E (measurement), while insisting elsewhere that a circuit relay must
be measured for first. That is an internal inconsistency, and followed literally it walks an
implementer into flipping the Tier-4 gate without the evidence the gate exists to require.

Measurement comes first here.

## Scope

Instrumentation only — the event vocabulary from the spec's §21, logging no secrets, keys, document
content or camp data. The load-bearing distinction is `RENDEZVOUS_PEER_DISCOVERED` +
`DIRECT_DIAL_FAILED` versus `DISCOVERY_FAILED`: they are different failures with different fixes.
Add an operational failure class the spec lacks — "the rendezvous service is gone", as distinct
from "your network is bad".

**Naming reconciliation (round 2, Security + Code Reviewer).** The vocabulary named above is this
ticket's *original framing*, written before the ADR settled the shipped shape. What actually ships
is different, and a reader of this Scope section must not infer a live `DISCOVERY_FAILED` emission
exists:

| Named here | Shipped as |
|---|---|
| `RENDEZVOUS_PEER_DISCOVERED` | `PEER_DISCOVERED` (the `source` field defaults to `'mdns'`; a `'rendezvous'` value is reserved vocabulary for T211, not live) |
| `DIRECT_DIAL_FAILED` | `DIAL_FAILED` |
| `DISCOVERY_FAILED` | **Not an emitted event at all** — see "Instrumentation shipped" below and the ADR's Decision 3 for what it actually is and the caveat on reading it |



## Why it matters

Whether two devices *can* connect directly is decided by their ISPs' NAT type, not by our effort.
Two peers both behind symmetric NAT/CGNAT cannot be connected directly — a networking invariant.
On a TCP-only stack, hole punching is additionally weak. The D/F decision must rest on measured
success rates, not on the spec's assumption.

## Does NOT count as done

- A binary works/doesn't-work result. The point is to identify the failing layer.
- Any log line containing a key, token, PIN, namespace, or document content.

## Instrumentation shipped (this slice)

`electron/sync/automerge/connectivityEvents.js` (event vocabulary + sink-injectable emitter) and
`electron/sync/automerge/mutualAuth.js` (emission at each discovery/dial/auth outcome) now exist,
per `docs/adr/2026-09-18-connectivity-observability-event-vocabulary.md`. `transport.js` is
untouched. `AUTH_OK` is instrumented (Governor ruling: it is the success denominator the D/F
decision needs). `RENDEZVOUS_UNAVAILABLE` and a `source: 'rendezvous'` value are vocabulary-only —
defined and unit-tested, emitted by no running code, reserved for T211.

**Round 2 additions:** a per-attempt `attemptId` on every attempt-scoped event (correlation, and
suppresses a duplicate terminal event for an attempt that already reported `ATTEMPT_STALLED`); a
new `NO_TOKEN` event for the previously-silent no-token branch; a bounded per-peer dedupe window on
`PEER_DISCOVERED` emission with a `repeatCount` on the next emitted line; a `cgnat` address class
(RFC 6598) and IPv4-mapped-IPv6 unwrapping in `classifyMultiaddr`; and an
`EVENTS`/`FIELD_ALLOWLIST` key-parity test so a new event cannot ship without an allowlist entry.
See the ADR's Decision 3 for the full per-event detail.

## Deliberately out of scope

- **Running the WAN test matrix itself.** This ticket's `archive_when` ("the WAN test matrix has
  been run... and the result is recorded") is **not** satisfied by this slice. Actually exercising
  two devices across real, independent NATs is owner/hardware work — it needs real internet-facing
  network conditions this session cannot fabricate — and is out of scope here. This slice ships the
  instrumentation the matrix will read from; it does not run the matrix. `archive_when` stays
  unmet and the ticket stays `status: open` until that run happens and its result is recorded.
- **Anything that requires T211 (rendezvous) to be unparked.** `RENDEZVOUS_UNAVAILABLE` cannot be
  built as a live emission — there is no rendezvous client running anywhere to observe an
  unavailable rendezvous service from — until T211 clears the owner's Tier-4 gate
  (`docs/adr/2026-09-14-internet-transport-security-gate.md`). Building a shim that calls it from a
  fake or speculative rendezvous path would be worse than not building it: it would exercise a code
  path production never takes, and would need to be re-verified against whatever T211 actually ends
  up looking like. The vocabulary slot is reserved and tested; the wiring is deferred, with this
  written reason, rather than guessed at now.
- **UPnP (Phase D).** Unaffected by this slice either way — this ticket's own Problem section
  explains why Phase D must not be built before Phase E's measurement exists to justify it.
- **Fixing the stalled-attempt-is-never-cancelled defect the instrumentation surfaced** (Red Hat,
  round 2): the watchdog that emits `ATTEMPT_STALLED` never cancels the underlying dial/authenticate
  promise, so a later re-announce can race a still-running "stalled" one. This round's fix is
  instrumentation-side only (a per-attempt correlation id, and suppressing a duplicate terminal
  event for an attempt already reported as stalled) — it does not touch the underlying
  cancellation, which is real sync-behavior surgery outside an instrumentation-only ticket. Tracked
  separately at `docs/work/tickets/T230-stalled-dial-is-never-cancelled.md`.

**`DISCOVERY_FAILED`-as-absence is not evidence today, and this is a hard caveat on reading the
data this ticket produces, not a footnote (Red Hat, round 2 — the most important finding).**
mDNS is link-local multicast: it structurally cannot cross routers or NAT. Two devices on different
networks today produce **zero** `PEER_DISCOVERED` events regardless of NAT type, purely because no
discovery mechanism that reaches across a WAN exists yet (T211, the rendezvous adapter, stays
parked behind the Tier-4 gate). Reading that absence as "discovery failed, therefore we need a
relay" would be **re-measuring a known architectural fact**, not learning anything new about NAT
traversal — the D/F decision must not be closed on that basis. Separately, even once a real
cross-network discovery path exists, an absence of `PEER_DISCOVERED` conflates at least five
distinct causes with no signal to tell them apart: AP client isolation (the common case on the
hotel/guest Wi-Fi camps actually run on), the peer's app simply not running, a camp-tag mismatch
filtered inside `transport.js` before `onPeerDiscovery` ever fires, the emitter having been wired
incorrectly, or ordinary log loss. See the ADR's Decision 3 for the full statement of this limit —
it is written there deliberately, next to the definition it caveats, so a reader cannot reach the
"absence = discovery failed" reading without also reaching this paragraph.

## What reaches the logs, and why that is safe (security argument)

Per the ADR's Decision 2, at the shipped default (`SHORESH_CONNECTIVITY_LOG_ADDRS` unset):

- **Peer ids are logged in full.** A peer id is already exchanged in the clear over mDNS multicast
  today — it is not a secret under this app's trust model (`SECURITY.md`: trust comes from
  `authorize()` re-querying device/role state each call, never from possessing a peer id). Logging
  it is the minimum needed to answer "did this specific peer ever get discovered", which is the
  question this ticket exists to let an operator answer; withholding it would defeat the ticket's
  own purpose without closing any actual exposure (an attacker on the same mDNS segment already
  sees it on the wire).
- **Multiaddrs are classified (`loopback`/`private`/`public` + a count), never logged as literal
  addresses, unless an operator explicitly sets `SHORESH_CONNECTIVITY_LOG_ADDRS=1` for a manual WAN
  test run.** A multiaddr is a real network location — for a children's camp on residential or
  camp Wi-Fi, that is exactly the class of fact this app's threat model already treats as sensitive.
  The classification is enough to answer the ticket's load-bearing question (did the peer present
  any publicly-reachable address at all) without writing a single IP to disk by default.
- **Never logged, at any verbosity:** tokens, PINs, signing keys, device ids beyond the peer id
  already covered above, namespace values, Automerge document content, or a raw error message (a
  libp2p dial error's message can itself embed a multiaddr, so errors are reduced to a closed
  `errorClass` enum — `timeout`/`refused`/`reset`/`unreachable`/`unknown` — before they ever reach
  the emitter). An event name or field not on that event's fixed allowlist is dropped by the
  emitter itself, not passed through — a caller mistake cannot silently widen what gets logged.
- **A broken logging sink cannot break sync.** `emit()` never throws; a sink exception is caught
  and reported once via `console.error`, so instrumentation failure cannot cascade into an auth or
  dial failure.

This satisfies "Does NOT count as done"'s ban on any log line containing a key, token, PIN,
namespace, or document content by construction — the emitter has no field allowlist entry through
which any of those could pass, at any verbosity level.
