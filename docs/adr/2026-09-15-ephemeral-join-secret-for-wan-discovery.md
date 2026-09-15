---
title: "Ephemeral, rotating, KDF-hardened join secret for WAN (public-DHT) discovery"
document_type: adr
authority: normative
status: accepted
implementation_state: proposed
date: 2026-09-15
program: security-hardening
affects:
  - electron/sync/joinCode.js
  - electron/sync/automerge/joinSession.js
  - electron/main.js
  - electron/sync/automerge/discovery.js
  - docs/adr/2026-09-14-internet-transport-security-gate.md
  - docs/work/security/2026-09-15-wan-dht-boundary-assessment.md
---

# Ephemeral, rotating, KDF-hardened join secret for WAN discovery

**Status: ACCEPTED 2026-09-15** (owner: "go, 10 chars"). Code length fixed at 10 Crockford chars/50 bits. Implementation also builds the currently-missing Host window-scoped rendezvous advertising (the joiner searches a tag the Host does not advertise today). Test-first + independent review before it ships. WAN blocker #1 (`docs/work/security/2026-09-15-wan-dht-boundary-assessment.md`),
prerequisite to enabling public-DHT discovery. A protocol + UX change to the join flow, so it gets a
design pass before code. Records one UX decision for the owner.

## Context

Today (`electron/sync/joinCode.js`): the join code is `base32Crockford(sha256(campId)[:5])` — **40
bits, deterministic from the campId, permanent, never rotates**. The DHT/mDNS rendezvous key is
`joinDiscoveryTag = sha256(code)[:16]`. On the **LAN** this is defensible (mDNS broadcasts the tag
in clear anyway; the real anti-impostor control is the join *proof*, an HMAC over the code — see the
module's own long comment). The file even predicts this ADR: *"If that threat model ever changes,
the correct move is to make the code an ephemeral Host-minted secret."*

On a **public DHT** it breaks, in three compounding ways:
1. **Not secret.** The code is a pure function of the campId; anyone who learns the campId computes
   the code. It was never meant to be a secret.
2. **Offline-brute-forceable.** A joining device can only find the Host using what the director told
   it — the typed code — so the DHT lookup key is necessarily a function of the code. Publishing
   `sha256(code)[:16]` to a public DHT lets anyone grind `2^40` fast SHA-256 hashes (minutes) back
   to the code, then stand up an impostor Host and harvest the first joiner's PIN (the proof only
   proves code-knowledge, and the attacker now knows it).
3. **Permanent.** It never rotates, so any leak — a photo, a whiteboard, a departed staffer, one
   successful brute force — grants permanent discoverability and permanent reach to the pre-auth
   surface, forever.

Noise still encrypts everything in transit; this is not about wire confidentiality. It is about who
can *find* and *impersonate* a Host once discovery is public.

## Decision (proposed)

Replace the campId-derived permanent code with an **ephemeral, Host-minted, rotating secret**, and
harden the rendezvous derivation so a short typeable code survives offline brute force:

1. **Random, not derived.** When the director opens "Add a device", the Host mints a fresh random
   secret with `crypto.randomBytes` — never a function of the campId. It is a genuine secret.
2. **Ephemeral + window-scoped.** The secret lives only while the Add-a-device window is open
   (minutes), and the Host `provide`s its DHT rendezvous key ONLY during that window. Closing the
   window (or a timeout) discards the secret and stops advertising. A new window mints a new secret.
3. **KDF-hardened rendezvous tag.** Derive the DHT key via a **slow KDF (scrypt)** over the secret,
   not a bare SHA-256 — `tag = scrypt(secret, fixed_salt, …)`. This makes each offline guess cost
   ~100ms instead of ~0, so a modest typeable secret is no longer trivially reversible from the
   published tag. The joiner computes the tag once on join (~100ms — imperceptible); the Host once
   when opening the window.
4. **Rate-limited proof.** The join-proof attempt path is rate-limited per source so online guessing
   is bounded independently of the KDF (defense in depth; ties to WAN blocker #4).
5. **The person-facing flow is unchanged** (the module comment's promise): the director still reads
   a short grouped code off a screen; the joiner still types it. Only the derivation and lifecycle
   change.

### The one UX decision (owner): code length

A human-typed code trades length against entropy; the KDF widens the safe range but does not remove
the choice.

- **Recommended: 10 Crockford chars (50 bits) + scrypt tag.** Grouped `XXXXX-XXXXX`. With a
  ~100ms-per-guess KDF, `2^50` offline guesses is ~3.5 million CPU-hours — infeasible for a code
  that also rotates and is only live for minutes. Two extra characters over today, still easily read
  across a room and typed without losing your place.
- Alternatives: 8 chars/40 bits (today's length; relies more heavily on the KDF + rotation + window
  + rate-limit — thinner margin) or 13 chars/64 bits (belt-and-suspenders, but noticeably longer to
  type). I recommend 10 as the balance; the mechanism is identical at any length.

**Confidence: high** on the mechanism (ephemeral + rotating + window-scoped + KDF is the standard
answer and the file already anticipated it); **medium** on the exact length, which is a UX judgment
the owner may want to set — hence surfacing it.

## Consequences

- **Security:** knowing the campId no longer yields the code; a leaked code expires with its window;
  the published rendezvous key is no longer a cheap path back to the code; and discovery exists only
  while a director deliberately holds the window open. This closes WAN blocker #1.
- **UX / behavior change:** the code is no longer stable — it differs each time Add-a-device is
  opened. Any doc, test, or workflow assuming a fixed per-camp code must change. `joinCode.test.js`'s
  fixed vectors (which pin the *deterministic* derivation) will be replaced by property tests
  (random, rotating, KDF round-trips, proof still binds roles).
- **Cross-version:** this changes what goes on the wire (the tag derivation), so all devices must be
  on a version that agrees — acceptable pre-production, hard cutover (no field installs yet).
- **LAN today:** this is only *required* before public-DHT discovery ships. It can land ahead of the
  DHT (it strictly improves the LAN story too) behind the same Tier-4 gate.

## Verification (when implemented)

- Property tests: minted secrets are random/unique; the KDF tag round-trips and is stable for a
  given secret; the join proof still verifies and still separates the joiner/host roles; an expired
  or rotated secret no longer verifies.
- A test that the Host advertises the DHT/mDNS rendezvous key ONLY while the window is open.
- The offline-cost argument recorded as a comment with the chosen KDF parameters.
