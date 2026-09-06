---
title: "ADR: Membership and identity mapping for Automerge/libp2p sync (Stage 5d)"
document_type: adr
status: proposed
authority: normative
implementation_state: not_started
date: 2026-09-06
decided: null
deciders: [product-owner]
task_class: database-sync
governing_docs: [docs/governance/constitution/CONSTITUTION.md, docs/governance/standards/ARCHITECTURE_STANDARD.md]
related_specs:
  - docs/work/plans/2026-09-06-stage5-live-wiring-design.md
related_tickets: []
related_adrs:
  - docs/adr/2026-09-06-productionize-automerge-libp2p-sync.md
  - docs/adr/2026-07-25-device-trust-revocation.md
  - docs/adr/2026-08-16-device-fk-seeding-and-delivery-watermark.md
  - docs/adr/2026-08-17-sync-auth-layer-deepening.md
supersedes: []
affects: []
program: shoresh-future-architecture
---

# ADR: Membership and identity mapping for Automerge/libp2p sync (Stage 5d)

> **Status: PROPOSED.** This is Stage 5d's own sub-ADR, called for explicitly by
> `docs/work/plans/2026-09-06-stage5-live-wiring-design.md` §4 and by the parent ADR's Stage 5
> description ("Membership/identity redesign ... scoped as its own design pass ... because it is
> security-consequential and not obviously reversible"). It requires product-owner acceptance before
> Stage 5d implementation starts. Nothing in this document is implemented.

Every claim is tagged **PROVEN** (verified against this branch's code, with `file:line`) or
**PROPOSED** (this document's recommendation).

## Context

`docs/adr/2026-09-06-productionize-automerge-libp2p-sync.md` already decided, and this ADR does not
re-open: Host stays a privileged signing role (not a symmetric/leaderless model); Stage 6 is a hard
cutover, not a dual-write window; LAN-first, WAN later (Stage 7). It explicitly left "the mechanism
for designating which peer is Host" and the PeerId↔identity mapping as Stage 5's own design pass.

Stage 4 (already merged) built a libp2p transport (`electron/sync/automerge/transport.js`) and a
doc-sync protocol (`electron/sync/automerge/wireProtocol.js`) that are, by the transport module's own
header comment, **symmetric and camp-membership-blind**: "no Host/Client distinction, no
camp-membership check ... Stage 5 maps privileged roles onto peer ids; this module does not"
(`transport.js:10-14`). This ADR is that mapping.

The Stage 5 live-wiring design (§4) proposed a shape for this mapping and flagged it as needing its
own ADR rather than being decided inline. Reading the actual auth code surfaced one place where §4's
proposed shape does not match how the app's auth flow actually works — corrected below (see
"Divergence from §4").

## Divergence from §4 (found while designing this ADR)

§4 describes "pairing (device joining a camp for the first time)" as a single token-based step that
"sends the same `login`-shaped message ... through attemptLogin." Reading `syncServer.js` shows this
conflates two structurally distinct steps that the existing WS protocol keeps separate:

1. **`pairing_request`/`pairing_approved`/`pairing_denied`** (`syncServer.js:731-772`, `:895-909`) —
   unauthenticated, no PIN, no `attemptLogin` call. A never-seen device sends `{device_id,
   device_name}`; the Host creates a `devices` row with `pairing_status='pending'`
   (`syncServer.js:762-763`) and fires `onPairingRequest` for a **human** (the director, in the UI)
   to approve or deny out-of-band. Only on human approval does the Host mint and hand the device a
   `device_secret_identifier` (`sendPairingApproved`, `syncServer.js:902`). No `users` row, PIN, or
   token is involved at this step at all — trust is established between the Host and a *device*, not
   a user.
2. **`login`** (`handleLogin`, `syncServer.js:175-227`) — requires the device to **already** be
   `authorized_at NOT NULL AND revoked_at IS NULL` (`deviceTrustStatus`, checked at
   `syncServer.js:183-186`, *before* any PIN check), requires the device to present the
   `device_secret_identifier` it received in step 1 (constant-time-compared,
   `syncServer.js:190-201`), and only then calls `attemptLogin(db, {name, pin, deviceId})`
   (`syncServer.js:213`, same function as local IPC login).

So "pairing" (device trust bootstrap, human-gated, no PIN) and "login" (PIN-authenticated session,
requires an already-paired device) are two different messages with two different trust bases. §4's
"the pairing flow reuses `attemptLogin` verbatim" is correct only for step 2; step 1 has no
`attemptLogin`-shaped equivalent to reuse — it needs its own auth-over-libp2p message pair. This ADR
designs both.

## Decision

### 1. Auth-over-libp2p framing: a second protocol id, not a branch inside doc-sync

**PROPOSED.** A new libp2p protocol string, `/shoresh/auth/1.0.0`, registered via a second
`node.handle(...)` call alongside the existing `PROTO` (`/shoresh/automerge/1.0.0`,
`wireProtocol.js:13`). Reuses `wireProtocol.js`'s existing `sendFramed`/`receiveFramed` length-prefixed
framing verbatim (already transport-agnostic — it takes a stream's raw `.sink`/`.source`, and
`wireProtocol.js`'s own header comment says it "never imports Automerge: it moves opaque Uint8Array
payloads" — auth JSON messages are exactly the shape this framing was already generic enough for). One
frame carries one JSON message, mirroring the existing WS message shape (`{type, ...}`) so the
message *bodies* below are structurally identical to `syncServer.js`'s WS messages — only the framing
differs (length-prefixed bytes over a libp2p stream vs. `ws.send`/`JSON.parse` over a WebSocket).

**Why a second protocol id, not a message-type branch inside the doc-sync protocol:** the doc-sync
protocol's only security property today is "a peer that never dials this exact string is never
handed doc bytes" (`wireProtocol.js:7-9`) — i.e., the protocol string itself is the only gate that
exists pre-Stage-5d. Folding auth traffic into the same stream would mean the first bytes on a
doc-sync connection determine whether it's an auth message or a doc frame, which (a) makes the
"doc-sync is reachable pre-auth" problem (§3 below) harder to fix, not easier, because now doc-sync's
handler has to parse-and-branch before it can even decide whether to require auth, and (b) means a
protocol used only for two purposes (auth handshake, then either accepted or torn down) intermingles
with a protocol used for arbitrarily many years of ongoing doc-sync traffic on the same wire. Two
protocol ids keep the two concerns's lifecycles separate: an auth-protocol stream is opened, does its
handshake, and closes (or hands off session state keyed by PeerId); a doc-sync-protocol stream is
long-lived and only opens after that handoff has happened. This mirrors, at the libp2p layer, the
same separation the WS layer already has between `authenticate`/`login` messages (which gate what
happens next on the same connection) and `submit_op`/doc-sync traffic on the *same* WS connection —
the difference here is that libp2p, unlike a single WS connection, gives us two independently
dialable protocol ids for free, which is the cleaner primitive for this case since libp2p connections
are natively multi-stream (a single peer connection can carry many protocol streams; a WS connection
cannot).

**Message types (mirror the WS vocabulary exactly, so behavior can't drift):**

- `pairing_request` → `{type: 'pairing_request', device_id, device_name}` (unauthenticated)
- `pairing_approved` → `{type: 'pairing_approved', device_secret_identifier}`
- `pairing_denied` → `{type: 'pairing_denied'}`
- `login` → `{type: 'login', device_id, device_secret_identifier, name, pin}` (requires prior pairing)
- `login_ok` → `{type: 'login_ok', token, userId, role}`
- `login_failed` → `{type: 'login_failed', locked?, retryAfterMs?}`
- `authenticate` → `{type: 'authenticate', token, device_id}` (an already-paired, already-logged-in
  device reconnecting with a live token — see "reconnect flow" below)
- `renew_token` → `{type: 'renew_token', token}` / `token_renewed` / `token_renewal_failed` (same
  contract as `syncServer.js:810-833`)

**Order — first pairing (fresh device, never seen by this Host):**
1. Client dials `/shoresh/auth/1.0.0` on the Host peer. (Requires the Host's PeerId to already be
   known to the Client — see "how a Client finds the Host" below; this is unchanged from today's
   mDNS-discovery-then-dial sequencing, just at the libp2p layer instead of WS.)
2. Client sends `pairing_request`. Host runs the **identical** logic block
   `syncServer.js:731-772` (rate-limit by device_id, `MAX_PENDING_PAIRING` cap, idempotent
   re-delivery for an already-authorized device, `INSERT OR IGNORE` the `devices` row,
   `onPairingRequest` callback to the director's UI) — reused as a shared function, not
   reimplemented, per §2 below.
3. Director approves/denies in the UI (unchanged, transport-independent — the callback doesn't know
   or care which transport asked).
4. Host sends `pairing_approved` (with the secret) or `pairing_denied` down the **same** auth-protocol
   stream if still open, or — since a libp2p stream can legitimately close between steps 2 and 3 while
   a human decides — via a **new** auth-protocol stream the Host dials back to the Client's PeerId
   once approved (mirrors `sendPairingApproved`'s existing `pendingPairingConnections` map keyed by
   `device_id`, `syncServer.js:899-905`, generalized to key by PeerId instead of a WS handle — see
   §4's PeerId mapping).
5. Client sends `login` (device_id, secret, name, pin) on a fresh auth-protocol stream (or the same one
   if still open). Host runs `handleLogin`'s exact logic (§2) → `login_ok`/`login_failed`.
6. Client now holds a `camp` or `local` token exactly as it would over WS, and reconnects for ongoing
   sync (step below).

**Order — reconnect (already-paired device, has a live token):**
1. Client dials `/shoresh/auth/1.0.0`, sends `authenticate` with its stored token + device_id.
2. Host runs the identical `handleAuthenticate` logic (§2): `verifySessionToken`, device_id match,
   **reject `local`-type tokens outright** (decision below), re-check `deviceTrustStatus`,
   self-register the `devices` row if somehow missing.
3. On success, the Host records the PeerId↔device mapping (§4) and the Client is now permitted to
   dial `/shoresh/automerge/1.0.0` for doc-sync — this is the gate that closes the "doc bytes reach
   `A.merge` pre-auth" hole (§3).
4. On failure, the Host closes the auth-protocol stream with a reason (mirrors the WS 4401/4402/4403
   close-code convention, `syncServer.js:41-46` region) and does **not** admit the PeerId to the
   doc-sync allowlist.

**How a Client finds the Host's PeerId at all (a gap this ADR flags, does not resolve):** today's
mDNS discovery (`electron/sync/automerge/discovery.js`, Stage 4d) advertises/discovers libp2p peers
generically — nothing in Stage 4 marks *which* discovered peer is "the Host of my camp" versus some
other Shoresh device on the same LAN running a different camp, or a stranger's node entirely. §4's own
open item ("the mechanism for designating which peer is Host still gets its own design pass") is
**not** fully closed by this ADR either — this document assumes the Client already has a target
PeerId (e.g. from a QR/manual pairing code exchanged out-of-band, matching how `device_secret_identifier`
pairing already requires some out-of-band channel today) and designs what happens *after* a
connection to that PeerId exists. **Open question for Governor**, listed again at the end.

### 2. `attemptLogin` reuse: verbatim for the `login` step; a NEW shared function for the `pairing_request` step

**PROVEN mechanically possible for `attemptLogin` itself:** `attemptLogin(db, {name, pin, deviceId})`
(`localAuth.js:289-349`) has no transport dependency in its signature or body — it reads/writes
`login_attempts`, `camps`, `users`, calls `verifyPin`, `recordAuditEvent`, and
`issueTokenForThisDevice` (which re-derives camp-vs-local from `host_signing_key`'s presence on
**this** device, `localAuth.js:193-196` — never from a parameter, so it can't be told the wrong
answer by a caller). None of that touches `ws` or any WS-specific state. It is safe to call from a
libp2p message handler with the exact same three fields extracted from the `login` message body.
This is a real third path through one function, not a fork, matching the module's own stated
intent (`localAuth.js:283-288`).

**What is NOT verbatim-reusable, and needs a shared extraction:** `handleLogin`
(`syncServer.js:175-227`) is the function that actually wraps `attemptLogin` with the device-secret
check, the per-connection throttle, and the trust-status precondition — and it currently takes a raw
`ws` object for `send(ws, ...)` and `ws.lastLoginAttemptAt` (`syncServer.js:210-211`). **Recommendation:
extract the transport-independent body of `handleLogin` (secret verification, throttle-key lookup,
`attemptLogin` call, result shaping) into a new pure function**, e.g.
`processLoginAttempt(db, {device_id, device_secret_identifier, name, pin}, { now, lastAttemptAt })` →
returns `{ ok: true, token, userId, role } | { ok: false, locked?, retryAfterMs? } | { ok: false,
throttled: true }`, that both `handleLogin` (WS) and the new libp2p auth handler call, each supplying
its own send-mechanism and its own per-connection throttle state. Same extraction applies to the
`pairing_request` handling block (`syncServer.js:731-772`): pull the rate-limit/cap/upsert/callback
logic into `processPairingRequest(db, { device_id, device_name }, { now, pendingConnections,
lastPairingRequestTime, onPairingRequest })`, called by both the WS handler and the new libp2p one.

**Why this matters for "cannot drift":** the whole point of `attemptLogin` already being factored out
(per its own header comment, `localAuth.js:283-288`) is that PIN/lockout/audit logic can't diverge
between transports. Leaving `handleLogin`'s *wrapper* logic (secret check order, throttle) duplicated
across a WS handler and a new libp2p handler would silently reintroduce exactly the drift risk
`attemptLogin`'s extraction was meant to prevent, one layer up. **This is new work Stage 5d must do
that §4 did not name**: not just "call attemptLogin from a new path," but "extract `handleLogin`'s and
the pairing block's transport-independent cores so both transports share them," a small, mechanical,
low-risk refactor of `syncServer.js` (behavior-preserving — `syncServer.js`'s own WS handler becomes a
thin caller of the extracted function, verified by the existing `syncServer.js` test suite passing
unmodified).

### 3. `authorize()` stays the single boundary — and doc-sync must be gated behind it

**PROVEN gap, the sharpest finding in this ADR:** `transport.js:64`, `await node.handle(PROTO, ...)`,
registers the doc-sync protocol handler unconditionally at `startTransport()` — there is no
authentication check anywhere between a peer dialing `/shoresh/automerge/1.0.0` and its bytes reaching
`syncNode.js`'s `handleReceived` (`syncNode.js:26`), which does `A.load` → `A.merge` → `projectAll`
(`syncNode.js:29-58`) on **any** successfully-parsed Automerge binary from **any** peer that completed
a libp2p (noise-encrypted) connection. Noise's encryption is a cryptographic *channel* property, not a
*membership* one — it proves the two ends share a secure channel, not that either end is a trusted
Shoresh device. `transport.js`'s own header comment already says this plainly: "Every libp2p peer here
is symmetric: no Host/Client distinction, no camp-membership check." Today, nothing in Stage 4 closes
this; it is explicitly left as a Stage 5 item.

**Decision (PROPOSED): gate the doc-sync protocol handler itself, per-PeerId, using the auth
handshake in §1 as the admission check — not a second call into `authorize()` for every doc frame.**
Concretely:
- `startTransport`/`startSyncNode` maintains an in-memory `Set<peerIdString>` of **currently
  authenticated peers** (populated on a successful `authenticate`/`login` over `/shoresh/auth/1.0.0`,
  removed on disconnect).
- The doc-sync protocol handler (`transport.js:64`) is changed to check `connection.remotePeer` against
  that set **before** calling `onDocReceived` — a peer that dials doc-sync without having completed
  the auth handshake on this same libp2p connection gets the stream closed immediately, never reaches
  `A.load`.
- This is intentionally a coarse **connection-admission** gate, not a re-derivation of role/permissions
  per doc-change — CRDT merges do not carry a per-field "who is allowed to write this" concept the way
  op-log writes do (there is no `authorize({action: 'schedule.write'})`-equivalent check possible at
  the level of "should this byte range of a merged doc be accepted"). **`authorize()` itself is not
  bypassed or duplicated by this** — it continues to be the single re-derived-per-call boundary for
  every *IPC* action (`main.js` handlers), completely unchanged by this ADR. What Stage 5d adds is a
  **connection-level admission gate one layer below** `authorize()`, analogous to how the WS server's
  `authenticate`/`login` gate (`syncServer.js:777-791`) decides whether a connection may reach
  `submit_op` at all, before `authorize()`-style per-action checks would even apply — Stage 5's own
  live-wiring design doc already establishes that write-path authorization checks happen inside
  `appendOp`/IPC handlers, not inside the sync transport, and this ADR does not change that: a
  doc-sync frame that reaches `projectAll` still goes through the exact same `applyProjection` +
  rules-layer invariant checks (Stage 2) as an op-log-sourced write would, which is the actual
  content-level guard — the PeerId gate above only prevents a wholly unauthenticated stranger from
  reaching that far at all, it is not a substitute for it.
- **No second authorization code path is introduced.** The libp2p auth handshake (§1/§2) terminates
  in exactly the same `verifySessionToken`/`attemptLogin`/`deviceTrustStatus` calls the WS path already
  makes; `authorize()` (`authorize.js:19`) is untouched, still called only from IPC handlers, still
  re-deriving role/trust fresh from `{db, token, action}` on every call, regardless of which transport
  most recently authenticated the connection.

### 4. `devices.libp2p_peer_id` schema change

**PROPOSED.** Schema v57 (next after `CURRENT_SCHEMA_VERSION = 56`, `electron/db/localDb.js:17`).
Migration follows this file's established guard convention exactly
(`getSchemaVersion(db) >= 56 && getSchemaVersion(db) < 57`, mirroring `localDb.js:2207`'s v56 block,
not a bare `< 57` check) and the "both-places DDL" precedent the v56 comment documents
(`localDb.js:2196-2199`): the column is added to both the migration block and `schema.sql`'s
`CREATE TABLE devices` (`schema.sql:58-83`) so a fresh install and a migrated db produce identical
`PRAGMA table_info(devices)`.

```sql
ALTER TABLE devices ADD COLUMN libp2p_peer_id TEXT;
CREATE UNIQUE INDEX IF NOT EXISTS idx_devices_libp2p_peer_id
  ON devices(libp2p_peer_id) WHERE libp2p_peer_id IS NOT NULL;
```

- **Nullable, unenforced at creation:** a `devices` row exists (from `pairing_request` or
  self-registration) before any libp2p connection ever completes for it, exactly as it exists today
  before any WS connection completes for it.
- **Unique when present:** a partial unique index (SQLite supports `WHERE` on `CREATE UNIQUE INDEX`)
  so two rows can both be `NULL` (not yet seen over libp2p) but no two devices can claim the same
  PeerId — prevents a confused-deputy scenario where a second device row accidentally gets mapped to a
  PeerId already claimed by another trusted device.
- **Set once, at the moment a peer successfully completes `authenticate` or `login` over
  `/shoresh/auth/1.0.0`** (§1/§3) — `UPDATE devices SET libp2p_peer_id = ? WHERE id = ?`, run
  immediately after the auth check passes, mirroring how `device_secret_identifier` is set once at
  pairing approval (`syncServer.js:902`, via the Host's `sendPairingApproved` path) rather than
  inferred.
- **Explicitly NOT a trust signal, stated as a hard rule for future code touching this column:** a row
  having a `libp2p_peer_id` means "the last time this device authenticated over libp2p, it was this
  PeerId" — a **routing convenience** (lets the Host recognize a reconnecting known device's PeerId
  fast, e.g. to skip straight to expecting `authenticate` rather than `pairing_request`) exactly
  analogous to how a WS connection's remote IP is visible today but plays no role in
  `deviceTrustStatus`/`authorize()`. **§3's admission gate is keyed by the in-memory
  currently-authenticated-peer set, populated by a successful auth handshake on the live connection —
  never by matching an incoming PeerId against the stored `libp2p_peer_id` column and skipping the
  handshake.** A PeerId is regenerable by anyone running libp2p (it is a locally-generated keypair,
  not something Shoresh issues or vouches for) — trusting a stored PeerId column as a login bypass
  would let anyone who learns a trusted device's old PeerId (e.g. from a discovery broadcast) spoof
  admission without ever presenting a token. This rule is the reason the column is a convenience
  field and not, itself, part of the authorization boundary — restated here because it is the one
  invariant a future edit to this code is most likely to accidentally violate for a "nice fast-path"
  reason.
- **Schema-version tripwire fan-out (must be updated in the same commit as the bump, per this repo's
  own convention):** nine existing test files hard-code `expect(CURRENT_SCHEMA_VERSION).toBe(56)` and
  must be bumped to `57` alongside the migration: `electron/db/events.migration.test.js:85`,
  `electron/db/anchorKindSplit.migration.test.js:92`,
  `electron/db/locationWordDecisions.migration.test.js:67`,
  `electron/db/dayOverrideTemplatesRemoval.migration.test.js:75`,
  `electron/db/anchorEventLocation.migration.test.js:101`,
  `electron/db/anchorRecurrence.migration.test.js:87`,
  `electron/db/electiveSetsBinding.migration.test.js:81`,
  `electron/db/recurrenceTruthStatus.migration.test.js:95`,
  `electron/db/retireOverlayStamp.migration.test.js:60`. A new
  `electron/db/libp2pPeerId.migration.test.js` (following the sibling files' own pattern — e.g.
  `locationWordDecisions.migration.test.js`'s shape: build a v56 db, run migration, assert v57 +
  column presence + nullability + fresh-install parity) is also expected, per this repo's existing
  one-migration-one-test-file convention.

## Threat model

1. **A peer presents a valid PeerId but no token (dials doc-sync directly).** **Closed by §3's
   admission gate** — the doc-sync protocol handler now checks `connection.remotePeer` against the
   authenticated-peer set before calling `onDocReceived` at all. Before this ADR: **open**
   (`transport.js:64`, confirmed).
2. **PeerId spoofing/reuse.** A PeerId is a self-generated keypair identity; nothing prevents a
   hostile actor from generating a PeerId that happens to collide with... nothing, in practice — PeerIds
   are derived from public keys and are not spoofable in the sense of "claim someone else's PeerId"
   without holding their private key (libp2p's noise handshake proves possession of the private key
   behind the claimed PeerId). What IS possible: an attacker who has **observed** a trusted device's
   PeerId (e.g. from an mDNS broadcast on the LAN, which is unencrypted metadata) cannot present it
   without the corresponding private key, so this does not grant them admission — the noise handshake
   would fail. The `libp2p_peer_id` column (§4) being explicitly non-trust-bearing (an attacker
   presenting a *different*, self-generated PeerId still has to pass the full `authenticate`/`login`
   handshake) is the design's actual defense here, not PeerId secrecy.
3. **A stolen `local` token presented over libp2p.** **Decision: `local` tokens are rejected over
   libp2p exactly as they are over WS.** `handleAuthenticate`'s existing WS rejection
   (`syncServer.js:61-64`, close code 4402, citing `docs/adr/2026-07-25-device-trust-revocation.md`
   §3: "a `local` token from THIS SAME device ... would otherwise verify successfully" as the
   specific risk being closed) applies with identical force over libp2p — a `local` token is HMAC'd to
   a device's own `device_secret_identifier` and was never meant to prove anything to a *different*
   device or over the network at all. The libp2p `authenticate` handler must carry the same `if
   (verified.type !== 'camp') { close }` check, byte-for-byte, not a libp2p-specific relaxation. There
   is no product reason to relax this over libp2p that doesn't apply equally to WS.
4. **A peer skips auth and sends doc bytes straight to the sync protocol.** Same as (1) — this is the
   sharpest, now-closed-by-design gap; see §3.
5. **Replay.** A captured `authenticate`/`login` frame replayed later: `verifySessionToken` already
   enforces `exp` (`localAuth.js:264`, 24h TTL) so a replayed token past expiry fails regardless of
   transport; within the TTL window, replaying a captured token grants exactly what the original
   holder had (this is a pre-existing property of the token design, not new to libp2p — the WS path
   has the identical exposure today, mitigated only by noise's transport encryption making capture
   harder in the first place, same as WS-over-TLS would). No new replay surface is introduced by moving
   auth to libp2p; noise's encrypted channel is at least as strong an interception barrier as the
   existing plaintext-`ws://` LAN transport (`CLAUDE.md`'s architecture summary: `ws://`, unencrypted)
   — **this is arguably a strict improvement over today's WS transport**, worth naming as a
   consequence, not a risk.
6. **Denial-of-service on the auth channel.** `pairing_request` already has `MAX_PENDING_PAIRING` (50,
   `syncServer.js:682`) and a per-device rate limit (`PAIRING_RATE_MS`, referenced at
   `syncServer.js:735-738`); `login` has a per-connection throttle (`LOGIN_MIN_INTERVAL_MS`,
   `syncServer.js:207-211`). **Decision: the extracted `processPairingRequest`/`processLoginAttempt`
   functions (§2) carry these same caps forward unconditionally** — a libp2p-sourced call passes
   through the identical rate-limit state (keyed by `device_id`, not by transport), so a flood over
   libp2p is bounded exactly as a flood over WS is today. Additionally, `transport.js`'s existing
   `MAX_CONNECTIONS` cap (200, `transport.js:36-60`) already bounds total connection count
   transport-wide, covering a raw connection-flood distinct from an authenticated-message flood.

## What Stage 5d explicitly does NOT do

- **No host failover.** Which peer is Host is unchanged from today: whichever device ran
  `bootstrapCamp` and holds `host_signing_key`. This ADR does not design what happens if that device
  is offline, lost, or replaced — that remains future work, out of scope for both this ADR and the
  parent ADR's Stage 5.
- **No multi-writer election or symmetric-authority model.** The parent ADR already decided Host
  stays privileged; this ADR implements that decision at the libp2p layer, it does not revisit it.
- **No WAN.** Everything above (mDNS-adjacent discovery, direct dial, the auth handshake) is scoped to
  the same LAN-reachable peers Stage 4 already assumes. Stage 7's DHT/NAT-traversal work is additive
  and out of scope here — nothing in this ADR assumes or precludes a WAN-reachable PeerId later
  presenting the same auth handshake over a relayed/hole-punched connection, but that is not designed
  or verified here.
- **Does not fully resolve "how does a Client know which PeerId is its camp's Host"** — flagged as an
  open question below, not silently assumed away.

## Test plan for the Stage 5d implementation slice

- **Unit: `processPairingRequest`/`processLoginAttempt` extraction is behavior-preserving.** The
  existing `syncServer.js` test suite (WS-path pairing and login tests) must pass **unmodified**
  after the extraction — if any existing WS-path test needs to change to keep passing, the extraction
  changed behavior and the refactor is wrong. This is the mechanical proof that §2's reuse claim holds.
- **Unit: libp2p `pairing_request`→`pairing_approved`/`denied`→`login`→`login_ok` sequence**, two
  in-process libp2p nodes (mirrors `syncNode.test.js`'s existing in-process pattern), asserting the
  resulting token verifies via the same `verifySessionToken` a WS-issued token would, and that a
  `devices` row with the right `pairing_status`/`device_secret_identifier`/`libp2p_peer_id` exists
  afterward.
- **Unit: `authenticate` reconnect flow** — a device with a stored `camp` token reconnects over
  libp2p, is admitted to the doc-sync protocol; the identical token, if type `local`, is rejected with
  the same reason WS gives (threat #3), and doc-sync admission is NOT granted.
- **Adversarial: unauthenticated doc-sync dial is rejected.** A libp2p node that dials
  `/shoresh/automerge/1.0.0` **without** having first completed the auth handshake on that connection
  must have the stream closed before any bytes reach `syncNode.js`'s `handleReceived` — assert via a
  spy/mock that `onDocReceived` is never invoked for such a connection. This is the test that proves
  threat #1/#4 are actually closed, not just designed-against.
- **Migration test** (`electron/db/libp2pPeerId.migration.test.js`): v56→v57 adds the nullable,
  uniquely-indexed column; fresh install via `schema.sql` produces identical `PRAGMA table_info`;
  `CURRENT_SCHEMA_VERSION` tripwire bump across the nine sibling files listed in §4.
- **Rate-limit parity:** a libp2p-sourced flood of `pairing_request`/`login` messages is bounded by
  the same caps a WS-sourced flood is (threat #6), asserted against the shared extracted functions'
  state, not reimplemented per-transport.

## Rollback story

Everything in this ADR is additive and gated behind the Stage 5 `SYNC_ENGINE` flag
(`electron/sync/automerge/syncEngineFlag.js`) plus, within the flag, behind whether the libp2p auth
handshake is wired into `main.js`'s startup at all:
- The `devices.libp2p_peer_id` column is additive-nullable — safe to leave in place unused if Stage
  5d is rolled back; no data migration or reversal needed (matches the parent live-wiring design's own
  rollback framing).
- The auth-over-libp2p protocol handler is registered only when `startSyncNode` is called, which only
  happens when the flag is on — turning the flag off removes the entire code path from execution,
  identically to how Stage 5b/5c's dual-write and push-event translation are removed by turning the
  flag off.
- `authorize()`, `attemptLogin`, `verifySessionToken`, and the WS path (`syncServer.js`) are unchanged
  by this ADR except for the `processPairingRequest`/`processLoginAttempt` extraction (§2), which is
  designed to be behavior-preserving and verified as such by the unmodified existing test suite — if
  that extraction is ever suspected of having changed WS-path behavior, the fix is to inline it back,
  not to carry a divergent libp2p-only auth wrapper forward.

## Consequences

- Camp membership continues to be proven exactly one way — a token minted or verified through
  `localAuth.js`'s existing functions — regardless of which of three transports (local IPC, WS, libp2p)
  carried the proof. This is the central property this ADR protects, and it is why nearly every
  decision above reduces to "reuse the existing function, add a caller."
  `authorize()` gains no new responsibility and no new code path.
- Stage 4's doc-sync protocol goes from **reachable by any peer that can open a libp2p connection** to
  **reachable only by peers that have completed the same auth handshake WS already requires** — closing
  a real, currently-open gap (§3, threat #1/#4) that existed in the merged Stage 4 code before this
  ADR, not a hypothetical one.
- A new persistent shape (`devices.libp2p_peer_id`) and a new wire contract (auth-over-libp2p) are
  introduced that other code (the still-undesigned "which peer is the Host" mechanism, Stage 6's
  cutover, any future device-management UI) will depend on — this is exactly the ADR-bar-tripping
  consequence the parent ADR and the Stage 5 design doc both anticipated, now made concrete.
- `syncServer.js` gains two small extracted pure functions (`processPairingRequest`,
  `processLoginAttempt`) shared by both the WS and libp2p paths — new internal structure, but strictly
  a refactor of existing logic into a transport-agnostic shape, not new authorization logic.
- The "which PeerId is my camp's Host" discovery gap (noted above) means this ADR alone does not make
  Stage 5d shippable end-to-end without a follow-up decision — flagged explicitly rather than
  papered over, per the open questions below.

## Open questions for the product owner

1. **How does a Client learn the Host's PeerId in the first place?** This ADR designs the handshake
   *after* a libp2p connection to a known target exists, but not how that target is identified —
   today's `discovery.js` (Stage 4d) discovers libp2p peers generically, with no camp-affiliation
   signal. Options include: (a) mDNS service-record metadata carries a camp identifier the Client
   filters on before ever dialing the auth protocol; (b) the same out-of-band pairing code/QR flow
   that already exists for `device_secret_identifier` also carries the Host's current PeerId; (c)
   dial every discovered peer's auth protocol and let `pairing_request`'s existing device-scoped
   rate-limit/dedup handle the noise. This is a product/UX decision (what does pairing *feel like* to
   a director on a second device) as much as a technical one, and should be settled — likely as part
   of the still-open "which mechanism designates the Host peer" item the parent ADR named — before
   Stage 5d's implementation slice starts, not discovered mid-implementation.
2. **Timing relative to Stage 5b/5c.** The Stage 5 live-wiring design's own open question 3 asked
   whether this sub-ADR should be authored in parallel with 5a-5c or only after hardware validation
   (5f). This ADR is now written; the remaining question is purely sequencing — should Stage 5d's
   *implementation* start before or after 5f's two-machine hardware validation of the non-auth doc-sync
   path lands? Recommend after, since §3's admission gate changes `transport.js`'s handler behavior
   and a hardware bug found post-gate is harder to attribute to "the gate" vs. "the underlying
   transport" than one found pre-gate — but this is a sequencing call for Governor/the owner, not a
   technical constraint this ADR imposes.
3. **Security review is mandatory before this slice merges** (per the live-wiring design's own Stage
   5d row: "`electron/auth/**` is the highest-sensitivity surface in this codebase"). This ADR's
   threat-model section is a design-time pass, not a substitute for that review.
