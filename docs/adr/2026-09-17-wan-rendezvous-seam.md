---
title: "WAN rendezvous seam: HTTP side-channel discovery, identity-key signing, and the Tier-4 guard gap it exposes"
document_type: adr
authority: normative
status: proposed
date: 2026-09-17
program: security-hardening
affects:
  - electron/sync/automerge/discovery.js
  - electron/sync/automerge/transportBoundary.guard.test.js
  - electron/sync/automerge/internetRendezvousScan.js
  - electron/main.js
  - docs/adr/2026-09-14-internet-transport-security-gate.md
  - docs/adr/2026-09-15-ephemeral-join-secret-for-wan-discovery.md
  - docs/work/security/2026-09-15-wan-dht-boundary-assessment.md
implementation_state: proposed
---

# WAN rendezvous seam: HTTP side-channel discovery, identity-key signing, and the Tier-4 guard gap it exposes

This ADR covers only what is genuinely new relative to the two ADRs it depends on. It does not
restate the Tier-4 boundary (`docs/adr/2026-09-14-internet-transport-security-gate.md`) or the
join-secret redesign (`docs/adr/2026-09-15-ephemeral-join-secret-for-wan-discovery.md`), both of
which stand as written.

## Context

The product owner supplied an external spec ("Shoresh Serverless Rendezvous & WAN Connectivity")
proposing a Cloudflare Worker + Workers KV bulletin board where already-paired peers publish
signed, ~2h-expiring `{namespace, peerId, multiaddrs, issuedAt, expiresAt, signature}` records,
and other paired peers poll `GET /v1/peers/<namespace>` and feed survivors into the existing
`mDNS discovery → peer:discovery → mutualAuth → libp2p dial → Noise/Yamux → Automerge` path.

Two decisions in that spec are genuinely open and structural, and are what this ADR resolves:

1. **Where the rendezvous client plugs in**, such that the Tier-4 guard's literal text still
   protects what it was built to protect — or, if it can't, what changes.
2. **What signs the published record and how the namespace is generated/propagated** — the spec
   explicitly leaves the wire format open ("the exact wire format is an implementation decision").

Everything else in the spec — the "rendezvous never creates trust" invariant and the
Tier-4-gated phase-blocking analysis for UPnP/DCUtR/relay packages — is already settled by the two
prior ADRs and is not repeated here.

**CORRECTION (2026-09-17, this revision).** An earlier version of the accompanying design handoff
recommended accepting "CGNAT-both-ends pairs stay LAN-only" as the product outcome, on the strength
of a TCP-only NAT-traversal finding. **The owner rejected that recommendation outright** ("i do not
accept 3, there has to be a [way]") — telling a camp director their two laptops simply cannot sync
off-LAN is not an acceptable outcome, and the 2026-09-15 "direct-only, NO RELAY" decision was made
*before* that rejection, on the premise that a no-relay policy was viable. That premise no longer
holds. Decision 3 below reopens the connectivity question honestly and **records a relay-fallback
decision** that supersedes the "no relay" clause of the 2026-09-15 assessment's framing (not its
CGNAT analysis, which was correct and is the reason a fallback is needed at all). Decision 4
records a configurability requirement the owner attached to this reopening.

## Decision 1 — Rendezvous is an HTTP side-channel that manufactures synthetic `peer:discovery` events; it is not a libp2p transport or discovery service

**New module**: `electron/sync/automerge/rendezvousClient.js`. It does exactly two things:
`POST` a signed record to the Worker, and `GET` records for a namespace on a timer/on-demand. It
imports no libp2p package and calls no libp2p API. It hands its results to the *existing* seam
`transport.js` already exposes for mDNS (`onPeerDiscovery(cb)` — see `transport.js`'s own
`node.addEventListener('peer:discovery', ...)` wiring): `syncNode.js` (or a new thin adapter next
to it) calls the same discovery-result handler it already calls for mDNS hits, passing
`{ id: peerId, multiaddrs }` shaped identically to what `onPeerDiscovery` already delivers. From
`mutualAuth.js` downward, a rendezvous-sourced candidate and an mDNS-sourced candidate are
byte-for-byte indistinguishable — this is what makes it structurally impossible for a rendezvous
response to create trust: mutual auth, the login/pairing state machine, and `authorize()` do not
know or care which discovery mechanism produced the dial target, so nothing added here can grant
the one thing that actually creates trust (a successful login/pairing exchange over an
authenticated connection).

**Enforcement, not intent.** The "cannot create trust" property is not a design aspiration to be
checked in review; it already holds today for mDNS by construction (mDNS delivers a peerId +
address, nothing else, and everything downstream re-derives trust from the document/session state
independent of how the peer was found). Because the rendezvous module target-shapes its output to
exactly `{id, multiaddrs}` and nothing more, it cannot even smuggle in a claim ("this peer is
already known-good") for a downstream consumer to misuse, because no such field exists in the
shape mutualAuth/syncNode consume. A code reviewer's checklist item for any future change here:
*if a field is ever added to the discovery payload that downstream code branches on, that is the
moment trust could leak in — treat it as a Tier-4-relevant change.*

**Local trust filtering happens client-side, before dial, using data the rendezvous response does
not supply.** Per spec §10 ("Accept only Peer IDs already authorized by local Shoresh trust
state"): the rendezvous client filters `GET` results against the *locally already-known* set of
signing/peer identities recorded on this device (the same `devices`/`camps.signing_public_key`
state every other trust decision in this codebase reads) before ever surfacing a candidate to
`onPeerDiscovery`. An unrecognized peerId returned by the Worker is dropped silently (logged as
`RENDEZVOUS_PEER_DISCOVERED` with `known: false`, never dialed). This is the same shape as
`joinSession.js`'s existing pattern of never trusting a claim without an independent local check.

### The Tier-4 guard gap this creates — the question the owner most needs answered

**The guard, as written today, does not fire on this design, and that is a genuine gap, not a
false alarm.** Walking its three assertions against Phase A–C as designed:

1. *"declares no internet-reachable... dependency"* — true. `rendezvousClient.js` uses the
   platform `fetch`, not a new package. `INTERNET_TRANSPORT_PACKAGES` is an npm-package
   allowlist; an HTTPS bulletin board needs zero new packages. **Guard does not fire.**
2. *"the REAL production node uses mDNS-only discovery... nothing that performs internet
   rendezvous"* — the assertion is a substring scan of `electron/main.js` for
   `kadDHT`/`circuitRelay`/`bootstrap(`/`dcutr`/`autonat`/`webRTC`, plus a regex check that
   `createMdnsDiscovery(` is still wired into `peerDiscovery: [...]`. Feeding rendezvous results
   through `onPeerDiscovery` (a callback registered on the transport object, not the
   `peerDiscovery: [...]` libp2p constructor array) touches neither. `createMdnsDiscovery(` stays
   present and untouched. **Guard does not fire.**
3. *"transport.js imports no internet-transport package directly"* — `rendezvousClient.js` is a
   new file; `transport.js` itself is unmodified. **Guard does not fire.**

So: **yes, Phase A–C as specced can be built without tripping a single one of the guard's three
assertions, using zero new dependencies and zero changes to the two files the guard reads.** This
is exactly the "internet discovery" scenario the 2026-09-14 ADR's prose describes as requiring a
mandatory re-assessment ("Internet-reachable... any... bootstrap peer list... **or a non-loopback
default listen address**" — closer reading shows the ADR's own prose enumerates *libp2p*
mechanisms; an HTTP-only side-channel that never becomes part of the libp2p stack was not
contemplated). The guard's definition of "internet-reachable" is a *libp2p-package and
main.js-wiring* definition, not a *does the device now exchange reachability data with a public
internet server* definition. An HTTP bulletin board satisfies the second, spec-intent reading of
"internet-reachable" while evading the first, literal-guard reading.

**Decision: the guard must be widened before Phase A lands**, or Phase A–C ship in a state the
2026-09-14 ADR's own governing principle exists to prevent (a boundary change landing "silently or
incrementally"). Concretely, add a fourth assertion to
`electron/sync/automerge/transportBoundary.guard.test.js`: fail the suite if any file under
`electron/sync/automerge/` (or `electron/main.js`) contains a network call (`fetch(`, `http.request`,
`https.request`, or an import of a rendezvous-specific module) to a non-`localhost` host used for
peer discovery, unless `INTERNET_TRANSPORT_SIGNOFF` is `true`. The simplest reliable form: name the
new module in an explicit denylist the same way the package list is explicit today —
`INTERNET_RENDEZVOUS_MODULES = ['rendezvousClient.js']` — and fail if that file exists and is
imported by `main.js`/`syncNode.js` while sign-off is false. This keeps the guard mechanical (reads
files, no semantic parsing) and keeps it honest about what "internet-reachable" means for this
project going forward: **any mechanism, libp2p or not, that lets this device learn another device's
current network location from a party outside the LAN is the boundary event**, not "did we import
one of nine specific npm packages." This ADR treats *widening the guard* as a prerequisite
deliverable of Phase A, not an optional cleanup — Phase A cannot be called done while a build that
adds a live internet rendezvous client stays green under the unmodified guard.

**IMPLEMENTED 2026-09-17 (T207), in the behavioural form, not the denylist form.** Governor
rejected the "name the new module in a denylist" variant above: a filename denylist is the same
name-shaped construction that has already let this guard be wrong twice (a dead `DEFAULT_LISTEN`
constant, then a package list). A module called something else evades it on day one. What shipped
instead is the first sentence's version — `electron/sync/automerge/internetRendezvousScan.js`
scans every non-test file under `electron/sync/**` for outbound internet egress of any kind
(`fetch`, node `http`/`https`, undici/axios/node-fetch, `XMLHttpRequest`, raw `net`/`tls.connect`,
a hard-coded `http(s)://` URL outside comments), and the guard fails if any appears while
`INTERNET_TRANSPORT_SIGNOFF` is false. Its detection is a separately-tested pure function, and its
non-vacuity was proven by planting a working Cloudflare rendezvous client in the tree and observing
the suite go red. The scanner states its own blind spots in its header comment.

**Confidence: high.** This is derived directly from reading the guard's own assertions against the
proposed module boundary, not from a general principle.

## Decision 2 — Signing key: the libp2p Ed25519 identity key, not the Host signing key; namespace generated locally and stored in the Automerge document

**Signs the record: the publishing device's own libp2p peer identity key** (the Ed25519 keypair
`createLibp2p` already generates and that `node.peerId` already commits to), not
`camps.signing_public_key` (the Host-only credential-signing key `Q1/T172` hardened).

Reasoning, evaluated against what each key actually binds:

- The Host signing key binds *"the Host asserts this credential/role change is authoritative"* —
  a statement about **camp governance** (who is admin, what a PIN is), verified by every device
  against one pinned public key. It is deliberately single-writer (only the Host holds the private
  half). A rendezvous record is not a governance claim; it is *"this specific device is currently
  reachable at these addresses,"* asserted by that device about itself. Binding it to the Host key
  would mean either (a) only the Host can publish its own record, and every other paired device's
  reachability record would need the Host to countersign it live — reintroducing a
  single-point-of-failure and a round-trip this feature exists to avoid when devices are on
  different networks — or (b) non-Host devices sign with a key never intended to authenticate
  arbitrary devices, which is a bigger, less-reviewed change to what that key means.
- The libp2p identity key already is the thing the record's `peerId` field names. Signing with it
  makes the record self-certifying in the strongest available sense: verifying the signature and
  verifying that the signing key hashes to the claimed `peerId` are the same check, so there is no
  way to publish a record under a `peerId` you don't hold the corresponding private key for. This
  directly satisfies spec §11's replay-resistance goal ("An attacker who learns a namespace must
  not be able to overwrite a trusted peer's location") — an attacker who does not hold that
  device's libp2p private key cannot produce a valid signature for that `peerId`, full stop,
  regardless of namespace secrecy.
- It reuses a key libp2p already generates, persists, and rotates on this project's terms (device
  identity is already peerId-based downstream of the Stage 5/6 work) — no new key material, no new
  custody question for SECURITY.md to absorb.

**Signed material — canonical encoding is load-bearing, and the spec's illustrative JSON is not a
usable serialization.** Sign over a **fixed-order, length-prefixed byte concatenation**, not
`JSON.stringify` of the payload object: `namespace(32 bytes) || peerId(varint-length-prefixed
UTF-8) || addresses(varint count, then each varint-length-prefixed multiaddr byte string in a
fixed, sorted order) || issuedAt(8-byte big-endian ms-epoch) || expiresAt(8-byte big-endian
ms-epoch)`. This closes exactly the defect class the brief's own instructions flag as a concern:
`JSON.stringify` is not canonical across engines/versions (key order is insertion-order but not
guaranteed stable across a re-serialize, and floating-point/number formatting can differ), so
"sign the JSON" invites a signature that verifies on the producing device and fails elsewhere, or
— worse — a verifier that re-serializes-then-compares instead of verifying bytes, which is
spoofable by any payload that re-serializes to the same string. Ed25519 signs bytes; construct
those bytes deterministically once, in a shared module (`rendezvousNamespace.js` or a
`rendezvousRecord.js` next to it) imported by both the publisher and every verifier, so "how the
bytes are built" cannot drift between them.

**Namespace: generated once locally with `crypto.randomBytes(32)`, stored as a field in the
Automerge document (e.g. `camps.rendezvousNamespace`), and thereby propagated to every paired
device for free via ordinary sync** — no separate distribution channel to design or secure. It is
generated by whichever device first enables WAN rendezvous (Host or any paired device — camp-level,
not device-level, so all paired devices publish under the same namespace and can find each other).
Because it rides in the document, a device that has never seen it (a fresh joiner, before the
ephemeral-join-secret work lands) cannot leak it or use it — consistent with spec §7's "possession
of the namespace is not sufficient authentication" and with the boundary the 2026-09-15 ADR is
already drawing around who gets to discover what.

**TTL/refresh:** 2h TTL matching spec §9, refreshed at a fixed fraction (e.g. 75%) of TTL — a
timer in the module owning the publish loop, not `setInterval` drift-prone math; re-published
immediately on a detected network-interface change (spec §12's "network change" case), coalesced
so a flapping interface doesn't spam the Worker.

### Interface-contract checklist (org-interface-contracts)

- **Idempotency**: `POST /v1/register` is a pure overwrite of `shoresh:rendezvous:<namespace>:<peerId>` keyed by that same tuple — republishing with a newer `issuedAt` is idempotent by construction (KV `put` replaces). No client_write_id needed; this is not an op-log mutation.
- **Concurrent retries**: two near-simultaneous publishes from the same device (e.g. a flappy network firing two change events) both eventually settle on the KV value with the latest `issuedAt`, since each publish is a full overwrite — no partial-merge hazard exists in a single-key overwrite.
- **Unknown outcomes**: a `POST` that times out or a `fetch` that throws is treated as "may or may not have published" — the caller does not retry-storm; it waits for the next scheduled refresh tick and republishes then (idempotent overwrite makes a stale double-publish harmless). Never blocks startup (spec's own non-negotiable) and never surfaces as an app-level error; log `RENDEZVOUS_REGISTER_FAILURE` and continue.
- **Error shape**: `registerRecord()`/`fetchPeers()` return `{ ok: true, ... } | { ok: false, reason }` — never throw across the module boundary — mirroring `authorize()`'s existing `{allowed, reason}` shape so callers pattern-match the same way they already do elsewhere in this codebase.
- **Scope/authority boundary**: the rendezvous client never touches `authorize()`, `PROJECTIONS`, or camp isolation directly — it only ever produces `{id, multiaddrs}` tuples fed to the same `onPeerDiscovery` consumer mDNS already feeds, so it inherits every downstream check for free and adds no new privileged path.
- **Trust-boundary validation**: every field in a `GET /v1/peers/<namespace>` response is treated as adversarial input — signature verified against the record's own claimed `peerId` (self-certifying, per Decision 2), `expiresAt` checked against local clock, `peerId` checked against the local known-devices set, before any of it reaches `onPeerDiscovery`. This is new data crossing a trust boundary (an internet server), unlike this project's own already-owned SQLite rows, and is checked accordingly per the skill's own distinction.

## Decision 3 — coordination-only relay for DCUtR (never a sustained data path); CGNAT-both-ends with symmetric mapping has no solution on any transport

Re-opened per the owner's rejection above. This section replaces the earlier "accept LAN-only for
CGNAT pairs" recommendation with a sourced answer to the three questions Governor posed. All three
were checked against the actually-resolved package versions (`package-lock.json`: `libp2p@2.10.0`,
`@libp2p/tcp@^10.1.19`) and the npm registry / libp2p's own docs and maintainer statements — not
recalled from memory. Where a specific number could not be sourced, that is stated rather than
estimated.

**1. QUIC transport — exists, but is a bigger and riskier addition than "one more package," and
buys less than hoped.** No official `@libp2p/quic-v1` ships from the libp2p team for JS. The only
viable option is the community-maintained `@chainsafe/libp2p-quic` (npm, currently `2.1.4`,
published this month). Verified facts about it:
- **It is a native NAPI (Rust) addon** (`npm view` reports `keywords: napi`; not pure JS, not WASM).
  It would need the same electron-rebuild treatment this project already does for
  `better-sqlite3` (per-platform prebuilds, ABI rebuild for Electron vs. Node, a new maintenance
  burden `CLAUDE.md` already documents as a recurring source of pain for exactly one native module).
- **It requires `@libp2p/interface@^3.1.0`.** This project's pinned `libp2p@2.10.0` depends on
  `@libp2p/interface@^2.11.0` — a major-version gap. Adding this package today is not additive; it
  forces upgrading `libp2p` itself and, transitively, `@libp2p/tcp`, `@libp2p/mdns`,
  `@libp2p/identify`, and the noise/yamux packages to their `libp2p@3.x`-compatible releases. That
  is a repo-wide dependency bump with its own regression surface, not a scoped feature addition.
  `engines: {node: '>= 22'}` is separately satisfiable (Electron 43 bundles Node ≥22; this repo's
  dev Node is 25.8.1) and is not the blocker.
- **What it buys for hole punching, specifically:** the js-libp2p maintainers' own stated position
  (GitHub discussion #2388, `achingbrain`) is that hole punching "really needs QUIC to be reliable"
  in JS **because of Node's historically weak QUIC support and JS-specific timing issues** in the
  DCUtR implementation — not because TCP hole-punching is theoretically worse. **I could not source
  a js-libp2p-specific hole-punch success-rate number for TCP vs. QUIC and am not estimating one.**
  The one concrete success-rate figure found (~70%, similar for TCP and QUIC) comes from a
  large-scale measurement of **go-libp2p** hole punching in the wild (IPFS network measurement
  papers, arXiv 2510.27500 / 2604.12484) — a different, more mature implementation, not js-libp2p,
  and it does not report a JS-specific figure. Treat it as evidence that TCP hole-punching is not
  inherently doomed as a protocol matter, not as a number this stack can be expected to hit today.
- **Net:** QUIC is real, but adopting it now means a major libp2p-family upgrade plus a new native
  addon, in exchange for an immature js-libp2p DCUtR path whose maintainers themselves call
  under-invested — for a benefit (better hole-punch reliability for *punchable* NAT types) that
  does not touch the actual problem in front of us. **Recommendation: do not pursue QUIC as part of
  this program.**

  **PREMISE CHANGED, 2026-09-17 — do not cite this rejection as settled.** Half the reason above was
  a dependency fact, not a judgement: `@chainsafe/libp2p-quic` needs `@libp2p/interface@^3.x` while
  `libp2p@2.10.0` pins `^2.11.0`, so adopting QUIC meant forcing a repo-wide libp2p major. **That
  major is now happening anyway** — GHSA-vrf4-mx87-p53w forces `libp2p@3.3.11` (T215), which
  satisfies `@libp2p/interface@^3.x` incidentally. The dependency-graph objection dissolves with it.

  What still stands on its own: it remains a **native NAPI (Rust) addon**, carrying the same
  per-platform prebuild and electron-rebuild burden `better-sqlite3` already costs us; js-libp2p's
  DCUtR path remains under-invested by its maintainers' own account; and **QUIC does not make
  symmetric-NAT hole punching possible** (Decision 3) — it improves reliability only for NAT classes
  that were already punchable, so it does not touch the case the owner actually cares about.

  After T215, QUIC is **possible**, not **chosen**. Re-decide it on Phase E evidence, and explicitly
  **do not adopt it as a side effect of the upgrade** — that is how a rejected option usually creeps
  back. `@chainsafe/libp2p-quic` is added to the Tier-4 guard's forbidden list **in T215's own PR**,
  alongside the bump that makes it installable, so adopting it needs the same recorded sign-off as any
  other internet transport rather than being one `npm install` away the moment the interface version
  permits it. The guard addition deliberately travels with the upgrade, not with this branch.

**2. DCUtR, honestly, on top of either transport — it cannot punch symmetric NAT/CGNAT, on any
transport, because that is a topology invariant, not an implementation gap.** DCUtR (and hole
punching generally) works by having each side learn the other's server-reflexive (NAT-mapped)
address and dial simultaneously; this succeeds for full-cone, restricted-cone, and
port-restricted-cone NAT pairings, where the external port a peer is mapped to is predictable or
stable. It fundamentally cannot work when one or both sides sit behind **symmetric NAT** — a new,
unpredictable external port is allocated per destination, so there is no stable address to punch
toward — and this is exactly the shape of most real-world **CGNAT**. This matches the CGNAT
invariant already recorded in `docs/work/security/2026-09-15-wan-dht-boundary-assessment.md` and is
independently confirmed by the same GitHub discussion above (js-libp2p's current DCUtR mainly
handles the *unilateral* case — one peer already has a public/reachable address — not genuine
bidirectional symmetric-NAT traversal). **Conclusion: no transport choice changes this.** QUIC
does not make symmetric-NAT hole punching possible; it only makes punching *more reliable for the
NAT classes that were already punchable*.

**CORRECTION (2026-09-17, second revision).** The Governor relayed a further owner correction:
"i do not want to be a relay in the sense you are talking about... to be able to hole punch is the
route for the relay so that we get out of the way and are not hosting their traffic." The owner is
right, and the distinction below (spec §16) is one the previous revision of this section collapsed.
There are two structurally different uses of circuit-relay-v2, and only one is in scope.

**3a. Relay as a sustained DATA PATH — REJECTED, out of scope, not to be reintroduced as a
fallback.** This is the use this ADR's prior revision recommended and it is withdrawn. Traffic
staying on a relay for the life of a connection reintroduces exactly the standing, traffic-bearing
service the local-first architecture has never had, and the owner has now explicitly rejected it.
Nothing below reopens it; if it is ever reconsidered, that requires the owner to reopen it, not an
engineering convenience.

**3b. Relay as brief COORDINATION for DCUtR — the intended route, and it is real (verified in the
actual installed-family package, `@libp2p/circuit-relay-v2@4.2.13`'s source).** DCUtR's own
documented mechanism (`@libp2p/dcutr`, resolves to `3.0.28` at this libp2p line) *is* "dial over a
relay just long enough to synchronize a simultaneous direct dial, then use the direct connection."
The relay's job is to exist only long enough to carry two small coordination messages
(`CONNECT`/`SYNC`, capped by the package's own `MAX_DCUTR_MESSAGE_SIZE = 4096` bytes and a
`5000`ms per-exchange timeout, both read from `@libp2p/dcutr@3.0.28`'s `dcutr.js`) — not the
Automerge document.

**Enforced, not merely intended — concrete limits verified in the shipped source
(`@libp2p/circuit-relay-v2@4.2.13`, `dist/src/constants.js`), not remembered or estimated:**

| Constant | Value | What it bounds |
|---|---|---|
| `DEFAULT_DURATION_LIMIT` | `2 * 60 * 1000` ms = **2 minutes** | Wall-clock lifetime of a single relayed connection through the relay server |
| `DEFAULT_DATA_LIMIT` | `BigInt(1 << 17)` = **131,072 bytes (128 KiB)** | Total bytes the relay will forward for one relayed connection |
| `DEFAULT_HOP_TIMEOUT` | `30_000` ms | Time allowed to complete the HOP reservation/connect handshake with the relay |
| `DEFAULT_MAX_RESERVATION_TTL` | `2 * 60 * 60 * 1000` ms = **2 hours** | How long a *reservation* (the right to be relayed-to) stays valid — separate from a connection's own 2-minute/128 KiB caps |
| `MAX_CONNECTIONS` (relay server) | **300** | Concurrent relayed connections one relay process will hold |

These are the relay server's own enforced ceilings, applied per relayed connection regardless of
what the two peers try to do with it — 128 KiB / 2 minutes is comfortably enough for DCUtR's
handshake (a handful of ≤4 KB messages) and is **not** enough to sustain Automerge document sync,
so a coordination-only design does not depend on the client behaving; the relay itself refuses to
carry more. **This is the actual enforcement mechanism, and it must be configured explicitly and
tested, not assumed as a side effect of using the package with its defaults** — see below for the
gap that still needs closing.

**The one place the library's default behavior does NOT match the owner's requirement, found by
reading `@libp2p/dcutr@3.0.28`'s own published usage example:** the package's own JSDoc shows the
intended polling pattern as *"while (true) { check for a direct connection; if not yet upgraded,
log 'have relayed connection' and wait"* — i.e., **on hole-punch failure, the library's documented
behavior is to keep using the relayed (`limits`-bearing) connection, not to close it.** That
relayed connection is still bounded by the table above (128 KiB/2 min, enforced server-side), so it
cannot become a sustained data path by accident — but it is not the "fail closed" behavior the
owner specified ("if the hole punch fails, the connection fails; it does not fall back to
relaying"). **Design requirement for Maker:** the Shoresh integration must not rely on the
library's default polling example. It must explicitly listen for the DCUtR upgrade outcome and, on
failure (or on the `DEFAULT_HOP_TIMEOUT`/message-exchange timeout expiring without an upgrade),
call `connection.close()` on the relayed connection itself and surface `DIRECT_DIAL_FAILED` rather
than continue treating it as usable — turning "the relay's data cap eventually cuts you off" into
"we do not use a relayed connection as a data path at all, ever, by our own code, independent of
the relay's cap." **This must be a test**: simulate a DCUtR upgrade failure and assert the relayed
connection is closed by Shoresh code and no `sendSyncMessage`/`broadcastDoc` traffic is attempted
over it — not merely that the relay would eventually cut it off.

**Operational shape, restated under the coordination-only framing:** a coordination relay is still
a real, long-lived, publicly-reachable libp2p process someone must run — that part of the prior
revision's cost analysis stands (Noise still hides content from it; it still sees both peers'
PeerIDs and IPs and the coordination-connection's timing/small volume, per the Circuit Relay v2
spec) — but the *scale* of that cost is categorically smaller than a data-hosting relay: 128 KiB
and 2 minutes per coordination attempt versus unbounded camp-document traffic for a connection's
whole life. This changes the sizing/cost conversation (Decision 3's operational-cost paragraph
below) without changing who can see what.

**ACCEPTED BY THE OWNER, 2026-09-17.** What follows is no longer an open question: the owner has
read it and accepted the limitation. Symmetric-CGNAT-both-ends pairs sync when they next share a
network. Re-opening requires new evidence about NAT behaviour, not a re-run of this analysis.

**Now the question the owner actually needs answered: for CGNAT-on-both-ends specifically, does
coordination-only relay + DCUtR actually establish a direct connection on this stack?**

**No, not in general — this holds regardless of the relay's role, and coordination-only framing
does not change it.** DCUtR's own spec (`libp2p/specs`, `connections/hole-punching.md`) states
plainly that hole punching does not work when a node is behind a **symmetric NAT** — the failure
is in the *NAT's address-mapping behavior*, which is identical whether the two peers reach each
other through a data-hosting relay or a coordination-only one, because in both cases what actually
has to succeed is the same simultaneous-dial hole punch. **A relay, of either kind, cannot make a
symmetric NAT behave like a cone NAT.** This is the same conclusion as the prior revision's DCUtR
analysis and it does not change under the corrected framing — coordination-only relay changes
*what the relay is used for*, not *whether the hole punch itself succeeds*.

**The nuance the owner's question is asking for, stated honestly:** "CGNAT" is not one behavior.
NAT mapping is classified as endpoint-independent (the same external port is reused for a given
internal port regardless of destination — punchable) or endpoint-dependent/symmetric (a new
external port per destination — not punchable by DCUtR, on any transport, coordination-only or
not). Which behavior a given carrier's CGNAT implements is **not knowable in advance and not under
Shoresh's control** — it is an ISP/carrier configuration choice, and it varies. **No sourced,
stack-specific success-rate number exists for this distinction on js-libp2p** — the closest
published data (the go-libp2p/IPFS large-scale measurements, arXiv 2510.27500 / 2604.12484) reports
an aggregate hole-punch success rate across the whole measured population of real-world NATs, not a
figure broken out by CGNAT sub-type, and it measures **go-libp2p**, not this project's js-libp2p
stack. I am not estimating a number for this stack; none exists to cite.

**Honest end state, not softened, per the owner's explicit instruction:** for the subset of
CGNAT-both-ends pairs where the mapping on at least one side is genuinely symmetric/
endpoint-dependent, **no mechanism in scope for this program — direct dial, NAT-PMP/UPnP, or
coordination-only relay+DCUtR — establishes a WAN connection.** Those specific device pairs sync
only when they share a network again (the pre-existing mDNS/LAN path, unaffected by any of this
work). For CGNAT pairs whose carrier happens to implement endpoint-independent mapping on at least
one relevant side, rendezvous + direct dial + coordination-relay-assisted DCUtR gives those pairs a
real, additional chance at a direct connection that direct dial alone would not have found. There
is no way to tell, in advance or from the app, which category a given camp's ISP falls into.

**Recommendation (confidence: high on the mechanism and the enforced limits — read directly from
the shipped package source; medium on the eventual measured success rate, which genuinely cannot be
sourced for this stack today): build the coordination-only path — rendezvous finds the peer → direct
dial → on failure, a bounded, capped coordination-only relayed connection whose sole purpose is
carrying DCuTR's CONNECT/SYNC exchange → hole punch → direct connection, with Shoresh code closing
the relayed connection itself (not relying on the library default) the moment the hole punch does
not succeed within its timeout. Do not add a sustained data-relay fallback of any kind — if the hole
punch fails, the connection fails, full stop; the camp stays LAN-only for that pair until they share
a network again.** This is Phase F material and remains fully Tier-4-gated exactly as before:
`@libp2p/circuit-relay-v2` and `@libp2p/dcutr` both require the `docs/adr/2026-09-14-internet-transport-security-gate.md`
re-assessment and `INTERNET_TRANSPORT_SIGNOFF` before either is added — nothing in this decision
authorizes adding either package now, and the re-assessment must specifically record the
coordination-only-not-data-path enforcement design above (the explicit-close-on-failure behavior
and its test) as part of what was reassessed, since it is exactly the kind of "library default
doesn't match our threat model" gap the Tier-4 ADR exists to force someone to notice before shipping.

## Decision 4 — the rendezvous (and any future relay) endpoint is configurable and fully
disable-able; "rendezvous off" is a supported, tested configuration equal to today's LAN-only mode

Owner ruling, replacing any earlier "single point of failure" framing of the Cloudflare dependency:
Shoresh is open source. An operator who does not want to depend on Shoresh's own infrastructure
forks it, points it at a self-hosted Worker, or disables WAN rendezvous entirely — that is a
feature of the license and deployment model, not a gap to apologize for. Concretely:

- The rendezvous base URL (and, once it exists, the relay address/allowlist) is a build-time or
  runtime **configuration value**, not a hardcoded `rendezvous.shoresh.org` literal — read from an
  environment/config source the same way other deployment-specific values already are in this
  codebase, with `rendezvous.shoresh.org` as the shipped default, not the only possible value.
- **Rendezvous-off is a first-class, tested configuration**, not an accidental fallback path. With
  it unset/disabled, the app must degrade to **exactly today's LAN-only behavior** — mDNS discovery,
  local pairing, everything this ADR's Decision 1 leaves untouched. This needs its own test: start
  the sync node with rendezvous disabled and assert LAN discovery/pairing/sync behave identically to
  the pre-this-ADR baseline, so the off-path cannot silently rot as rendezvous-on gets exercised more.
- The same requirement extends to any future relay (Decision 3): a relay address is configuration,
  never a hardcoded single point every installation depends on, and "no relay configured" must
  degrade to "direct-dial only, CGNAT-both-ends pairs stay LAN-only" — which is an acceptable
  *degraded* state for an operator who opted out, distinct from being the *product default* the
  owner rejected.

This is not itself a Tier-4-relevant change (configurability is orthogonal to what's on/off by
default) but it is a hard requirement on how Phase A/C and any future relay ticket are built, and
Maker's brief should treat "rendezvous-off test passes" as part of each ticket's done-definition,
not a follow-up.

## Consequences

- Phase A (Worker+KV) is buildable and testable in complete isolation from libp2p/Electron — it is
  pure HTTP service code and can be verified with `curl`/a Worker-local test harness before any
  Shoresh code changes.
- Phase B/C cannot be marked done, and must not be merged, while the Tier-4 guard is unmodified —
  widening the guard (Decision 1) is a blocking prerequisite ticket, not a follow-up.
- The namespace field is a new, permanent addition to the camp document shape — schema-adjacent,
  additive, does not require a migration (new optional field, absent = rendezvous never enabled for
  that camp).
- The signature scheme introduces one new canonical-encoding module that both the publisher and
  every verifier must import from — a second, independently-reimplemented encoder anywhere is the
  single most likely source of a silent cross-device mismatch (the same class of bug `joinCode.js`'s
  own comments warn about for wire-format changes).
- **The "no relay" clause of the 2026-09-15 WAN boundary assessment's product framing is superseded**
  by Decision 3, narrowly: a *coordination-only* relay for DCUtR is now roadmapped as a Tier-4-gated
  addition. A *data-hosting* relay remains rejected and out of scope — this is not a reopening of
  "relay" in general, and must not be read as license to add a sustained-traffic relay later without
  the owner explicitly reopening that question. The 2026-09-15 assessment's *technical* CGNAT
  analysis is unchanged and is the reason a coordination fallback exists at all.
- A coordination-only relay is still a new standing operational commitment (a long-lived, publicly
  reachable process) this project has not previously needed — smaller in traffic/cost terms than a
  data relay (128 KiB/2 minutes per connection, enforced server-side) but not zero, and that cost
  belongs in the ticket that proposes it.
- **For CGNAT-both-ends pairs where at least one side's NAT mapping is symmetric, no mechanism in
  this ADR's scope achieves WAN connectivity.** This is stated as a permanent, honest limit of the
  direct-only + coordination-relay design, not a gap expected to close later within this program.
- Configurability (Decision 4) adds a small amount of permanent surface (a config value, an
  off-path test) to every ticket in this program, in exchange for never having a
  Shoresh-infrastructure outage take down more than WAN convenience for operators who chose to
  depend on it.

## Verification (when implemented)

- Property/unit tests: canonical byte-encoding is stable and order-independent-input-safe (same
  logical record, differently-ordered `addresses` array in, same signed bytes out, once the
  module's internal sort is applied); signature verifies only for the actual signing device's
  keypair; a record with a tampered field (any of namespace/peerId/addresses/issuedAt/expiresAt)
  fails verification.
- A test asserting the widened Tier-4 guard fails when `rendezvousClient.js` is imported by
  `main.js`/`syncNode.js` with `INTERNET_TRANSPORT_SIGNOFF` false, and passes once true —
  mirroring the existing guard's own self-test pattern.
- An integration test: an unrecognized `peerId` returned from a fake rendezvous server is dropped
  before reaching `onPeerDiscovery` (never dialed).
- A test that disabling rendezvous configuration reproduces pre-ADR LAN-only behavior exactly
  (Decision 4).
- When circuit-relay-v2 + dcutr are proposed (Decision 3), their ticket must show: relay
  authentication (a rogue/unpinned relay cannot substitute itself as a coordination point), the
  `DEFAULT_DURATION_LIMIT`/`DEFAULT_DATA_LIMIT` caps configured and asserted (not left to package
  defaults silently applying), a test proving Shoresh code closes a relayed connection itself on
  DCUtR failure rather than continuing to use it (per Decision 3's "enforced, not intended"
  requirement), rate limiting sized for an internet-facing process, and the recorded Tier-4
  re-assessment — before `INTERNET_TRANSPORT_SIGNOFF` is flipped. No ticket under this ADR may add
  a sustained-data-path use of circuit-relay-v2; that remains explicitly out of scope (Decision 3,
  3a).
