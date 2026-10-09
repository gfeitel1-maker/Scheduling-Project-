---
title: "WAN connectivity hardening: the full NAT-traversal ladder, the data-relay reopening, v2 encrypted rendezvous records, and the attack-hardened join secret"
document_type: adr
authority: normative
status: accepted
date: 2026-09-27
decided: 2026-09-27
deciders: [owner, architect]
program: security-hardening
affects: [electron/sync/automerge/rendezvousRecord.js, electron/sync/automerge/rendezvousNamespace.js, electron/sync/automerge/rendezvousSequence.js, electron/sync/automerge/transportBoundary.guard.test.js, electron/sync/automerge/internetRendezvousScan.js, electron/sync/joinCode.js, electron/sync/automerge/joinSession.js, electron/db/atRestEncryption.js, workers/rendezvous/worker.js, package.json, docs/adr/2026-09-14-internet-transport-security-gate.md, docs/adr/2026-09-15-ephemeral-join-secret-for-wan-discovery.md, docs/adr/2026-09-17-wan-rendezvous-seam.md, docs/adr/2026-09-18-rendezvous-record-encoding-and-namespace-rotation.md, docs/work/security/2026-09-26-internet-transport-signoff-reassessment.md]
implementation_state: not-started
---

# WAN connectivity hardening: the full ladder, the data-relay reopening, v2 encrypted records, and the attack-hardened join secret

**Owner framing (quoted):** rendezvous+discovery is "table stakes, not the real bet." The real bet
is "two devices syncing from anywhere," which needs the full NAT-traversal ladder. Build the
hardening first, now, while there are no users.

**ACCEPTED — owner rulings, 2026-09-27 (recorded verbatim):**
- **Relay/TURN: Option B is IN SCOPE.** The capped, configurable data-relay fallback (Slice F)
  lives — reopening and superseding 2026-09-17 Decision 3a's "relay as sustained data path —
  rejected." The owner accepted the recommendation.
- **WAN join-proof rate limiter = BOTH:** the Cloudflare Worker (edge) AND the Host (as the
  authority) each enforce it.
- **The CPU-hours→CPU-years unit fix in 2026-09-15 is authorized** (conclusion unchanged).
- Deprioritized per owner (out of scope, not gating): revoked-device / namespace-rotation-on-revocation.

**HARD HOLD still in force for anything internet-facing.** Slices A (join-secret hardening) and B
(v2 encrypted record) do NOT trip the Tier-4 guard and are cleared to build+merge now. Slices C
(rendezvous client), E (DCUtR), F (data-relay) each trip the guard and MUST NOT merge or enable
until the owner flips `INTERNET_TRANSPORT_SIGNOFF` in
`electron/sync/automerge/transportBoundary.guard.test.js`. Slice D (signed auto-update) is gated on
the owner provisioning code-signing certificates. Ticket allocation: A=T286, B=T287, C=T288,
D=T289, E=T290, F=T291.

This ADR extends, and in one place reopens, four prior ADRs, all of which stand except where
explicitly superseded:
- 2026-09-14 — the Tier-4 internet-transport gate (unchanged, still the enforcement mechanism).
- 2026-09-15 — ephemeral/rotating/KDF-hardened join secret (accepted, unimplemented — shipped
  reality is still the permanent 40-bit `joinCode.js`; this ADR adds the attack plan the owner asked
  for and corrects a unit error in that ADR's own entropy math, below).
- 2026-09-17 — WAN rendezvous seam (accepted; Decision 3's coordination-only relay for DCUtR stands
  unchanged; **Decision 3a, "relay as sustained data path — rejected," is reopened here** at the
  owner's request).
- 2026-09-18 — rendezvous record v1 encoding + namespace rotation (accepted, implemented as pure
  library code, never wired — `rendezvousClient.js`/T211 does not exist in this tree; confirmed by
  `ls electron/sync/automerge/rendezvousClient.js` → not found). The v1 format already reserves a v2
  a v1 verifier rejects (its own Decision 1: unrecognized version byte → reject outright).

## Source verification performed (org-source-verification)

Read from `package-lock.json`, not the semver ranges in `package.json`:

| Package | package.json range | Installed | Note |
|---|---|---|---|
| `libp2p` | `^3.3.11` | **3.3.11** | matches prior ADRs' post-T215 line |
| `@libp2p/tcp` | `^11.0.28` | **11.0.28** | |
| `@libp2p/identify` | `^4.1.14` | **4.1.14** | |
| `@chainsafe/libp2p-noise` | `^17.0.0` | **17.0.0** | |
| `@libp2p/mdns` | `^12.0.32` | **12.0.32** | |
| `@libp2p/circuit-relay-v2` | — | **NOT INSTALLED** | prior ADRs cite `4.2.13` from reading its *published* source at design time; not in this tree's lockfile. Any version-specific constant below (`DEFAULT_DURATION_LIMIT` etc.) is carried forward from the 2026-09-17 ADR's own verified reading and must be re-verified against whatever version actually gets installed, per this skill's own rule — do not treat it as re-confirmed by this ADR. |
| `@libp2p/dcutr` | — | **NOT INSTALLED** | same caveat, carried from `3.0.28` as read in 2026-09-17. |
| `@libp2p/webrtc` | — | **NOT INSTALLED** | not proposed by this ADR; noted for completeness of the ladder table. |
| `electron-builder` | `^26.15.3` | **26.15.3** | `build.mac.identity: null`, `mac.target: "dir"` — **confirmed unsigned**, dev-only packaging today. |
| `electron-updater` | — | **NOT INSTALLED** | confirms Section 5 (signed auto-update) is genuinely unbuilt, not just undocumented. |
| `better-sqlite3` | `^12.11.1` | **12.11.1** | for the T175 reuse in Section 3. |

**Consequence for this ADR:** everything proposed under "Section 1, rungs 3–4" and "Section 2" is a
*design*, not a scoped-and-ready ticket — the exact enforced byte/time caps on `circuit-relay-v2`
must be re-read from whatever version is actually installed when that slice is picked up, because
none of it is in this lockfile today.

## Section 1 — the connectivity ladder, end to end

Four rungs, tried in order, each a strict widening of who two devices can find and reach. A rung is
attempted only if the previous one did not already yield a working connection; the ladder never
races rungs against each other (a design constraint carried from 2026-09-17's "rendezvous cannot
create trust" discipline — the same applies to "a slower rung must not be able to preempt a faster
one that already succeeded").

| Rung | Mechanism | NAT classes covered | libp2p pieces | Tier-4 interaction | Failure/degradation |
|---|---|---|---|---|---|
| 1. LAN (shipped) | mDNS multicast (`@libp2p/mdns`) | none needed — same broadcast domain | `@libp2p/mdns` (installed) | none — this is the pre-Tier-4 baseline | if no LAN peer answers, falls through to rung 2 (once rung 2 exists) or the device simply has no candidate |
| 2. Rendezvous + direct dial | HTTP side-channel to a Cloudflare Worker publishing signed, self-certifying records (2026-09-17/18 ADRs); feeds `onPeerDiscovery` the same shape mDNS does | full-cone, restricted-cone, port-restricted-cone NAT on **at least one side reachable directly** (i.e. no NAT traversal needed at all if a peer already has a public/forwarded address; otherwise this rung alone does not cross NAT — it only finds the *address to try*) | zero new libp2p packages — plain `fetch` (already verified in 2026-09-17 ADR) | **trips the behavioral egress scanner** (`internetRendezvousScan.js`) the moment `rendezvousClient.js`/T211 is wired into `main.js`/`syncNode.js` — this is rung 2's actual gate, not a new one | direct dial failing (both sides NATed unpredictably) falls to rung 3 |
| 3. DCUtR hole-punch, relay-coordinated | `@libp2p/dcutr` + `@libp2p/circuit-relay-v2` used **only** for the bounded CONNECT/SYNC coordination exchange (2026-09-17 Decision 3b — accepted, unchanged by this ADR) | full-cone / restricted-cone / port-restricted-cone NAT on **both** sides (the classes where the external mapping is stable/predictable) | two new packages, both Tier-4-gated, not installed today | requires `INTERNET_TRANSPORT_SIGNOFF = true` plus the specific re-assessment items 2026-09-17 already lists (relay auth, enforced caps, explicit-close-on-DCUtR-failure test) | on hole-punch failure/timeout, Shoresh code closes the relayed connection itself (never falls back to using it as a data path) and the pair stays LAN-only until they share a network |
| 4. Relay/TURN as a data path | `@libp2p/circuit-relay-v2` used as a **sustained** forwarding path, not just coordination | the one class nothing else in this ladder reaches: **symmetric/endpoint-dependent NAT on both sides** (real-world CGNAT) — DCUtR structurally cannot punch this regardless of transport (2026-09-17 Decision 3, unchanged, confirmed again by the same spec source) | same two packages as rung 3, used differently | requires `INTERNET_TRANSPORT_SIGNOFF` **and** a separate, explicit owner decision (Section 2 below) — this is not automatically unlocked by rung 3's sign-off | if no relay is configured (an operator's choice, 2026-09-17 Decision 4), the pair stays LAN-only — this is the accepted permanent floor for that operator, not a bug |

**What fraction of real pairs each rung reaches — stated honestly, per 2026-09-17's own finding,
which this ADR does not relitigate:** no sourced, js-libp2p-specific success-rate figure exists for
any of this. The only published number (~70%, aggregate, across all NAT types) is from a **go-libp2p**
large-scale measurement (arXiv 2510.27500 / 2604.12484), a different, more mature implementation, and
is not broken out by CGNAT sub-type. Rungs 1–3 together are expected to cover most punchable-NAT
pairs (the common case for home/business internet); the residual — both sides genuinely
symmetric-NAT, which is common on **mobile carrier CGNAT and some corporate NATs** — is exactly the
gap rung 4 exists to close, and is the gap that has no fix at all without a data-forwarding relay of
some kind on some network topology. This is a topology invariant, not an engineering gap this
program can close by trying harder at rungs 1–3.

## Section 2 — the relay/TURN decision (OWNER DECISION — reopens 2026-09-17 Decision 3a)

**The crisp choice.** 2026-09-17 rejected using `circuit-relay-v2` as a *sustained data path*
("Relay as a sustained DATA PATH — REJECTED, out of scope"), keeping it only for brief DCUtR
coordination (rung 3). That leaves CGNAT-both-ends pairs permanently LAN-only (Section 1, rung 4's
gap). The owner has asked this ADR to reopen that rejection and present it as an explicit choice.

**Option A — keep the 2026-09-17 rejection: no data relay, ever.** CGNAT-both-ends pairs sync only
when the two devices share a network again. Zero additional operational cost or attack surface
beyond what rungs 1–3 already carry.

**Option B — stand up a coordination relay *and* allow it to serve as a fallback sustained data
path when DCUtR fails, capped and time-boxed.** This is what Section 1 rung 4 designs.

**The key argument, verified rather than assumed (org-decision-challenge, cycle 1 — CONFIRMED):**
Automerge sync runs over a Noise-encrypted libp2p connection between the two peers, end to end. A
libp2p circuit-relay-v2 relay is, by the protocol's own design, a byte-forwarder: it relays the
already-Noise-wrapped stream between the two peer connections and never terminates or participates
in the Noise handshake itself — peers establish their own secure channel *through* the relayed
stream, the same as through any other transport hop. **Re-derived independently, not re-read from
the 2026-09-17 ADR's own framing**: this is consistent with how circuit-relay-v2 is specified (a
relay only ever sees two already-authenticated-elsewhere libp2p streams it is asked to splice; it
holds no session key for either side) and with the 2026-09-17 ADR's own separately-verified constants
table (`DEFAULT_DURATION_LIMIT`/`DEFAULT_DATA_LIMIT` are enforced by the relay on ciphertext byte
counts, which it could only do without decrypting). **Verdict: CONFIRMED.** A Shoresh-operated relay
under Option B is an untrusted, encrypted-bytes forwarder — not a data-confidentiality risk in the
sense of "the relay operator can read camp data." What it forwards, if it forwards at all, is
peer identity (both PeerIDs), both IPs, and coordination/data timing and volume — a **metadata**
exposure (who is talking to whom, when, how much), not a content exposure. This matches the 2026-09-17
ADR's own already-accepted framing for rung-3 coordination; Option B differs only in *scale* and
*duration* of that same metadata exposure, not in kind.

**The real costs of Option B, stated plainly:**
1. **Owner-hosted bandwidth.** Unlike rung 3's 128 KiB/2-minute coordination cap, a data-path relay
   carries a CGNAT-both-ends pair's *entire sync session* — potentially large `.automerge` payloads
   and every subsequent live edit, for as long as both devices stay online and unable to punch
   through. This is unbounded relative to rung 3 and scales with camp count and document size.
2. **Availability dependency.** For any CGNAT-both-ends pair, sync now *requires* the relay to be up.
   This is the first piece of standing infrastructure in this architecture that a camp's *ongoing*
   sync correctness depends on, not just its *discovery* (rendezvous already has this property for
   WAN discovery, but a failed rendezvous degrades to "can't find the peer"; a failed relay under
   Option B degrades to "found the peer, cannot sync with them at all" for exactly the pairs that
   most need it).
3. **It reopens the single-point-of-failure conversation 2026-09-17 Decision 4 settled for
   rendezvous** (self-hostable, disable-able, configurable) — Option B must inherit the identical
   configurability requirement (relay address is config, "no relay configured" degrades cleanly to
   Option A's LAN-only floor) or it reintroduces exactly the dependency the owner has already ruled
   against once, in a different guise.
4. **Tier-4 trip.** Both `@libp2p/circuit-relay-v2` and `@libp2p/dcutr` are Tier-4-gated regardless of
   which option is chosen (rung 3 already requires them); Option B does not add a *new* guard trip,
   but it does require the re-assessment to additionally record the **duration/data caps configured
   for the data-path use case specifically** — 2026-09-17's caps (2 min / 128 KiB) were sized for
   coordination only and are explicitly too small for Option B's use; Option B needs its own,
   larger, still-explicit ceiling (e.g. a bounded session duration/byte budget per relayed sync,
   configured and asserted in code, not left to package defaults) so it cannot silently become
   "just leave the relay connection open indefinitely."

**Recommendation: Option B, capped and configurable, confidence: medium-high on the security
analysis (ciphertext-only is a protocol-level guarantee, independently re-derived, not a vendor
claim), medium on the operational commitment being one the owner actually wants to carry.** The
security case for B is strong — nothing about "the relay can read your data" survives scrutiny. The
open question is entirely operational: is the owner willing to run (or otherwise provision) a relay
whose uptime CGNAT-both-ends camps' *ongoing* sync depends on, and to pay for its bandwidth. If the
answer is "not yet," Option A is the safe default and this ADR's Section 1 rung 4 stays unbuilt with
zero cost — nothing else in this ADR depends on the relay decision going either way. **This is not
this ADR's call to make; it is recorded here as the owner's decision, framed with the analysis.**

## Section 3 — v2 encrypted rendezvous record (address-body encryption, camp-shared key custody)

**Goal:** the Worker and any namespace-holder see only ciphertext for the address body; today (v1,
2026-09-18 ADR) the address list is plaintext, and the ADR's own consequences section names this as
the one open privacy gap ("multiaddrs still expose the publishing device's public IP... structural
to a reachability record").

**Key custody is the crux, and the answer is: reuse T175, do not invent new custody.** The libp2p
Ed25519 identity key (used for v1 signing) is per-device and public by design — it cannot encrypt
anything a *second* device should be able to decrypt without a live, per-pair key exchange, which
reintroduces exactly the round-trip WAN discovery exists to avoid. What's needed is a symmetric key
every device belonging to the camp already holds. **T175's at-rest key-custody machinery
(`electron/db/atRestEncryption.js`, the OS-keychain-sealed device key, the doc-cipher/AES-GCM
machinery already built and inert) exists for a materially identical problem** — a secret that must
be available to this device's own processes without being transmitted in the clear — but it is
**per-device**, sealed to one machine's OS keychain, and explicitly not designed to be shared between
devices. Reusing it directly for a camp-shared secret is therefore wrong in one specific way: T175's
key never leaves a device. What this ADR reuses is not the *key itself* but **the pattern**: a
symmetric secret, sealed at rest, derived via a documented KDF, with an explicit "what this does and
does not defend" boundary statement — applied to a *new*, camp-scoped secret that legitimately does
need to reach every paired device, the same way `camps.rendezvousDiscovery` already does today (via
ordinary Automerge document sync, 2026-09-18 Decision 2/3a).

**Design:**
1. **`camps.rendezvousAddressKey`** — a new field on the same `camps` Automerge record
   `rendezvousDiscovery` already lives on, generated once (`crypto.randomBytes(32)`) by whichever
   device first enables v2 rendezvous, propagated to every paired device for free via ordinary sync —
   identical mechanism to 2026-09-18's namespace field, not a new distribution channel. It travels
   **inside** the same trust boundary rendezvousDiscovery already relies on: a device that has never
   synced the document (a not-yet-paired joiner) cannot see it, which is exactly the property
   2026-09-18 already established for the namespace and is why this key rides the same field-shape
   discipline (a fixed, versioned scalar string, never a naively-mergeable JSON object — reusing
   2026-09-18 Decision 3a's fix directly, since the same concurrent-generation race applies here).
2. **What it encrypts:** only the `addresses[]` body of the v2 record — not `namespace`, `peerId`,
   `epoch`, `seq`, `issuedAt`, `expiresAt`, or the signature. Those stay plaintext because the
   signature must remain independently, self-certifiably verifiable by every camp device without
   needing the address key first (preserves 2026-09-18's "knowing the namespace lets an attacker
   publish noise, never impersonate a trusted peer" property unchanged) and because the Worker's
   `NAMESPACE_RE`/peer-id validation (already live in `workers/rendezvous/worker.js`) needs the
   record's outer shape to stay structurally checkable without decrypting it — the Worker's existing
   "never decode the opaque blob" contract is preserved exactly, it just now also can't read the
   addresses even if it tried.
3. **Cipher:** AES-256-GCM (the same primitive T175's `docCipher` already uses — reuse, not a second
   crypto choice for the codebase to carry), key derived via HKDF-SHA256 from
   `camps.rendezvousAddressKey` with a fixed, versioned info string (`"shoresh-rendezvous-addr-v2"`)
   — never the raw 32 random bytes used directly, so a future v3 can derive a different key from the
   same underlying secret without rotating it. A fresh random 12-byte nonce per record, prepended to
   the ciphertext (standard AES-GCM framing) — the nonce does not need to be secret, only unique per
   key, and freshness is already enforced by `issuedAt`/`epoch`/`seq`, so nonce reuse across
   *different* records from the same device cannot occur without also being a monotonicity violation
   already rejected by 2026-09-18 Decision 2.
4. **Wire shape (v2 record), reconciling client+worker+record in one pass rather than v1-then-redo:**
   the byte layout in 2026-09-18 Decision 1 is reused with `version = 0x02` and `addresses[]` replaced
   by a single `encryptedAddressBody` (varint-length-prefixed: 12-byte nonce + AES-GCM ciphertext +
   16-byte tag). Because the version byte is checked first and unconditionally (2026-09-18's own
   anti-downgrade property), a v1 verifier rejects a v2 record outright rather than misparsing it —
   the format was built in 2026-09-18 specifically to make this possible without a coexistence period.
   **`rendezvousClient.js` (T211/T288) has never been written or wired** (confirmed above) — so there
   is no existing v1 wire-shape client to reconcile against, and the "Q5 client/worker mismatch" the
   security reassessment doc flags as an open item is resolved by construction: **T288 is built once,
   directly against the v2 shape.**

   **CORRECTION (2026-09-28, T288 recon):** the paragraph above (as originally written) claimed the
   client POSTs `{recordBase64}` and reads `{records: [{recordBase64}, ...]}`. That was wrong — it was
   never checked against the Worker source. `workers/rendezvous/worker.js` (read directly for T288) is
   the real, already-shipped contract, and it is:
   - `POST /v1/register` body `{ namespace, peerId, record }` where `record` is the base64 encoding of
     `signRecord()`'s output (`handleRegister`, `worker.js` lines 141–157: destructures `namespace`,
     `peerId`, `record` from the JSON body and validates each independently).
   - `GET /v1/peers/<namespace>` → `{ peers: [base64, base64, ...] }` — a flat array of opaque base64
     blobs, not `{records: [{recordBase64}]}` (`handlePeers`, lines 175–191).
   There is no dual-shape client, no format renegotiation, no "v1 client talking to v2 worker" case —
   that part of the original claim stands. Only the concrete field/shape names were wrong. See the T288
   addendum below for the client's exact contract against this corrected shape.
5. **Migration/coexistence (org-migration):** consumer inventory = `rendezvousRecord.js`,
   `rendezvousRecord.test.js`, and nothing else (T211 unbuilt; the Worker is version-agnostic by
   design). **This is a clean, hard cutover, not a staged migration** — consistent with this
   project's pre-production posture (no live camps depend on rendezvous today; memory: owner prefers
   clean hard cutovers over back-compat machinery while there are no live users). Concretely: v1's
   `addresses[]` plaintext code path is deleted from `rendezvousRecord.js` in the same change that adds
   v2, not kept behind a flag — the version byte still exists so a stray old-format blob fails loud
   (2026-09-18's anti-downgrade property) rather than silently, but there is no "support both" runtime
   branch to maintain, because there is no deployed v1 consumer to break. **Verified independently, not
   assumed** (org-decision-challenge, cycle 1 — CONFIRMED): `rendezvousRecord.js` is pure library code,
   never imported by `main.js` or any production path (2026-09-18 Decision 4, re-confirmed by this
   ADR's own file read above), so "hard cutover" here costs nothing beyond updating the module and its
   own tests.

### Interface-contract checklist (org-interface-contracts) — v2 record + address encryption

- **Idempotency:** unchanged from 2026-09-18 — `POST` is a pure KV overwrite keyed by
  `namespace:peerId`; republishing with a newer `issuedAt`/`epoch`/`seq` is idempotent by construction.
- **Concurrent retries:** unchanged from 2026-09-18's analysis; encryption adds no new mutable shared
  state (the address key is generated once, synced via the document's existing conflict-safe
  single-field discipline reused from 2026-09-18 Decision 3a).
- **Unknown outcomes:** unchanged — a failed/timed-out `POST` is retried on the next scheduled tick;
  idempotent overwrite makes a stale double-publish harmless, same as v1.
- **Error shape:** decryption failure (wrong/missing `rendezvousAddressKey`, e.g. a device that hasn't
  yet synced the document field) returns the same `{ok: false, reason}` shape 2026-09-17 already
  specified for `registerRecord()`/`fetchPeers()` — never throws across the module boundary. A record
  that fails to decrypt is treated as **not yet resolvable**, not malformed — it may become resolvable
  once the document sync catches up, so callers should not permanently blacklist a peerId on this
  outcome the way they would on signature failure.
- **Scope/authority boundary:** unchanged from 2026-09-17/18 — the rendezvous path still never touches
  `authorize()` or `PROJECTIONS`; the address key rides the existing document-sync trust boundary,
  adding no new privileged path.
- **Trust-boundary validation:** every field of a fetched v2 record is still adversarial input,
  verified in the same order as v1 (version → structural shape → signature → freshness →
  monotonicity) **before** any attempt to decrypt the address body — decryption happens last,
  specifically so an attacker who does not hold a valid signing key for the claimed peerId cannot use
  malformed ciphertext to probe the decryption code path at all.

## Section 4 — hardened join secret: the attack plan the owner asked for

**Starting point, restated exactly:** 2026-09-15 is ACCEPTED but unimplemented. Shipped reality today
(`electron/sync/joinCode.js`, read directly) is `base32Crockford(sha256(campId)[:5])` — permanent,
deterministic, 40 bits, not a secret by the module's own header comment. This ADR does not redesign
the mechanism 2026-09-15 already specified (random Host-minted secret, window-scoped, scrypt-derived
DHT tag, rate-limited proof, 10 Crockford chars/50 bits) — it adds the adversarial attack enumeration
the owner explicitly asked for ("make sure the join secret is what we think it is — plan to attack it
as much as possible"), plus one corrected calculation.

**Entropy math, corrected (org-decision-challenge, cycle 1 — a real finding).** 2026-09-15 states
"`2^50` offline guesses is ~3.5 million CPU-hours" at ~100ms/guess. **Independently re-derived: this
is wrong by roughly four orders of magnitude, and the unit is the error, not the order of magnitude
of feasibility.** At 100ms/guess, one CPU does 10 guesses/second = 36,000 guesses/CPU-hour.
`2^50 / 36,000 ≈ 3.13 × 10^10` CPU-hours — **31 billion CPU-hours, not 3.5 million.** Converting
instead to CPU-*years* (`÷ 8,760`) gives `≈ 3.57 × 10^6` **CPU-years** — which is almost exactly the
"3.5 million" figure the ADR states, with the unit mistakenly written as "hours." **The conclusion the
ADR draws (10 chars/50 bits is infeasible to brute-force offline against a 100ms KDF) is unaffected
and, if anything, understated** — 3.5 million CPU-years is a far larger margin than 3.5 million
CPU-hours would have been. This ADR does not require reopening the 10-character decision; it flags
the unit correction as a fast-follow doc fix to 2026-09-15 so the number an auditor cites later is
right, and states the corrected figure here for the record.

**The attack plan — what Red Hat + Security should actually attempt once this is built, not just
review as a diff:**

1. **Offline brute force of the join secret from a captured DHT tag.** Attack: given
   `scrypt(secret, fixed_salt, …)` published to the public DHT, attempt to recover `secret` by
   grinding candidates. Defeated by: KDF cost (~100ms/guess, verified against the *actual chosen
   scrypt parameters once implemented* — this ADR does not let "100ms" stand unverified against real
   N/r/p values; that verification is part of the ticket's done-definition) × 50 bits of entropy ×
   the secret's own ephemeral window (minutes) — even a free-standing GPU cluster cannot exhaust the
   space inside the window the secret is alive. **What to actually try:** implement the scrypt
   parameters as specced, benchmark real guesses/second on commodity hardware (not the 100ms
   assumption — measure it), and confirm the measured cost, not the assumed one, still makes
   in-window brute force infeasible.
2. **Replay of a previously valid join proof.** Attack: capture a valid join-proof HMAC from a past,
   legitimate pairing attempt and replay it against a new session. Defeated by: the secret rotating
   per Add-a-device window (a captured proof is bound to a secret that no longer exists once the
   window closes) — **what to actually try:** capture a proof mid-window, replay it against the *same*
   window before it closes (should still succeed once — proofs are not meant to be single-use within
   a live window, only across windows) and then replay the same proof after the window closes or a
   new window opens (must fail). If proofs are meant to be single-use even within one window, that is
   a separate requirement this ADR does not currently impose and should be raised as an open question
   if the owner wants it.
3. **MITM the join exchange itself.** Attack: intercept the joiner's DHT lookup or the subsequent
   libp2p dial and substitute an attacker-controlled Host before mutual auth completes. Defeated by:
   Noise's mutual authentication (the join proof binds the two roles, per 2026-09-15's own note that
   "the proof only proves code-knowledge" is *already* the honestly-scoped guarantee) — **what to
   actually try:** stand up an on-path relay/proxy between joiner and the real Host during a join
   attempt and confirm the connection fails closed rather than silently succeeding through the
   interceptor; also confirm that an interceptor who does NOT know the secret cannot complete the
   proof exchange even with full network position.
4. **Impersonate a Host over public discovery (rogue Host).** Attack: an attacker who has somehow
   learned or guessed a live secret stands up a fake Host and waits for a joiner to connect, harvesting
   the joiner's PIN on first login (2026-09-15's own named threat model, §2). Defeated by: this is
   **not** fully defeated by the join-secret hardening alone — it is defeated by the *combination* of
   (a) the secret being hard to learn/guess (attacks 1–3) and (b) the first-login PIN exchange itself
   happening inside the Noise channel, so a passive eavesdropper on the wire cannot read it even if
   they observe the exchange — **but an active impersonator who successfully completes the join proof
   is indistinguishable from the real Host to the joiner at the protocol level, by design** (the proof
   proves code-knowledge, not Host identity beyond that). **What to actually try:** with a
   deliberately-leaked secret (simulating a whiteboard photo or a departed staffer), confirm a rogue
   Host CAN harvest a PIN — this is the honestly-scoped residual 2026-09-15 already names, and the
   test's job is to confirm it is bounded by the window/rotation (the rogue Host's opportunity dies
   when the window closes) rather than open-ended, not to prove it doesn't exist.
5. **Offline attack on a captured v2 rendezvous record.** Attack: an attacker who captures a
   published v2 record (Section 3) attempts to recover `rendezvousAddressKey` from the ciphertext
   alone. Defeated by: AES-256-GCM's key-recovery resistance is unrelated to the join-secret's
   brute-forceability — the address key is never derived from anything guessable (raw
   `crypto.randomBytes(32)`), so this reduces to "can you break AES-256-GCM," not "can you guess a
   human-typeable code." **What to actually try:** confirm the ciphertext reveals nothing about
   address structure (no length side-channel beyond the padded/fixed multiaddr encoding already
   specified in 2026-09-18) and that a record encrypted under one camp's key does not decrypt (even
   partially/garbage-detectably) under another camp's key.
6. **Rate-limit bypass on the online proof-attempt path.** Attack: flood the Host (or, once WAN join
   exists, the equivalent WAN-reachable proof endpoint) with proof attempts faster than the stated
   rate limit permits, to grind the 50-bit space online instead of offline. Defeated by: 2026-09-15's
   own requirement 4 ("rate-limited proof... per source") — **what to actually try:** confirm the
   rate limit is enforced **per source** in a way that can't be trivially bypassed by rotating source
   IPs/identities (this needs its own design decision at implementation time — this ADR does not
   currently specify the rate-limit key, which is an open gap Maker's brief must not silently fill in
   without it being reviewed), and confirm the limit holds under concurrent attempts from multiple
   sources simultaneously (a distributed guess doesn't get to reset per-source counters).

**Open gap flagged, not resolved here:** the *WAN-reachable* equivalent of "rate-limited per source"
(item 6) needs a specific mechanism decision (worker-side? Host-side? both?) once join-over-WAN is
actually built — 2026-09-15 says "rate-limited... per source" but does not specify where that limiter
lives once the join attempt can arrive over the internet rather than only LAN. This ADR does not
resolve it; it is named as a design gap the join-secret slice must close, not invent silently.

## Section 5 — signed auto-update (its own workstream, sequenced separately, hard prerequisite)

**Confirmed unbuilt, not just undocumented** (source verification above): `mac.identity: null`,
`mac.target: "dir"` (unsigned dev-only packaging), and `electron-updater` is not a dependency at all.
There is no update feed, signed or otherwise, today.

**Why this is a hard prerequisite, restated from 2026-09-14's own list (item 4, still open):** once
this app talks to the internet at all (rungs 2–4), an unsigned update mechanism — or worse, no update
mechanism, meaning security fixes to the ladder above can only reach devices by manual reinstall — is
an RCE vector the moment auto-update exists, and a *patch-distribution* failure if auto-update never
exists. Both are unacceptable once real camp devices are internet-reachable.

**Mechanism, at design level (not implementation-ready — this needs its own ticket, its own
source-verification pass on `electron-updater`'s actual API once chosen, and is explicitly NOT gated
on any decision in Sections 1–4):**
1. **Code signing.** A real Apple Developer ID certificate (distinct from the free self-signed
   certificate T175's own notes already distinguish for keychain-ACL purposes only — that one does
   *not* satisfy Gatekeeper/notarization) for macOS notarization, and an Authenticode certificate for
   Windows. This is a cost + process item (Apple Developer Program enrollment) the owner must
   provision; it is not a code change.
2. **electron-builder's built-in publish/update support** (`electron-builder`'s `publish` config +
   `electron-updater` at runtime) is the natural fit given `electron-builder` is already the packaging
   tool in this repo (`^26.15.3`, verified installed) — using a generic-server or GitHub-releases
   provider rather than inventing a bespoke update channel. **This choice needs its own
   org-source-verification pass against whatever `electron-updater` version is actually installed
   when the ticket is picked up** — this ADR does not verify its API here because it is not installed
   and verifying an uninstalled package's behavior would violate the same rule this ADR follows for
   `circuit-relay-v2`/`dcutr` above.
3. **Update integrity, not just code identity:** electron-updater verifies the update package's
   signature against the signing certificate before applying it — this is the actual RCE defense
   (an attacker who compromises the update *feed* but not the signing key cannot push a malicious
   build that installs silently).

**Sequencing (why this is a *separate* workstream, not folded into connectivity):** it has zero
technical dependency on Sections 1–4 — it can be built and shipped entirely independently, against
today's LAN-only app, and should be, because **it is the prerequisite for shipping any of Sections
1–4 to a real camp**, not a consequence of them. Building it in parallel, ahead of or alongside the
join-secret/address-encryption work, means the ladder is never enabled for a real camp before the
mechanism to patch it exists.

## Deprioritized per owner (out of scope, not gated on)

Revoked-device / namespace-rotation-on-revocation policy remains the open product decision
2026-09-18 Decision 3 already named as deliberately undecided (whether rotation fires automatically
on every device revocation, or is director-initiated). This ADR does not resolve it and does not gate
anything above on it being resolved.

## Consequences

- No code changes ship from this ADR by itself. Every consequence below is conditional on the owner
  ruling on Section 2 and on slices being picked up.
- If Option A (Section 2) is chosen: Section 1 rung 4 is permanently unbuilt; nothing else in this
  ADR changes.
- If Option B is chosen: a new, larger-than-rung-3 duration/byte cap must be designed and
  Tier-4-recorded before `circuit-relay-v2` is used as a data path — this ADR does not set that cap,
  it names the requirement.
- Section 3's v2 record format is a breaking, non-coexisting change to `rendezvousRecord.js` — safe
  only because nothing consumes v1 in production today (verified above); this stops being a safe
  clean cutover the moment T211 or any other consumer is wired against v1, so this ADR's migration
  posture (Section 3, point 5) expires the moment that changes and must be re-checked if slices land
  out of the proposed order.
- `camps` gains one more permanent optional field (`rendezvousAddressKey`) alongside
  `rendezvousDiscovery` — additive, no migration, same class as 2026-09-18's fields.
- Section 4 does not change 2026-09-15's mechanism, only adds verification obligations (real
  benchmarked KDF cost, the rate-limit-key open gap) that its own ticket must close before being
  called done.
- Section 5 has no dependency on and is not gated by Sections 1–4, and should be sequenced to land
  before any of them are enabled for a real camp, per its own "hard prerequisite" framing above.

## Slice plan (structure only — Governor allocates ticket numbers from T286+ after a fresh scan)

Ordering rationale: hardening before any internet rung is *enabled by default*; the relay decision
(owner-gated) sits last because nothing else depends on it; signed-update runs in parallel, not in
sequence, because it has no technical dependency on the rest.

**Slice A — Join secret hardening (implements 2026-09-15, adds Section 4's attack-plan verification).**
Scope: random Host-minted ephemeral secret, window-scoped advertising, scrypt-derived DHT tag with
*measured* (not assumed) cost, rate-limited proof with an explicit rate-limit-key decision (the open
gap named above), replacing `joinCode.js`'s permanent derivation. Trips Tier-4 guard: no (LAN-only
mechanism change; only becomes Tier-4-relevant once combined with public-DHT discovery, per
2026-09-15's own framing). Schema migration: no (no new persisted shape; the secret is ephemeral/
in-memory + Host-window-scoped). Owner-gated: no — 2026-09-15 already accepted the mechanism; this
slice implements an accepted decision. Sequenced first because address encryption (Slice B) and
signed-update (Slice D) do not depend on it, but the owner's explicit "attack it as much as possible"
framing makes it the highest-priority hardening item.

**Slice B — v2 encrypted rendezvous record (Section 3).**
Scope: `rendezvousAddressKey` document field + generation/propagation, `rendezvousRecord.js` v2
byte layout + AES-256-GCM address-body encryption/decryption, hard cutover of `rendezvousRecord.js`
(delete v1 address-plaintext path), updated tests per 2026-09-18's own verification list plus
encryption round-trip/tamper tests. Trips Tier-4 guard: no (pure library code, same as v1 — not
wired to any production path by this slice). Schema migration: additive-only document field, no
SQLite change. Owner-gated: no — this is a privacy hardening of an already-accepted mechanism, not a
new tradeoff. Depends on Slice A only in the sense that both touch the join/discovery surface, but
has no code dependency on it — could land in parallel.

**Slice C — Rendezvous client (T211), built directly against v2.**
Scope: the actual `rendezvousClient.js` — POST/GET against `workers/rendezvous/worker.js`'s existing
opaque-blob contract, wired to consume Slice B's v2 shape only (never builds a v1 client). This is
the slice that **first trips the Tier-4 guard's behavioral egress scanner** the moment it is imported
by `main.js`/`syncNode.js`. Trips Tier-4 guard: **yes** — this is the first internet-egress-capable
module in this program; requires the 2026-09-26 re-assessment's items to be re-confirmed against
whatever code state exists at that time, and `INTERNET_TRANSPORT_SIGNOFF` flipped only after that.
Schema migration: no. Owner-gated: **yes** — the sign-off flip itself is an owner act per the
2026-09-14 ADR's own enforcement design. Depends on Slice B (needs the v2 shape to exist first) and
benefits from Slice A being live (joining over WAN without the hardened secret is a materially weaker
state, though not a hard code dependency).

**Slice D — Signed auto-update (Section 5).**
Scope: code-signing certificate provisioning (owner-side, non-code), `electron-builder` publish
config + `electron-updater` integration, update-integrity verification. Trips Tier-4 guard: no (not
a sync-transport change at all). Schema migration: no. Owner-gated: **yes**, but on provisioning
(certificate cost/process), not on a security tradeoff — sequenced to run in parallel with A–C, not
after them, and must complete before any of A–C is enabled for a real camp.

**Slice E — DCUtR coordination-only hole punch (rung 3, implements 2026-09-17 Decision 3b).**
Scope: add `@libp2p/circuit-relay-v2` + `@libp2p/dcutr` (org-source-verification against whatever
version resolves at that time — not the versions cited in the 2026-09-17 ADR, which are unverified
against this lockfile), the explicit-close-on-DCuTR-failure behavior and its test (2026-09-17's own
named gap in the library's default behavior), a standing relay coordination process. Trips Tier-4
guard: **yes** — new internet-transport packages, requires its own re-assessment recording the
enforced caps and the close-on-failure test. Schema migration: no. Owner-gated: **yes** (sign-off
flip + who operates the coordination relay). Depends on Slice C (needs rendezvous working to find a
candidate peer to punch toward) and Slice D being complete (nothing in A–C/E should ship to a real
camp before signed update exists).

**Slice F — Relay/TURN as sustained data path (rung 4, Section 2 Option B) — fully owner-gated,
last.** Scope: only built if the owner chooses Option B. A new, larger duration/byte cap (distinct
from rung 3's coordination caps) designed and Tier-4-recorded, configurable relay address with a
clean LAN-only degradation when unconfigured (2026-09-17 Decision 4's pattern, extended). Trips Tier-4
guard: yes (re-assessment must explicitly cover the data-path use, not just coordination). Schema
migration: no. Owner-gated: **yes, entirely** — this slice does not exist unless Section 2 is decided
in favor of Option B. Depends on Slice E (relay infrastructure already exists for coordination; this
extends its use).

## Open questions for the owner (all decisions, not settled)

1. **Section 2 — Option A vs. Option B for CGNAT-both-ends relay.** The crisp choice, the
   ciphertext-only analysis (confirmed), the operational cost, this ADR's recommendation (B, capped
   and configurable) and stated confidence (medium-high on security, medium on whether the
   operational commitment is wanted).
2. **Section 4, item 6's open gap** — where the WAN-reachable join-proof rate limiter lives (worker,
   Host, or both) — not resolved by this ADR, needed before Slice A can be called complete once WAN
   join exists (LAN-only join today has no WAN-reachable proof endpoint to rate-limit, so this can
   defer to whenever WAN join is actually wired, but must not be silently decided by Maker).
3. **`INTERNET_TRANSPORT_SIGNOFF` flip for Slice C** — an explicit owner act per the existing Tier-4
   ADR's design; this ADR does not request it now.
4. Whether the owner wants to correct 2026-09-15's CPU-hours/CPU-years unit error as its own small
   doc fix (Section 4) — cosmetic, does not block anything, flagged for completeness.

---

## Addendum 2026-09-28 (Architect, T288) — per-capability transport gate, rendezvous client design

**Status of this addendum:** normative for Slice C (T288). Written after the owner's DISCOVERY-ONLY
sign-off (`docs/work/security/2026-09-26-internet-transport-signoff-reassessment.md`, owner sign-off
section dated 2026-09-28). Relay (Slice F/`@libp2p/circuit-relay-v2`) and hole-punch
(Slice E/`@libp2p/dcutr`+`autonat`) remain **NOT authorized** and must stay build-blocked. Everything
below is designed so that flipping discovery on cannot, by construction, also flip those on.

### 0. Divergent design pass (adhd skill, summary)

Five cognitive frames (regulator, attacker, logistics, inversion, 3am-on-call) were run in parallel,
isolated, no cross-contamination. Converged, independently-corroborated themes:
- **A single checked-in capability registry is the source of truth** (regulator + 3am-on-call
  converged on this independently — strong signal). Not four independently-maintained lists.
- **Fail-closed, allowlist-not-blocklist** for both the package scan and the egress scan (inversion +
  attacker both identified blocklist-of-known-bad as the failure mode that lets a renamed/new package
  or a novel egress primitive through silently authorized).
- **Package scan must walk the resolved dependency tree (lockfile), not just `package.json` direct
  deps** — a wrapper package that depends on `@libp2p/circuit-relay-v2` internally defeats a
  direct-deps-only scan (attacker frame's top exploit).
- **Discovery's egress allowance must be an exact-filename allowlist, not "any file the discovery
  capability's entrypoint imports"** — the attacker frame's top exploit was adding a new file under
  `electron/sync/**` that isn't itself network code but is imported only by the now-authorized
  discovery module, inheriting its pass. The fix is to scope by file identity, never by import
  relationship.
- **Golden fixture / planted-violation tests per capability**, proving each detector actually fires
  (3am-on-call) — this repo has shipped a guard that only agreed with clean code before (see
  `internetRendezvousScan.js`'s own header comment on T207).
- **An append-only, dated signoff record instead of a bare boolean** (regulator + 3am-on-call) — an
  auditor asks "who authorized what, when," which `git blame` on a boolean cannot answer well once
  there are 10+ capabilities.

Traps identified and designed out below: reusing the old coarse flag as a fallback/default for the new
discovery flag (inversion); gating relay code behind an env var that could default true outside the
scanned path (attacker); regex-only import scanning that misses dynamic `import()`/computed
`require()` (attacker + inversion).

### 1. Per-capability transport gate — design

**Registry file (new): `electron/sync/automerge/transportCapabilities.js`.** Single source of truth,
imported by the guard test and by nothing else at runtime (it is data, not wiring — importing it from
`transport.js` or `syncStarter.js` would let production code branch on it, which is not the intent;
the gate is a build-time/test-time check only).

```js
// electron/sync/automerge/transportCapabilities.js
//
// One row per capability. This file is the ONLY place a capability's authorization state lives —
// the guard test (transportBoundary.guard.test.js) reads it, nothing hard-codes a second copy of
// "is X allowed" anywhere else. Default for every capability is BLOCKED; a capability becomes
// ALLOWED only by adding a `signoff` entry here, in the same PR that lands the capability's code,
// under mandatory Security + Red Hat review (see ADR 2026-09-27 addendum §5).
//
// `packages`: npm package names whose presence (anywhere in the resolved dependency tree, not just
// direct deps) implies this capability.
// `sourceMarkers`: literal strings that must not appear in syncStarter.js's source when this
// capability is blocked (function/import names a wiring of this capability would use).
// `egressAllowlist`: for the DISCOVERY capability only — the exact, closed set of file basenames
// under electron/sync/** that are authorized to perform their own network egress (fetch/https/etc).
// Every other file under electron/sync/** must have zero egress, regardless of capability state.
// `signoff`: null = blocked (default). `{date, owner, doc}` = authorized — `doc` must point at a
// dated sign-off record (an ADR, or docs/work/security/*signoff*.md).

export const TRANSPORT_CAPABILITIES = {
  discovery: {
    packages: [], // discovery ships no new libp2p package — it's a plain `fetch` client
    sourceMarkers: [], // discovery is wired as peerDiscovery entries in syncStarter.js; see note below
    egressAllowlist: ['rendezvousClient.js'], // the ONLY file allowed to fetch()
    // Implementation note (T288 round 2): the shipped allowlist matches the FULL repo-relative path
    // ('electron/sync/automerge/rendezvousClient.js'), not the basename, so a same-named file at a
    // different path cannot inherit the exemption. The design intent ("exact file identity") is unchanged.
    signoff: {
      date: '2026-09-28',
      owner: 'gfeitel1', // GitHub handle, not an email — keep PII out of public history
      doc: 'docs/work/security/2026-09-26-internet-transport-signoff-reassessment.md#owner-sign-off',
    },
  },
  relay: {
    packages: ['@libp2p/circuit-relay-v2'],
    sourceMarkers: ['circuitRelay'],
    egressAllowlist: [],
    signoff: null,
  },
  dcutr: {
    packages: ['@libp2p/dcutr', '@libp2p/autonat'],
    sourceMarkers: ['dcutr', 'autonat'],
    egressAllowlist: [],
    signoff: null,
  },
  webrtc: {
    packages: ['@libp2p/webrtc', '@libp2p/webrtc-direct'],
    sourceMarkers: ['webRTC'],
    egressAllowlist: [],
    signoff: null,
  },
  websockets: {
    packages: ['@libp2p/websockets'],
    sourceMarkers: [],
    egressAllowlist: [],
    signoff: null,
  },
  webtransport: {
    packages: ['@libp2p/webtransport'],
    sourceMarkers: [],
    egressAllowlist: [],
    signoff: null,
  },
  quic: {
    packages: ['@chainsafe/libp2p-quic'],
    sourceMarkers: [],
    egressAllowlist: [],
    signoff: null,
  },
  kadDht: {
    packages: ['@libp2p/kad-dht'],
    sourceMarkers: ['kadDHT'],
    egressAllowlist: [],
    signoff: null,
  },
  bootstrap: {
    packages: ['@libp2p/bootstrap'],
    sourceMarkers: ['bootstrap('],
    egressAllowlist: [],
    signoff: null,
  },
  upnp: {
    packages: ['@libp2p/upnp-nat'],
    sourceMarkers: [],
    egressAllowlist: [],
    signoff: null,
  },
}

// Flat views the guard consumes — computed, never hand-duplicated.
export const ALL_FORBIDDEN_PACKAGES = () =>
  Object.entries(TRANSPORT_CAPABILITIES).flatMap(([cap, c]) => (c.signoff ? [] : c.packages))
export const ALL_FORBIDDEN_MARKERS = () =>
  Object.entries(TRANSPORT_CAPABILITIES).flatMap(([cap, c]) => (c.signoff ? [] : c.sourceMarkers))
export const DISCOVERY_EGRESS_ALLOWLIST = TRANSPORT_CAPABILITIES.discovery.egressAllowlist
```

Note on `discovery.sourceMarkers: []` — discovery's wiring into `syncStarter.js` is not a forbidden
marker to check for; it's an ADDITION the guard must now positively expect (see 1.2 below), not a
string it forbids.

**Why not an env var or a second boolean (the two "obvious" designs, rejected):** an env var can
default true in a path the static scan never inspects (attacker frame — the literal exploit named for
relay). A second boolean (`DISCOVERY_SIGNOFF`) sitting next to `INTERNET_TRANSPORT_SIGNOFF` still
requires every one of the four assertions to be hand-taught which boolean gates which check, which is
exactly the shared-mutable-state trap the inversion frame flagged: one accidental `||` between the two
booleans re-creates the coarse gate. A registry makes "which capabilities are on" a single computed
read (`Object.values(TRANSPORT_CAPABILITIES).filter(c => c.signoff)`), and makes adding capability #12
a data-entry change, not a new code path in the guard (3am-on-call's explicit ask).

**1.1 Package-presence assertion (replaces the current direct-deps check).**

```js
it('declares no un-signed-off internet-transport dependency, anywhere in the resolved tree', () => {
  const lockfile = JSON.parse(readFileSync(join(repoRoot, 'package-lock.json'), 'utf8'))
  const resolvedPackageNames = new Set(
    Object.keys(lockfile.packages ?? {})
      .map((p) => p.replace(/^node_modules\//, '').replace(/.*\/node_modules\//, ''))
  )
  const forbidden = ALL_FORBIDDEN_PACKAGES()
  const present = forbidden.filter((p) => resolvedPackageNames.has(p))
  expect(present, `Un-signed-off transport package present in the resolved dependency tree ` +
    `(direct or transitive): ${present.join(', ')}. Add a signoff entry in transportCapabilities.js ` +
    `only after the ADR re-assessment for that capability is recorded.`
  ).toEqual([])
})
```

This closes the attacker frame's transitive-dependency exploit (a wrapper package depending on
`@libp2p/circuit-relay-v2` internally) — `package-lock.json`'s `packages` map lists every resolved
node_modules path regardless of nesting depth, which is why `1.` grounded this against the actual
lockfile shape rather than `package.json`'s direct-deps object (`org-source-verification`: verified
against this repo's installed `libp2p@3.3.11` / lockfile — see §6 below).

**1.2 syncStarter marker assertion — now asymmetric per capability.**

Two sub-assertions, not one regex:
- **Positive expectation for discovery** (only meaningful once discovery is authorized): if
  `TRANSPORT_CAPABILITIES.discovery.signoff` is set, `syncStarter.js` MUST reference a rendezvous
  wiring symbol (e.g. `createRendezvousDiscovery` — see §2 for the exact export name the client
  provides) alongside the existing `createMdnsDiscovery(` — i.e. discovery being "on" is itself
  asserted, not just "not forbidden." This stops a signed-off-but-never-wired flag from silently
  reading as compliant (the inversion frame's "blocks discovery too by accident" failure mode, applied
  in reverse: a flag that's on in the registry but has no effect on `syncStarter.js` is just as wrong
  as one that's off but has an effect).
- **Negative assertion for every still-blocked capability**, computed from the registry rather than a
  hand-written array:

```js
it('syncStarter.js references no marker of a still-blocked capability', () => {
  const starterSrc = readFileSync(join(__dirname, 'syncStarter.js'), 'utf8')
  const forbiddenMarkers = ALL_FORBIDDEN_MARKERS()
  const present = forbiddenMarkers.filter((m) => starterSrc.includes(m))
  expect(present, `syncStarter.js references blocked-capability marker(s): ${present.join(', ')}.`
  ).toEqual([])
})
```

Because `ALL_FORBIDDEN_MARKERS()` excludes discovery's markers only when discovery has a `signoff`
entry, discovery going green cannot silently widen what this loop tolerates for `relay`/`dcutr`/etc —
each capability's markers are excluded from the forbidden set individually, keyed by its own
`signoff`, never by a global "signoff granted" flag.

**1.3 Behavioral egress scan — allowlist by exact file identity, not by import relationship.**

`internetRendezvousScan.js`'s `findInternetEgress` stays as the pattern-matching primitive
(unmodified — it correctly has no opinion on policy, only on "does this text contain an egress
primitive"). What changes is the guard test's use of it:

```js
it('the sync path performs no internet egress outside the signed-off discovery allowlist', () => {
  const syncDir = join(repoRoot, 'electron', 'sync')
  const files = [] // ...same walk as today...
  const scanned = files.filter((f) => !f.endsWith('internetRendezvousScan.js'))
  const allowlist = new Set(DISCOVERY_EGRESS_ALLOWLIST) // e.g. ['rendezvousClient.js']
  const discoveryOn = Boolean(TRANSPORT_CAPABILITIES.discovery.signoff)

  const offenders = scanned
    .map((f) => [f.slice(repoRoot.length + 1), path.basename(f), findInternetEgress(readFileSync(f, 'utf8'))])
    .filter(([, basename, hits]) => hits.length > 0 && !(discoveryOn && allowlist.has(basename)))
    .map(([rel, , hits]) => `${rel} (${hits.join(', ')})`)

  expect(offenders, `Unauthorized internet egress: ${offenders.join('; ')}. Only the files named in ` +
    `TRANSPORT_CAPABILITIES.discovery.egressAllowlist may perform their own egress, and only while ` +
    `discovery has a signoff entry.`
  ).toEqual([])
})
```

This is the load-bearing fix for the attacker frame's top exploit: a NEW file (e.g. `relayBridge.js`)
imported only by `rendezvousClient.js` still gets scanned on its own path and its own basename is
checked against the allowlist independently — it is not exempted by virtue of who imports it. Adding a
second file to the allowlist requires touching `transportCapabilities.js` under the same Security +
Red Hat review gate as flipping a signoff, which is the auditable choke point (guard-the-choke-point,
not-the-instance, per project memory).

`findInternetEgress` itself should gain one more pattern to close the dynamic-import/computed-require
gap the attacker and inversion frames both raised:

```js
{ label: 'dynamic import()/computed require()', re: /\bimport\s*\(\s*[^'"`]/m }, // import(expr), not import('literal')
```

(a static `import('./x.js')` with a string literal is not egress by itself and is already excluded by
this pattern only matching a non-literal argument; `require(someVariable)` is covered by the existing
absence of any literal-string requirement in that class of check — confirm during Maker's red-first
pass per §6 below rather than assumed here.)

**1.4 transport.js import-scan assertion — same registry-driven negative check as 1.2, minor change
only** (replace the hand-maintained `INTERNET_TRANSPORT_PACKAGES` array with `ALL_FORBIDDEN_PACKAGES()`
from the registry; logic otherwise unchanged, since discovery introduces no new import into
`transport.js` at all — the rendezvous client is a peerDiscovery function passed into `syncStarter.js`,
parallel to `createMdnsDiscovery`, and never touches `transport.js`).

**Fail-closed invariant, stated once, binding on all four assertions:** a capability with no `signoff`
entry is blocked by every assertion independently. There is no code path in any of the four checks
that reads a SINGLE shared "is anything signed off" boolean — each reads `TRANSPORT_CAPABILITIES`
per-capability. This is the direct fix for the inversion frame's "shared mutable state" trap.

### 2. Wire contract — exact spec for the T288 client

**File:** `electron/sync/automerge/rendezvousClient.js` (new — the v1 file at
`claude/dreamy-williams-da94cb:electron/sync/automerge/rendezvousClient.js` is superseded and MUST NOT
be resurrected: 2-arg `signRecord`, no `addressKey`, `{bytes}` wire shape, all incompatible with the
shipped v2 `rendezvousRecord.js`).

**Publish (`POST {baseUrl}/v1/register`):**
```
body: {
  namespace: <64-hex string>,      // readRendezvousNamespace(doc(), campId).namespace
  peerId:    <string>,              // this device's libp2p PeerId.toString()
  record:    <base64 string>,       // base64(signRecord(record, privateKey, addressKey))
}
```
matching `handleRegister` (`workers/rendezvous/worker.js` lines 124–173) field-for-field. Response:
`{ok: true}` (200) on success; `{error: string}` with 400/413/429 on rejection — never throw, the
client turns every non-2xx into `{ok: false, reason: <mapped>}` (see error shape below).

**Discover (`GET {baseUrl}/v1/peers/{namespace}`):**
```
response: { peers: [<base64 string>, <base64 string>, ...] }
```
matching `handlePeers` (lines 175–191) exactly — a flat array of opaque base64 blobs, no `records`
wrapper, no per-entry metadata. The client base64-decodes each entry to bytes and passes it to
`verify()` from `rendezvousRecord.js`.

**org-interface-contracts checklist for this contract:**
- **Idempotency.** `POST /v1/register` is a `kv.put` keyed by `(namespace, peerId)` with a TTL — a
  re-POST of the same or a newer record (a fresh `signRecord` output with `seq` incremented) simply
  overwrites the KV entry. Idempotent in the sense that matters here: publishing twice never
  double-registers or double-counts against `MAX_PEERS_PER_NAMESPACE` for an already-registered peer
  (confirmed directly in `handleRegister`'s `existing === null` branch, worker.js lines 161–169). No
  client-side retry key is needed beyond retrying the same POST.
- **Concurrent retries.** Two publish ticks racing (e.g. a timer firing while a previous publish is
  still in flight) both produce valid signed records with increasing `seq`; whichever POST lands last
  at the KV layer wins, and the verifier-side watermark (`lastEpoch`/`lastSeq` in `verify()`) means an
  out-of-order arrival at a READER is rejected as non-monotonic rather than accepted — convergence is
  correct even under reordering. The client should still avoid firing two publishes concurrently
  (single in-flight publish per tick, skip-not-queue if the previous one hasn't resolved) purely to
  bound Worker load, not because correctness requires it.
- **Unknown outcomes.** A `fetch` that times out or the process losing network mid-request is treated
  as `{ok: false, reason: 'unknown'}` — the client MUST NOT assume the record either did or didn't
  reach the Worker. Retrying is always safe (idempotent per above), so the caller's policy is simply
  "retry next tick," never "assume failure and do something destructive," and never "assume success and
  skip the next publish."
- **Error shape.** The client never throws across its own boundary (matching `rendezvousRecord.js`'s
  own `verify()`/`decryptAddressBody` discipline). Every method returns `{ok: true, ...}` or
  `{ok: false, reason: 'network' | 'http_4xx' | 'http_5xx' | 'malformed_response' | 'unknown'}`.
- **Trust boundary validation.** Every byte read from `GET /v1/peers/*` is adversarial input — the
  Worker is "an untrusted cache, not an authority" by its own header comment. The client passes each
  decoded blob straight to `rendezvousRecord.verify()`, which already implements the full
  version→structural→signature→freshness→monotonicity→decrypt-last order. The client itself adds no
  additional trust — it must not, for example, short-circuit on `peers.length === 0` vs `> 0` as a
  trust signal, since KV is only eventually consistent (Worker's own comment) and an empty response is
  not evidence of anything.
- **Scope/authority boundary.** No `authorize()` call applies here — this is unauthenticated public
  discovery data (namespace-gated only, per 2026-09-18's namespace-as-capability design), not a
  camp-authenticated IPC/WS path. Flag: this client never writes to SQLite, the Automerge document, or
  the op-log directly — its only effect is handing `{id, multiaddrs}` shapes to `onDiscoveredPeer`
  (mirroring `transport.js`'s `onPeerDiscovery` shape exactly, per the recon note that this is the
  existing integration point), so no `PROJECTIONS`/camp-isolation boundary is crossed by this file at
  all.

### 3. Address key and namespace re-derivation

Every publish tick, the client MUST:
1. Call `readRendezvousNamespace(doc(), campId)` and `readRendezvousAddressKey(doc(), campId)` fresh
   — `doc()` is a live accessor (e.g. `getDocIfLoaded`/`liveDoc`'s current getter), never a value
   captured once at client construction time and reused. This is what makes a concurrent mint
   (`mintRendezvousNamespace`/`mintRendezvousAddressKey`, both documented as racy across concurrent
   devices — see their own file comments) self-heal: the LOSING device's next tick reads the
   SURVIVING value from the merged document, rather than continuing to sign against a namespace/key
   pair that lost the Automerge merge.
2. If either read returns `null` (rendezvous not yet enabled for this camp — no prior
   mint/publish has happened), the client is a no-op for that tick: skip the publish, log nothing
   sensitive (matching the Worker's own no-PII-logging posture), and retry next tick. This is not an
   error — it is the expected steady state for every camp until whatever UI/flow (out of scope for
   T288 — wiring the ENABLE action is a separate ticket) calls `mintRendezvousNamespace`/
   `mintRendezvousAddressKey` for the first time.
3. On the READ (discover) side, a fetched peer record whose `addressBodyError` comes back (wrong/no
   key, or the address key hasn't synced to this device yet) is treated as **not-yet-resolvable**, per
   `rendezvousRecord.verify()`'s own documented contract (`ok` stays true if signature/freshness/
   monotonicity all pass; only `addressBodyDecrypted` is false) — the peer is authentically who it
   claims, its addresses just aren't usable yet. The client should keep the peer in a
   "known but unreachable" state and re-attempt decryption on a later document change (the address key
   syncing in), not blacklist or discard the peer id.

### 4. Rate-limit finding-1 — Host + Worker

**Scope check first: Slice C is discovery-only.** No join-proof is exchanged over WAN in this slice —
`joinSession.js`'s WAN path is Slice E+/unbuilt. So this section is bounded to what's actually
reachable in T288: an attacker who has (or brute-forces/guesses within the namespace's 256-bit space,
i.e. effectively "has") a camp's rendezvous namespace can call `POST /v1/register` and
`GET /v1/peers/<namespace>` directly against the Worker — no Host/libp2p connection is involved at
all for discovery itself. **Finding-1 as scoped in the brief (identity churn defeating `authGate.js`'s
per-peer/per-device throttle) is about the LAN/WAN authenticate path (`authGate.js`), which is not
reachable via WAN until join-over-WAN ships (Slice E+).** Given that, this addendum draws the line as
follows:

- **Actionable now, in T288:** nothing in `authGate.js` needs to change for Slice C, because Slice C
  adds no new caller of it — discovery never opens a libp2p connection to an unauthenticated peer on
  its own; it only learns candidate multiaddrs and hands them to the existing mDNS-parallel discovery
  path, which still goes through the SAME `authGate`/`authorize()` flow every LAN peer already does.
  **Confidence: high.** This is a direct reading of the recon note ("join-proof over WAN is NOT wired
  yet") plus `authGate.js`'s actual call sites (`onAuthenticate`/`onPairingRequest`/`onLogin`, none of
  which discovery invokes).
- **Design for WHEN it becomes reachable (Slice E+), recorded now so Maker doesn't silently decide it
  later:** the correct rate-limit key is `connection.remoteAddr` (verified against installed
  `@libp2p/interface@3.3.0` — `Connection.remoteAddr: Multiaddr`, `Connection.remotePeer: PeerId`, see
  §6), NOT `fromPeerId` (`connection.remotePeer.toString()`) and NOT attacker-supplied `msg.device_id`.
  Both of the latter are free for an attacker to mint fresh per attempt (a new Ed25519 keypair costs
  nothing, and `device_id` is client-asserted with no proof of prior registration) — that IS the
  identity-churn bypass the recon note names, and it applies as much to `fromPeerId` as to
  `device_id`, which the current `authGate.js` code does not yet account for (it treats `fromPeerId` as
  a costlier-to-rotate signal than `device_id`, but under this project's threat model once a connection
  is reachable over the internet rather than only LAN, it isn't). `remoteAddr` is a `Multiaddr`; extract
  the host via `.nodeAddress().address` (works for `/ip4/.../tcp/...` and `/ip6/.../tcp/...` forms) and
  key the throttle map on that string instead of/in addition to `fromPeerId`.
  **Known limitation to record, not solve here:** LAN peers behind the same router/NAT and WAN peers
  behind a shared CGNAT legitimately share one public IP, so an IP-keyed limiter can rate-limit
  unrelated devices together (a false-positive-adjacent cost, not a security hole) — this is a
  known, accepted tradeoff pattern (the Worker's own `MAX_PEERS_PER_NAMESPACE` doc comment accepts an
  analogous one), not a defect to fix in this addendum. **Confidence: medium** on the exact
  `nodeAddress()` extraction API remaining stable across the `@libp2p/interface` line — flagged for
  Maker to re-verify against the resolved version at implementation time (`org-source-verification`),
  since Multiaddr's helper surface has changed across major versions historically.
- **Worker-edge, what's code vs. deploy-time config:** `workers/rendezvous/worker.js`'s own header
  comment is explicit and current — "it does NOT rate-limit by IP or otherwise throttle callers. The
  owner must configure Cloudflare-side rate limiting and/or a WAF rule." That remains correct after
  this review; nothing in Slice C changes it. **Owner decision, explicitly flagged, not decided here:**
  whether to configure Cloudflare's rate limiting for `/v1/register` before or concurrently with Slice
  C shipping. This addendum recommends doing so promptly since Slice C's own client makes the register
  endpoint reachable in practice for the first time (today it's live code with zero callers), but the
  actual Cloudflare dashboard/WAF configuration is outside any ticket's code diff and is the owner's to
  perform. Should any code-level per-source bound be added to `worker.js` itself now (e.g. a
  `CF-Connecting-IP`-keyed counter in KV, as a belt-and-suspenders layer under the WAF)? **Not
  recommended for T288's scope** — it would add a second write per register call, KV is not built for
  fast counters (eventual consistency across edge PoPs, per the Worker's own comment on `GET`), and the
  existing fixed-size/fixed-cap validation already bounds per-request work; a proper rate limiter
  belongs in Cloudflare's purpose-built Rate Limiting product, not hand-rolled in KV. Flagged as an
  explicit **owner decision** if the owner wants defense-in-depth beyond the WAF regardless.

### 5. Signoff flag co-location

The `discovery` capability's `signoff` entry in `transportCapabilities.js` (the block in §1 with
`date: '2026-09-28'`) lands in the **same PR** as the rendezvous client and the egress-allowlist entry
that authorizes it — never split across two PRs, and never landed before the client code it authorizes
exists (an armed-but-unused signoff is as wrong as an unarmed one, per §1.2's positive-expectation
assertion). This PR requires mandatory **Security** and **Red Hat** review before merge, per the
existing project convention for Tier-4 boundary changes. `relay`, `dcutr`, `webrtc`, `websockets`,
`webtransport`, `quic`, `kadDht`, `bootstrap`, `upnp` all keep `signoff: null` — untouched by this PR.

### 6. Red-first seam plan

Non-vacuity discipline (memory: "plant the defect the guard cannot see" — a test that only agrees with
already-clean code proves nothing):

1. **Per-capability gate, relay-still-blocked.** Fixture test: temporarily add
   `@libp2p/circuit-relay-v2` to a copy of `package-lock.json`'s `packages` map (in-memory, not the
   real file) and assert `1.1`'s assertion logic (extracted as a pure function taking the parsed
   lockfile + registry) returns a non-empty `present` array. Must go red even though `discovery.signoff`
   is set — proves flipping discovery does not widen the relay check.
2. **Per-capability gate, transitive package.** Same fixture technique, but the forbidden package
   appears only as a nested `node_modules/some-wrapper/node_modules/@libp2p/circuit-relay-v2` path —
   must still be caught (proves the lockfile-walk, not direct-deps-only).
3. **Discovery egress allowlist, importer-inheritance exploit.** Plant a fixture file
   `electron/sync/__fixtures__/relayBridge.fixture.js` containing a `fetch(...)` call, imported (in the
   fixture only) by a copy of the discovery client's source. Assert the egress scan still flags
   `relayBridge.fixture.js` by its own basename — proves scope is file-identity-based, not
   import-graph-based.
4. **Wire-shape round-trip against a worker stub.** An in-process fake implementing exactly
   `handleRegister`/`handlePeers` from `worker.js` (or literally importing `workers/rendezvous/worker.js`
   against an in-memory KV mock, preferred — reuses the real handler instead of re-describing it) —
   publish via the client, discover via the client, assert the decoded, verified record matches what
   was published. Must fail loudly (not silently pass) if the client's body shape drifts from
   `{namespace, peerId, record}`.
5. **Address-key re-derivation self-heal.** Two simulated concurrent `mintRendezvousAddressKey` calls
   on forked docs, merged via `A.merge`; assert the client's next-tick read (via the same `doc()`
   accessor pattern) picks up whichever key survived the merge, not a stale closed-over value — this
   is the test that would have failed had the client hoisted the key into a constructor param instead
   of re-reading per tick.
6. **Decrypt-failure = not-resolvable, not rejected.** A record signed with address key A, verified
   with address key B (or no key) — assert `ok: true`, `addressBodyDecrypted: false`,
   `record.addressBodyError` set, and assert the client's discover-side handling keeps the peer as
   "known, unresolved" rather than dropping it.
7. **Rate-limit key resists identity churn (Slice E+ prep, can land now as a unit test on the key
   function alone, ungated by Slice E).** A pure function `rateLimitKeyFor(connection)` extracted from
   the §4 design, unit-tested: two connections with different `remotePeer` values but the same
   `remoteAddr` host produce the same key. This can be written and merged in T288 as pure, dead
   (unwired) code with no capability implication, exactly like `rendezvousRecord.js` was merged unwired
   — or deferred whole to the Slice E ticket. **Architect recommendation: defer whole to Slice E** —
   writing dead rate-limit code now, ungated by any capability flag, doesn't reduce Slice E's risk and
   adds a file nobody re-reviews before it's wired. Flagging as an open question for Governor rather
   than deciding unilaterally, since it's a sequencing call, not a technical one.
8. **LAN-only parity when discovery is disabled.** With `discovery.signoff` forced to `null` in a test
   double of the registry, assert `syncStarter.js`'s actual startup path (already covered by existing
   `mainSyncStartupWiring.test.js`-style AST/behavior assertions) is byte-identical to today's — this
   is a regression guard that Slice C adds zero behavior when the capability is off, satisfying the
   "additive, not replacing" framing implicit in the per-capability model.

### 7. What could not be verified here

- The exact stable API for extracting a bare IP string from a `Multiaddr` (`.nodeAddress()` vs
  `.toOptions()` vs manual tuple parsing) was confirmed to exist in `@libp2p/interface@3.3.0`'s
  `Connection.remoteAddr: Multiaddr` type, but the `Multiaddr` class itself ships from a different
  package (`@multiformats/multiaddr`, a transitive dependency, not directly resolved by name in this
  pass) — Maker must re-verify the exact helper method against ITS resolved version before implementing
  §4's rate-limit key, per `org-source-verification`. Flagged, not assumed.
- Whether `findInternetEgress`'s proposed dynamic-`import()` pattern in §1.3 produces false positives
  against this codebase's existing legitimate dynamic imports (e.g. `syncStarter.js`'s own
  `await import('./syncNode.js')`, which is a same-repo relative import, not egress, but IS a
  non-literal-adjacent `import(` call depending on how the regex is scoped) — this needs to be run
  against the real tree before being asserted as a red-first test, not just designed on paper. Flagged
  as a Maker verification step, not resolved here.
- Cloudflare's current dashboard-level rate-limiting configuration state for the deployed
  `workers/rendezvous` route was not checked (no access to the Cloudflare account from this pass) — the
  §4 recommendation to configure it "promptly" is based on the Worker source's own comment, not on
  confirming today's actual deployed configuration.

### Open questions for Governor (not decided in this addendum)

1. Whether seam 7 (rate-limit-key-resists-churn unit test) lands in the T288 PR as dead/unwired code,
   or is deferred whole to the Slice E ticket — a sequencing call, not a technical one (see §6 item 7).
2. Owner decision, flagged not decided (§4): Cloudflare-side rate limiting / WAF configuration timing
   for `/v1/register`, and whether a code-level KV-based per-source counter is wanted in `worker.js` as
   defense-in-depth beyond the WAF (not recommended by this addendum, but the owner's call).
3. The exact export name/shape `rendezvousClient.js` uses to hand discovered peers to `syncStarter.js`
   (`createRendezvousDiscovery({campId, baseUrl})` returning something with the same shape as
   `createMdnsDiscovery`, by analogy) is a naming/interface-shape choice narrow enough that Maker can
   decide it during implementation rather than needing it pinned here — flagged so Governor can
   confirm that's an acceptable amount of latitude to leave Maker, given this ADR is meant to leave
   Maker no *architectural* judgment calls, and this one is not architectural (it's file-local naming).

## Amendment 2026-10-09 — revocation rotates the rendezvous secrets (elected, digest-keyed)

Source: F1 of `docs/work/security/2026-10-09-wan-ladder-assessment.md`; round-2 Governor design on PR #841.

- **Problem.** A revoked device keeps its copy of the camp document, including
  `camps.rendezvousDiscovery` (namespace + epoch) and `camps.rendezvousAddressKey`. Before this
  amendment neither changed on revocation, so a departed device could keep polling the namespace and
  decrypting every record's address body.
- **One atomic tuple.** All the secrets live in ONE scalar field, `camps.rendezvousSecrets` =
  `v2:<epoch>:<namespace hex>:<address key hex>:<revocation digest | ->`. Automerge resolves a
  concurrent write per key, so it keeps one whole tuple, and the namespace and key can never come from
  different rotations. Red Hat reproduced exactly that mix with separate fields. Every read (namespace,
  key, rotated-for digest) comes from the tuple. A camp minted before the tuple is read from its legacy
  `rendezvousDiscovery` / `rendezvousAddressKey` fields until its next mint or rotation, which writes
  only the tuple. The legacy fields are never written again, and no schema migration is needed.
- **Mechanism** (`electron/sync/automerge/rendezvousRotation.js`). The tuple's digest is the
  signature-verified revocation digest the T335 rotating mDNS tag uses. When a device's verified digest
  differs from it, and the device is the **elected rotator**, it rotates the whole tuple (epoch + 1,
  fresh namespace and key, current digest) and broadcasts. The elected rotator is the lowest device id
  among currently granted admins; every device computes the same answer, so there is no N-way churn.
  A camp that never minted a namespace is skipped.
- **When the check runs.** After every projection in `syncNode.js` (remote merge and `applyLocal`),
  on doc load (`prepareDocForSync` in `syncStarter.js`), and from `revokeDevice` after `revokePeer`
  has evicted the target. This covers:
  - a quorum completed only by a merge;
  - concurrent revokes, where the merged digest differs from both sides and so is re-rotated;
  - a revocation that landed while the doc was not loaded.
- **Conflicts.** The one tuple field is excluded from director-facing conflicts (`reconcile.js`), so
  no raw secret reaches ConflictsScreen. Automerge's winner is the answer.
- **Distribution.** The new values travel only through ordinary document sync. Sync already refuses
  revoked peers, and `stepSync` now returns early for a revoked peer, so no send path hands them the
  new state.
- **Failures.** A failed rotation is logged and recorded as a `rendezvous_rotation_failed`
  device-health event.
- **STUN.** Superseded by the owner's 2026-10-09 ruling. The punch transport refuses any
  `iceServers` entry, and `rtcConfigFrom` hardcodes `iceServers: []`. No STUN or TURN server is ever
  contacted.
- **Residual limits.** Recorded in `SECURITY.md` under Known limitations.
