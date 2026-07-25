# Device trust, pairing, and revocation

**Status:** proposed

## Context

Today any device that discovers the Host via mDNS and sends a correct PIN over
the unauthenticated `login` WebSocket message becomes permanently, universally
trusted: it receives a session token HMAC-signed with `camps.signing_secret`
(docs/superpowers/specs/2026-07-20-shared-camp-signing-secret-design.md), a
secret every device in the camp holds locally once synced. That ADR already
flagged this explicitly as an accepted-for-now tradeoff: *"a compromised
device can forge a session token... for any userId/deviceId pair... flagged
here for future hardening if the threat model ever changes."* This is that
hardening. Two compounding gaps: (1) `devices` rows are auto-created on first
WS authenticate with no approval step and no revocation state, so a departed
staff member's laptop stays trusted forever; (2) because token *minting* and
token *verification* use the same shared secret, any device — not just the
Host — can call `issueSessionToken(db, anyUserId, anyDeviceId)` in-process and
produce a token every other device accepts, regardless of PIN. A compromised
Client is a compromised camp.

## Decision

**Split device trust (pairing) from user trust (PIN login), and split token
verification from token minting.**

1. **Pairing gates PIN login.** A device must be explicitly approved by an
   admin on the Host before it can even attempt a PIN exchange. `devices`
   gains `authorized_at`, `authorized_by_user_id`, `revoked_at`,
   `revoked_by_user_id`, `revocation_reason`, and `device_secret_identifier` —
   a random secret the Host mints at approval time and hands to the Client
   once, over the same connection that made the pairing request. The `login`
   WS message now requires this secret as bearer proof; the Host rejects it
   outright — before touching the PIN or the lockout counter — if the device
   isn't `authorized_at NOT NULL AND revoked_at IS NULL`, or if the secret
   doesn't match. This closes the "any device on the LAN can attempt PIN
   guesses" exposure without requiring TLS.

2. **Camp session tokens move from shared-HMAC to Host-signed asymmetric.**
   The Host generates an Ed25519 keypair once (`bootstrapCamp`). The private
   key never leaves the Host device and is never synced. The public key
   replaces `camps.signing_secret` and distributes via the existing full-sync
   path, so every device can still verify a token fully offline — but only
   the Host can *mint* one. This is the one change in this decision that
   isn't reversible without a token-format migration, so it's made explicit
   here rather than left implicit in the schema diff.

3. **Offline login stays possible without extending network trust.** A
   Client that can't reach the Host can still unlock local work using a
   distinct local-only token type, HMAC-signed with that device's own
   `device_secret_identifier` (the same secret from pairing, reused rather
   than inventing a third key). It authorizes only IPC calls on that same
   process/device; `syncServer.js`'s WS `authenticate` handler rejects it
   outright, so it can never be replayed to gain network trust elsewhere.

4. **Revocation is enforced by re-derivation, not a revocation list.**
   `authorize()` already re-queries `users`/`devices` on every call instead of
   trusting the token payload (docs/adr/2026-07-24-centralized-authorization-layer.md)
   — its own comment names this exact extension point. Revoking a device sets
   `revoked_at`; the very next `authorize()` call (WS or IPC) on that device
   denies with `reason: 'device_revoked'`, without needing to track or check
   individual token IDs. Queued local writes on a revoked device are not
   auto-applied on reconnect — the Host rejects the connection before any op
   is accepted, so they sit locally until an admin re-authorizes the device.

## Considered options

- **Keep the shared HMAC secret, only add revocation checks.** Rejected: it
  closes "revoked device reconnects" but not "compromised device mints a
  token for a different user," which is the sharper half of the ask (§5.5).
  A shared symmetric secret makes mint-capability and verify-capability the
  same capability by construction; no amount of app-level "only call
  `issueSessionToken` from the Host code path" is a real boundary against a
  compromised process, which can just replicate the HMAC call itself.
- **Per-device asymmetric keypairs (every device has its own signing key,
  Host countersigns).** More PKI machinery than this app needs; the camp
  threat model is "trusted LAN, bounded blast radius per compromised
  device," not multi-party federation. Host-as-sole-signer is the smallest
  design that actually satisfies the requirement.

## Consequences

- Token verification stays fully offline (unchanged property); token
  *minting* now requires reaching the Host, or falls back to the
  device-scoped local-only token for local-only work. A Client permanently
  cut off from the Host can still work locally but its cached network token
  eventually expires and it cannot get a fresh network-trusted one until it
  reconnects — this is intentional, not a bug to fix later.
- `camps.signing_secret` (HMAC) is superseded by `camps.signing_public_key`
  (Ed25519). Existing tokens issued under the old scheme stop verifying after
  migration; this is acceptable per the earlier ADR's own note that this app
  has not shipped production camp data.
- Raw PIN and raw `device_secret_identifier` still travel unencrypted over
  the pairing/login WS exchange (no TLS). Accepted for the same reason the
  shared-secret ADR accepted raw PIN transmission: consistent with this
  project's existing "trusted camp LAN" threat model. Pairing narrows *who*
  can attempt that exchange at all (§6.3's "at minimum" bar); it does not
  encrypt it. Full TLS remains explicitly out of scope here.
