---
title: "Tier-4 internet-transport boundary re-assessment (for owner sign-off before INTERNET_TRANSPORT_SIGNOFF)"
document_type: reference
authority: descriptive
status: active
date: 2026-09-26
program: security-hardening
governing_docs: [docs/adr/2026-09-14-internet-transport-security-gate.md, docs/adr/2026-09-17-wan-rendezvous-seam.md, docs/adr/2026-09-18-rendezvous-record-encoding-and-namespace-rotation.md, docs/adr/2026-09-26-schema-version-gate-before-merge.md]
---

# Tier-4 internet-transport boundary re-assessment

Assessed against commit `2aa53fcdcd121e8866a9002b66fd6aaa6682f75f` (branch `claude/t271-only`).
T270 rendezvous client read from branch `claude/dreamy-williams-da94cb`
(`electron/sync/automerge/rendezvousClient.js`).

This is the re-assessment that `docs/adr/2026-09-14-internet-transport-security-gate.md` (the
"Tier-4 gate") requires to be **recorded before** a reviewer/owner may set
`INTERNET_TRANSPORT_SIGNOFF = true`. It is written for the owner's review. It does **not** flip the
flag, set any constant, or change any code — flipping the flag is the owner's own act. Every claim
below was confirmed by reading the cited file at the cited commit; opinions and unconfirmed items
are labelled as such and separated into "Open questions".

**What is being asked for.** Sign-off would enable **Phase B/C WAN discovery**: wiring the
already-built, currently-unreachable `rendezvousClient.js` (T270) into the running app (T211,
parked) so paired devices can find each other's current network location across the internet via a
Cloudflare Worker bulletin board, then dial directly. It would **not** by itself enable any relay
or hole-punch package (Decision 3 / Phase F — those remain separately Tier-4-gated).

---

## Boundary verdict

**Trusted-LAN boundary: HOLDS TODAY, and would move to CONTROLLED-INTERNET-DISCOVERY on sign-off.**

- Shipped state is LAN-only, confirmed: `transportBoundary.guard.test.js` is green with
  `INTERNET_TRANSPORT_SIGNOFF = false`; `package.json` declares no relay/DHT/bootstrap/autonat/
  dcutr/upnp/webrtc/websockets/quic package; `electron/main.js` wires
  `peerDiscovery: [createMdnsDiscovery(...)]` and no file under `electron/sync/**` performs
  internet egress (the T207 behavioural scanner, `internetRendezvousScan.js`, backs this).
- The bind is `/ip4/0.0.0.0/tcp/0` (all interfaces), so what actually keeps the node off the
  internet today is **discovery** (mDNS, link-local multicast) plus NAT/firewall topology — not a
  code-level bind boundary. This was the 2026-09-15 correction and it still holds.
- On sign-off, the boundary changes in a **bounded** way: devices exchange *reachability data*
  (public IP + multiaddrs, in a signed record) with a public internet server, and dial peers found
  that way. Admission, authentication, and authorization are **unchanged** — a
  rendezvous-discovered peer is byte-for-byte indistinguishable from an mDNS-discovered peer from
  `mutualAuth.js` downward (confirmed: `rendezvousClient.js` emits only `{id, multiaddrs}`, the
  identical shape `transport.js`'s `onPeerDiscovery` already produces for mDNS). Discovery widens;
  the trust gate does not move.

The boundary does **not** become "public internet hosting" (still explicitly NOT-for in
SECURITY.md): no relay data path, no unauthenticated admission, no listening service beyond what
mDNS already exposed to routable hosts.

---

## 1. What the rendezvous side-channel changes about the boundary

**Before:** the only discovery was mDNS — link-local multicast, LAN-bounded.
**After sign-off:** a device `POST`s a signed record to an internet HTTPS endpoint and `GET`s peer
records from it on a timer.

### What newly LEAVES the device (confirmed against `rendezvousClient.js` + `rendezvousRecord.js`)

The `POST` body carries a base64 of the signed wire record. The signed record contents are fixed by
`buildSignedBytes()` and are exactly: `DOMAIN_PREFIX`, version byte, 32-byte namespace, peerId,
epoch, seq, issuedAt, expiresAt, the device's multiaddrs, and a 64-byte Ed25519 signature.

- **No token, no PIN, no key material, no camp data leaves.** Confirmed: `registerRecord()`
  assembles the record from `nsInfo` (namespace + epoch read from the document), the device's own
  `peerId`/`multiaddrs`, a local sequence number, and timestamps. There is no field for a session
  token, PIN, `signing_public_key`, or any camp/entity data, and the record encoder
  (`buildSignedBytes`) has no code path that could include one. The signing key is the device's
  **libp2p identity private key**, never the Host credential-signing key (ADR 2026-09-18 Decision 2)
  — and only its public half is recoverable from the peerId, which is already public.
- **What genuinely leaves and is structural: the device's public IP, via its multiaddrs.** This is
  intrinsic to a reachability record and is called out as a privacy finding in ADR 2026-09-18
  Decision 1 and the spec (§2.3). The board becomes a live register of the public IPs of staff
  laptops at children's camps. The record itself carries **no** device name, camp name, or hostname
  (confirmed — the encoder has no such field). See residual risk R6 and Open Question Q3.

### What newly ENTERS the device (confirmed against `fetchPeers()` + `verify()`)

Every field of a `GET /v1/peers` response is treated as adversarial. Confirmed the client applies,
in order, before a candidate reaches `onDiscoveredPeer`:

1. **Response-count bound** — `records.slice(0, MAX_RECORDS_PER_RESPONSE=400)` before any decode.
2. **Per-record size bound** — entries with `bytes.length > MAX_RECORD_BASE64_LENGTH=8192` skipped
   before `Buffer.from` runs. (This is the "round-2 DoS bound" — it prevents a hostile/hijacked
   worker or a namespace-flooder from forcing an unbounded number of synchronous Ed25519 verifies,
   or one huge decode, on Electron's single main thread.)
3. **Signature verify** — `verify()` recovers the public key from the record's own claimed peerId
   (self-certifying: a valid signature for peerId P is producible only by P's private-key holder)
   and checks it over the exact signed bytes.
4. **Freshness** — `issuedAt - 5min <= now <= expiresAt + 5min`, verifier's own clock; an inverted
   window (`expiresAt < issuedAt`) is rejected as malformed before the comparison.
5. **Monotonic watermark** — per-peer highest `(epoch, seq)` accepted, epoch-major; a replayed or
   edge-cached-stale record fails. Watermark is in-memory (signature is the real property; the
   watermark only defeats an edge-cached replay).
6. **isKnownPeer** — an unrecognised peerId is dropped (logged `RENDEZVOUS_PEER_DISCOVERED
   known:false`), never dialed. Only locally-already-known signing/peer identities survive.
7. **Structural rejection** — unsupported version byte and malformed/truncated fields are rejected
   before signature verification is attempted (`decode()` fails closed).

**Confirmed how:** traced each entry-point field from `fetchPeers` through `verify`/`decode`. The
client never throws across its boundary (returns `{ok:false, reason}`), and never surfaces a
rendezvous result as an app error.

---

## 2. What hole-punch coordination changes — DESIGN-FORWARD, NOT SHIPPED

Circuit-relay-v2 + DCUtR (Decision 3 / Phase F) are **not in scope for this sign-off and are not
installed**. `@libp2p/circuit-relay-v2`, `@libp2p/dcutr`, and `@chainsafe/libp2p-quic` are all on
the guard's `INTERNET_TRANSPORT_PACKAGES` forbidden list; none is in `package.json`. State plainly:
signing off on rendezvous discovery does **not** authorize adding any of them.

Recorded here so the owner sees the shape of the *next* gate, not this one:

- If/when a coordination relay is proposed, ADR 2026-09-17 Decision 3 fixes it as **brief DCUtR
  coordination only, never a data path**: `DEFAULT_DURATION_LIMIT` = 2 minutes,
  `DEFAULT_DATA_LIMIT` = 128 KiB per relayed connection, enforced server-side (values read from the
  shipped `@libp2p/circuit-relay-v2` source per that ADR) — enough for DCUtR's handshake, not enough
  to sustain Automerge sync.
- A **data-hosting** relay remains rejected and out of scope (Decision 3a) — reopening it is an
  owner act, not an engineering convenience.
- DCUtR cannot punch symmetric/CGNAT-both-ends NAT on any transport; those pairs stay LAN-only.
  The owner accepted this limit (2026-09-17).
- Phase F, if pursued, needs its **own** Tier-4 re-assessment (relay authentication, the caps
  configured-and-asserted, the explicit-close-on-DCUtR-failure test). It is not covered by this
  document.

---

## 3. Residual risks — each stated with acceptance status

**R1. The schema-version gate is ACCIDENT-prevention, not anti-forgery.** (T271, ADR 2026-09-26.)
The gate compares the peer's self-reported `schemaVersion` from the `authenticate` handshake; a
compromised authenticated peer can lie about its version for free. Confirmed in the ADR (Decision 2,
"provides NO defense against a malicious or compromised already-authenticated peer"). This ties
directly to the already-accepted CRDT-layer-compromise stance (R4) — it narrows the *accidental*
mixed-version case, which WAN discovery makes the steady state rather than a corner case. **Status:
accepted, consistent with existing stance.** It is a genuine reason to want the gate landed *before*
sign-off (which it is, on this branch).

**R2. The rendezvous namespace is derivable from camp secrets / reachable by anyone who has it.**
The namespace is a 256-bit value that rides in the camp document, so every paired device (including
a departed staffer's device, until rotation) has it. Knowing it lets an attacker: (a) publish noise
records under it, and (b) read the board's IP list for it. It does **not** let them impersonate a
trusted peer — signature verification is self-certifying against the peerId, and `isKnownPeer` +
mutual auth + the T162 token-to-peer binding still gate admission. **DoS surface:** an attacker who
knows the namespace can fill it to `MAX_PEERS_PER_NAMESPACE=200` with fabricated peerIds, locking
out a genuinely new device (429) until TTL expiry or namespace rotation (worker.js documents this
as a lockout primitive, not merely an abuse bound). The client's own `MAX_RECORDS_PER_RESPONSE=400`
+ per-record size bound protect the *client* from a flooded/hostile response. **Status: accepted
with mitigations (rotation is the closer); rotation-on-revocation automation is an open product
decision — see Q1.**

**R3. Self-reported schema version.** Same mechanism as R1, stated separately because it is the
concrete value an adversarial peer controls. Not independently verifiable. **Status: accepted (R4).**

**R4. Bearer-token-at-CRDT-layer stance.** Already accepted in SECURITY.md (T155): a camp token is
a bearer credential bound to the `device_id` inside it and, since T162, to the presenting libp2p
peer id (trust-on-first-use, mismatch refused `4405`). A compromised *paired* peer is
attacker-controlled at the CRDT layer — merges do not route through `authorize()`, role enforcement
is device-side. **Re-opened below** (§Re-opened tradeoffs) because WAN discovery widens *who can
attempt to reach* a paired peer, though not what an admitted peer can do. **Status: accepted;
re-confirmed applicable, with one sharpened note.**

**R5. The worker is an unauthenticated POST endpoint and eventually-consistent KV.** Confirmed in
worker.js: anyone may POST; write-amplification is bounded only by the worker's own caps
(`MAX_RECORD_B64_BYTES`, `MAX_PEERS_PER_NAMESPACE`, `MAX_BODY_BYTES`, 2h TTL) plus owner-configured
Cloudflare edge rate-limiting/WAF (an explicit deploy-time owner action, not code — worker.js and
its README say so). KV is eventually consistent, so `GET` may return stale/forked views; this is
**by design** and is exactly why the client carries the monotonic watermark and treats the worker
as an untrusted cache, never an authority. **Status: accepted; owner must confirm the Cloudflare-
side rate-limit/WAF and log-minimization are configured before wiring (Q2).**

**R6. Public-IP exposure on the board.** Structural to a reachability record (R1). No name/camp
data, but the IP list of camp-staff laptops is readable by anyone holding the namespace. **Status:
accepted as structural; the mitigations are namespace secrecy + rotation + short TTL, and the
owner-configured Cloudflare log minimization.**

**R7. rendezvous-OFF must degrade to exactly today's LAN-only (Decision 4).** Confirmed in
`rendezvousClient.js`: `readRendezvousConfig()` returns `{enabled:false}` when
`SHORESH_RENDEZVOUS_URL` is unset (no hardcoded fallback URL), and `startRendezvousClient()` returns
an inert stub that does **zero** fetch/timer/doc work when disabled. **This is the default.**
Confirmed *as written in the module*; the Decision-4 requirement that an integration test assert
LAN-only parity lives in the wiring ticket (T211) — see Q4. **Status: default is off-by-construction
in the module; end-to-end parity test is T211's done-definition, not yet exercised.**

---

## 4. What the boundary ADMITS after sign-off

- **New capability admitted:** internet *discovery* — a device may learn another paired device's
  current network location from a public server, and dial it directly over the existing
  Noise/Yamux/Automerge path.
- **Explicitly still OUT (not admitted by this sign-off):**
  - No relay **data path** of any kind (Decision 3a).
  - No hole-punch / relay / DHT / QUIC package (all still guard-forbidden; adding any needs its own
    re-assessment).
  - No unauthenticated admission — mutual auth, PIN/token, per-device approval, T162 binding, and
    revocation are unchanged.
  - No token, PIN, key, or camp-data egress — only signed reachability records leave.

---

## 5. What the owner is signing — plain-language summary

By flipping `INTERNET_TRANSPORT_SIGNOFF` to `true`, you accept, for the WAN-discovery capability:

1. **Your devices will tell a public internet server their current public IP address** (in a signed
   record), so your other devices can find them off-LAN. The server learns IPs, not names, not camp
   data, not PINs or keys.
2. **Anyone who has your camp's rendezvous namespace** (every paired device has it, including a
   device you later revoke, until you rotate the namespace) **can read that IP list and can spam the
   board with junk**, and if they spam it hard enough, a brand-new device may be temporarily unable
   to register until you rotate the namespace or old entries expire (~2h). They **cannot** use this
   to impersonate one of your devices or read your data.
3. **The version-safety gate that prevents mixed-version data corruption protects against honest
   mistakes, not a malicious device** — a device that has already been paired and then tampered with
   is, as it always has been under this local-first design, trusted for what it writes.
4. **You must configure Cloudflare-side rate-limiting and log minimization before this goes live**
   — that is an operational step outside the code, and the code cannot do it for you.
5. **This does NOT turn on any relay or hole-punching.** Two devices both behind carrier-grade NAT
   may still only sync when they share a network. Enabling a relay later is a *separate* decision
   with its *own* review.

### Items the owner must specifically DECIDE (not merely be informed of)

- **D1 — Cloudflare rate-limit/WAF + log minimization are configured (R5, R6).** This is a
  precondition, not a nice-to-have; the unauthenticated POST endpoint has no code-level rate limit.
  Confirm before wiring goes live.
- **D2 — Namespace rotation policy on device revocation (R2).** Automatic-on-revocation vs.
  director-initiated is left open by ADR 2026-09-18 Decision 3 ("deliberately not decided here").
  Rotation is the *only* closer for a departed device's continued board access and for the lockout-
  DoS; the owner should decide when it fires.
- **D3 — Accept the public-IP-on-a-public-board privacy exposure for children's-camp staff devices
  (R6).** Structural and unavoidable for WAN discovery; the owner should affirm it knowingly.

Items the owner is merely **informed** of (already-accepted or mechanically enforced): R1, R3, R4,
R7, and the wire-format/functional gaps in Open Questions (those block *functioning*, not the
*boundary*, and are the wiring ticket's problem).

---

## Open questions (NOT findings — need investigation before confirm/drop)

- **Q1 (product/security).** When does namespace rotation fire on device revocation? Until decided,
  a revoked device retains board read/write for its namespace until TTL/rotation. What would settle
  it: an owner ruling + the T233/revocation-propagation limitation noted in ADR 2026-09-18 Decision
  3 (a revoked device can still receive document state — including a rotated namespace — via a third
  not-yet-revoking device; that gap is T211's).
- **Q2 (operational).** Is Cloudflare edge rate-limiting/WAF + log retention actually configured for
  the deployed worker route? Code cannot verify this; needs an owner/ops confirmation.
- **Q3 (privacy).** Address-body encryption (v2 record) is explicitly out of scope for Phase B (ADR
  2026-09-18). Does the owner want it before or after go-live, given the IPs are children's-camp
  staff laptops? What would settle it: an owner decision; the versioned encoding already reserves
  room for a v2 that v1 verifiers reject rather than misparse.
- **Q4 (verification).** The Decision-4 "rendezvous-off == exactly today's LAN-only" integration
  test is T211's done-definition and does not yet exist (T211 parked). The module is off-by-
  construction, but end-to-end parity is unproven. What would settle it: the T211 test.
- **Q5 (functional, NOT a security finding — flagged so it is not mistaken for one).** The T270
  client and the T209 worker do **not** agree on wire shape as written:
  `rendezvousClient.registerRecord` POSTs `{ bytes: base64 }` and `fetchPeers` reads
  `body.records[].bytes`; `worker.js` expects `{ namespace, peerId, record }` on POST and returns
  `{ peers: [base64...] }`. As written they would not interoperate. This is a correctness gap for
  the wiring ticket (T211), on two branches that were never integrated; it does not affect the
  boundary. What would settle it: T211 reconciling the contract (and a round-trip integration test).

---

## Re-opened tradeoffs (this assessor's mandate; the per-diff reviewer cannot)

**T1 — No TLS on the wire / plaintext-PIN-in-first-login.**
- *Accepted when:* trusted-LAN, Noise-encrypted channel, PIN reaches Host in cleartext to run
  scrypt.
- *Do conditions still hold?* **Yes, for this sign-off.** Rendezvous changes *discovery*, not the
  transport: sync still runs over Noise between two authenticated peers. The PIN still travels
  inside the Noise channel and the Host still receives it to hash. WAN discovery does not expose the
  PIN on the wire. **However:** the join-flow hardening the WAN story depends on (ephemeral,
  rotating, KDF-hardened join secret — ADR 2026-09-15) is `implementation_state: proposed`, i.e. the
  40-bit permanent join code is still the shipped reality. That matters for *impersonation of a Host
  during join over public discovery*, not for the rendezvous record path (which cannot create
  trust). **Recommendation:** the plaintext-PIN/TLS tradeoff itself remains acceptable for
  discovery-only sign-off; but the owner should note that the ephemeral-join-secret work
  (WAN blocker #1) is a real precondition for the *join* experience over WAN and is not yet
  implemented. Do not let sign-off be read as "join-over-WAN is fully hardened."

**T2 — Device-side role enforcement under CRDT sync / compromised-paired-peer.**
- *Accepted when:* "a LAN of devices a director has personally approved."
- *Do conditions still hold?* **Substantially yes, with one honest sharpening.** WAN discovery does
  not change what an *admitted* peer can do, nor add an admission path — a rendezvous candidate must
  still pass mutual auth, PIN/token, per-device approval, and T162 binding. What it changes is
  *reachability*: a stolen-token + stolen-identity-key attacker who previously had to be on the LAN
  can now attempt to reach a paired peer from anywhere. The existing controls (revocation re-checked
  every authenticate; T162 rejects a token replayed from a peer other than the one it is bound to)
  are what hold the line, and they are unchanged. **Recommendation:** re-confirm accepted; the WAN
  move raises the *value* of prompt revocation and of the namespace-rotation decision (D2), which is
  why D2 is surfaced as an owner decision rather than an FYI.

**T3 — LAN-sized rate limits.**
- *Accepted when:* a handful of LAN peers.
- *Do conditions still hold?* **Partially.** The rendezvous board's abuse limits are the worker's
  own caps plus owner-configured Cloudflare rate-limiting (D1). The *libp2p dial/auth* rate limits
  (`rateLimit.js`, `MAX_CONNECTIONS`) remain LAN-sized and were flagged as a WAN blocker in the
  2026-09-15 assessment. For discovery-only sign-off the exposure is bounded (only `isKnownPeer`
  candidates are dialed, so the board cannot cause the node to dial strangers), but the pre-auth
  connection surface is now reachable by anyone who can route to a discovered device's IP.
  **Recommendation:** the owner should treat internet-scale connection/pairing/login rate-limiting
  as a fast-follow, tracked, before broad rollout — it is not strictly blocking discovery-only
  sign-off (candidates are pre-filtered to known peers) but the 2026-09-14 ADR names it as a
  required re-assessment topic, so it is recorded here as re-confirmed-still-open, not silently
  dropped.

**T4 — Electron auto-update integrity (unsigned builds).**
- *Accepted when:* not addressed under LAN.
- *Do conditions still hold?* **This is the one the 2026-09-14 ADR flags most sharply** ("unsigned
  update is an RCE vector once the app talks to the internet at all"). The 2026-09-15 WAN assessment
  lists unsigned builds as a hard blocker. Rendezvous discovery does not itself add an update
  channel, but it is the step that makes the app "talk to the internet." **Recommendation: the owner
  should confirm the code-signing / signed-auto-update posture as a precondition for broad WAN
  rollout.** For a *discovery-only, opt-in-by-config* sign-off with a small controlled set of
  operators this is lower-urgency, but it is a genuine open item the ADR itself demands be
  re-assessed, and it is not yet resolved in this tree. Flagged for owner decision.

---

## Summary score (for Grader)

Security posture: **4/5** — the rendezvous discovery design is sound and defensive (self-certifying
signatures, adversarial-input handling with a DoS bound, cannot-create-trust by construction,
LAN-only-by-default), and the version gate that should precede WAN is landing on this branch; the
residual items that keep it from a 5 are operational/owner preconditions (Cloudflare rate-limit +
log minimization, namespace-rotation policy, and the still-open WAN blockers the 2026-09-14 ADR
itself named — internet-scale libp2p rate limits and signed auto-update), plus a client/worker
wire-format mismatch that must be reconciled before wiring functions at all.

---

## Owner sign-off — 2026-09-28

**Signed off by the owner (gfeitel1) on 2026-09-28: YES, for internet-transport discovery only.**

This records the human-approval gate the 2026-09-14 ADR requires. The owner accepts this
re-assessment and authorizes enabling **Phase B/C WAN discovery** — wiring the rendezvous client
into the running app so paired devices can find each other's current network location via the
Cloudflare Worker bulletin board and dial directly. Scope, decisions, and how the residual open
items are discharged:

- **Discovery only.** This sign-off authorizes the discovery/direct-dial rung. It does **not**
  authorize the relay (Phase F, `@libp2p/circuit-relay-v2`) or hole-punch (Phase E, `@libp2p/dcutr`
  + AutoNAT) capabilities, which add materially new attack surface (a public forwarder; NAT
  traversal). Those return for a **short delta re-assessment** before their egress code lands, per
  the owner's instruction to attack the relay/hole-punch path hard.
- **The gate is being made per-capability so this scoping is enforced by the build, not by promise.**
  Rather than the coarse single `INTERNET_TRANSPORT_SIGNOFF` flip (which would mechanically disarm
  the guard for every internet package at once), the guard is refined so discovery is enabled while
  relay/DCUtR/WebRTC/QUIC stay blocked behind their own capability flags until each is signed off.
  The flip itself lands **inside the Slice C PR** (the first PR that adds discovery egress), under
  mandatory Security + Red Hat review, so the guard stays armed until egress actually arrives.
- **T4 — auto-update integrity: discharged by scope decision, not by building a central update
  channel.** The owner's product model for v1 is **open source, forked per camp**: the owner ships
  v1 and does not centrally distribute or auto-update the app for other operators — each fork/camp
  operator owns their own build, signing, and update posture. There is therefore no
  owner-operated "broad WAN rollout" for which central signed auto-update is a precondition. The
  ADR's T4 concern is resolved for the Shoresh core by removing the centrally-managed-update
  assumption; code-signing/update integrity becomes each downstream operator's responsibility, to be
  documented for them. (Ticket T289 "central signed auto-update" is descoped by this decision.)
- **Internet-scale libp2p rate limiting (T3): tracked fast-follow, not blocking discovery.** As the
  T3 assessment notes, discovery dials are pre-filtered to `isKnownPeer` candidates, so the board
  cannot cause the node to dial strangers; the pre-auth connection surface reachable by IP is the
  residual, tracked before broad use.
- **Wire-format mismatch** between client and worker contract must be reconciled as part of Slice C
  (one of the three locked forward-findings) before the wiring functions at all.
