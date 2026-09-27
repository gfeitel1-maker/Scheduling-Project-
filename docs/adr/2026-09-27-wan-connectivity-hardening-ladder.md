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
implementation_state: proposed
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
   **`rendezvousClient.js` (T211) has never been written or wired** (confirmed above) — so there is no
   existing v1 wire-shape client to reconcile against, and the "Q5 client/worker mismatch" the security
   reassessment doc flags as an open item is resolved by construction: **T211 is built once, directly
   against the v2 shape**, POSTing `{recordBase64}` (matching `workers/rendezvous/worker.js`'s actual,
   already-shipped opaque-blob contract — not the `{namespace,peerId,record}` shape an earlier design
   note assumed) and reading `GET /v1/peers/<namespace>` → `{records: [{recordBase64}, ...]}` per the
   Worker's existing, unmodified handler. No dual-shape client, no format renegotiation, no "v1 client
   talking to v2 worker" case ever exists in the field, because nothing has shipped yet.
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
