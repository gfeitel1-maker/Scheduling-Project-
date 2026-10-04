---
title: "T336 C4 — pre-authentication sizing review (rateLimit.js / authGate.js / wireProtocol.js)"
document_type: security
authority: evidence
status: active
task_class: security-auth
created: 2026-10-03
assessed_commit: 49b7ed9755a8df6df8f0e1078a2b33224b308736
governing_docs: [docs/work/security/2026-10-03-t337-relay-capability-assessment.md, docs/work/security/2026-10-03-t337-standing-reservation-signoff-battletest.md, docs/work/specs/2026-10-03-t336-holepunch-build-design.md, SECURITY.md]
archive_when: the dcutr capability's own signoff resolves or supersedes this review
---

# SECURITY REVIEW — T336 C4, pre-auth sizing for an internet-reachable node

Date: 2026-10-03. Carried forward from the T337 capability assessment's re-opened tradeoff and the
T337 standing-reservation battle-test's C4 ("pre-auth rate-limit sizing for internet scale"):
> "Re-confirm `rateLimit.js`/`authGate.js` pre-auth sizing for internet-scale attempts before the
> flag is ever set true." — `2026-10-03-t337-relay-capability-assessment.md`

## Why this review exists now

Once relay + dcutr are enabled (`SHORESH_RELAY_ENABLED=true`, both flags still default false/unset —
confirmed: `grep SHORESH_RELAY_ENABLED electron/sync/automerge/syncStarter.js` →
`process.env.SHORESH_RELAY_ENABLED === 'true'`, no other reference sets it), a camp device's libp2p
node binds `/ip4/0.0.0.0/tcp/0` (`syncStarter.js:436`) instead of loopback-only, and becomes reachable
by connection attempts from arbitrary internet hosts, not just LAN-local ones. Every limiter examined
below sits strictly BEFORE any authentication decision — this review asks whether each one is sized
for that threat model or is implicitly tuned for "a camp LAN of 2-20 devices."

## What was examined, with evidence (file:line)

### 1. Per-source-IP connection admission — `electron/sync/automerge/connectionRateLimiter.js`

- `MAX_NEW_CONNECTIONS_PER_WINDOW = 30` per `RATE_WINDOW_MS = 10_000` ms, `MAX_CONCURRENT_PER_SOURCE
  = 20` — `connectionRateLimiter.js:21-23`.
- Exempts loopback + all private/link-local ranges (`isPrivateOrLoopback`, `connectionRateLimiter.js:27-42`)
  — inert on the LAN, active only against a public source IP.
- Wired as `connectionGater.denyInboundConnection` in `transport.js:204-210`, which libp2p calls on
  the raw inbound multiaddr **before the Noise handshake runs** (confirmed by the module's own
  comment at `transport.js:79`: "This denies BEFORE the noise handshake... so it also bounds the
  handshake cost of a flood"). This is the single most important sizing property in this review: a
  denied source never pays the asymmetric-crypto cost of a handshake attempt.

**Adequacy: adequate for its stated scope.** 30 new connections / 10s and 20 concurrent per source IP
is generous for any real camp device (even an aggressive reconnect loop stays under it) while bounding
a *single-source* flood to a small, cheap-to-reject rate. The module's own doc comment is explicit
that this is a single-source backstop, not a global one — see the residual noted below.

### 2. Global connection ceiling — `electron/sync/automerge/transport.js:46`

- `MAX_CONNECTIONS = 200`, passed to `connectionManager.maxConnections` (`transport.js:201`).
- Sized, per its own comment, for "a camp LAN [of] a handful of devices... this ceiling is
  deliberately generous and only caps a [LAN] flood" — i.e. explicitly LAN-era sizing, predating this
  feature.

**Adequacy: a named residual, not fixed in this review (see "Residual" below).** The per-source-IP
cap (item 1) does not compose into a global defense against a *distributed* flood: an attacker
controlling many source IPs (trivial on the public internet, unlike a single source) can each stay
under the per-IP caps while collectively exhausting the 200-slot ceiling, since there is no
reservation or priority for already-admitted/previously-trusted peers over anonymous dialers. This is
a genuine availability/DoS exposure once the node is internet-reachable. It is explicitly flagged
forward rather than silently accepted — see "Residual, not fixed here."

### 3. Per-peer / per-device-id / per-source pairing and login throttles — `electron/sync/automerge/authGate.js`

- `PAIRING_MAX_ATTEMPTS_PER_SOURCE = 30` / `PAIRING_SOURCE_WINDOW_MS = 60_000` ms,
  `LOGIN_MAX_ATTEMPTS_PER_SOURCE = 60` / `LOGIN_SOURCE_WINDOW_MS = 60_000` ms — `authGate.js:50-53`.
- Plus per-peer and per-device-id min-interval throttles from `electron/sync/rateLimit.js`:
  `LOGIN_MIN_INTERVAL_MS = 300` (`rateLimit.js:35`), `PAIRING_RATE_MS = 5000` (`rateLimit.js:39`).
- All three keys (peer id, claimed device_id, source IP via `rateLimitKeyFor`, `authGate.js:94-105`)
  are combined with OR — throttled if ANY says "too soon" (`authGate.js:268-272`, `320-325`).
- Run AFTER the Noise handshake (these messages arrive on the already-upgraded `AUTH_PROTO` stream)
  but BEFORE any DB write / `attemptLogin` call.

**Adequacy: adequate, with concrete numbers.** The existing T288 analysis (`authGate.js:44-49`) already
sized these against the actual threat they bound — an online grind of the 50-bit join secret, which
needs millions of attempts to have realistic odds, while these caps allow at most 30-60 attempts per
source per minute. That arithmetic does not change at internet scale: a distributed grind across N
source IPs still needs a 50-bit-secret's worth of attempts in aggregate, and each individual source is
capped at the same small per-minute rate regardless of how many sources exist. The identity-churn
bypass (rotating peer id / device_id to evade the first two keys) is independently closed by the
third key (source IP, `rateLimitKeyFor`) — not forgeable without a genuinely different network source
(T288 round 3, `authGate.js:74-93`).

### 4. Frame-size cap on the pre-auth protocol — `electron/sync/automerge/wireProtocol.js` / `authGate.js`

- Before this review: `authGate.js`'s `receiveFramed(stream, handler)` call (no 3rd argument) used the
  **default** `maxDataLength = MAX_FRAME_BYTES = 32 * 1024 * 1024`, 32 MiB — a cap sized in
  `wireProtocol.js:47-54` explicitly for the document-sync protocol ("one frame is the entire camp
  document... generous headroom... for base64 map images, ~1 MB each").
- `authenticate`/`pairing_request`/`login`/`pairing_approved` frames are all small, fixed-shape JSON
  (tokens, device ids, PIN-derived material, role strings, a signed `join_confirm` blob) — none
  remotely close to document size.

**Adequacy: NOT adequate as found — implicitly LAN-scale, now fixed test-first in this review.**
Reusing the 32 MiB document cap on the UNAUTHENTICATED auth protocol meant an un-admitted peer could
force this node to buffer up to 32 MiB per concurrent connection before any admission decision ran at
all, amplified by however many connections the limiters above (item 1: up to 20 concurrent per
source IP; item 2: up to 200 globally) allow at once — a worst case in the hundreds of MB to several
GB of attacker-controlled pre-auth buffering. This is squarely the "frame-size/rate caps ahead of the
Noise/auth handshake" question the C4 carry-forward named, and it is a real gap, not a hypothetical
one: nothing about it depends on relay/dcutr specifically, only on the auth protocol being reachable
by an unauthenticated peer, which it always has been.

**Fix (test-first, in this change):**
- Added `AUTH_MAX_FRAME_BYTES = 64 * 1024` (`wireProtocol.js`) — generous headroom over any real auth
  payload (the largest, a signed `join_confirm`, is well under 1 KiB) while cutting the worst-case
  pre-auth memory amplification by roughly 500x relative to the document cap.
- Wired it as the 3rd argument to `receiveFramed` in `authGate.js`'s `AUTH_PROTO` handler, so the
  cap applies specifically to the pre-auth path; `transport.js`'s `PROTO`/`SYNC_PROTO` handlers
  (reached only by already-admitted peers) are untouched and keep `MAX_FRAME_BYTES`.
- Red-before-green evidence: `electron/sync/automerge/wireProtocol.test.js` ("exports a SEPARATE,
  much smaller frame cap for the pre-auth protocol") and `electron/sync/automerge/authGate.test.js`
  ("an oversized AUTH_PROTO frame is rejected before reaching onAuthenticate") were run against the
  pre-fix tree (`git stash` of the two production edits) and failed for the right reason — the second
  test specifically sends an otherwise-well-formed `authenticate` JSON frame padded past the new cap,
  so the failure is attributable to size, not to the pre-existing malformed-frame handling. Both pass
  on the fixed tree; full run: `npx vitest run --no-file-parallelism
  electron/sync/automerge/authGate.test.js electron/sync/automerge/wireProtocol.test.js` → 31/31
  passed. `npx eslint` on all four changed files: clean.

## Residual, not fixed here (named, not swept under the rug)

**Global connection-slot exhaustion by a distributed (many-source-IP) flood** (item 2 above) is a real
availability/DoS exposure once this node is internet-reachable, and it is NOT closed by any of the
rateLimit.js/authGate.js work in this review, because it lives one layer up — in `transport.js`'s
`MAX_CONNECTIONS` ceiling having no priority/reservation mechanism for already-admitted or
previously-trusted devices over anonymous dialers. Closing it properly (e.g. reserved slots for
known devices, or a priority eviction policy) is architecture work, not a sizing tweak, and is out of
scope for a sizing-confirmation chunk per this task's own instruction not to over-engineer. It is a
DoS/availability concern only — Noise encryption + `authenticatedPeers` admission still fully gate
data access, so the worst case is denial of service to legitimate camp devices, not a confidentiality
or integrity breach. **Recommendation: track as a follow-up ticket, to be resolved before
`SHORESH_RELAY_ENABLED=true` is ever set in a real build** — the same gate the C4 carry-forward itself
is scoped to.

## Verdict

- **Per-source-IP connection caps (connectionRateLimiter.js): adequate**, with concrete numbers above,
  and sized correctly to deny before the handshake's crypto cost is paid.
- **Per-peer/per-device/per-source pairing and login throttles (authGate.js, rateLimit.js): adequate**,
  with concrete numbers above, consistent with the existing T288 50-bit-secret-grind analysis.
- **Frame-size cap ahead of the Noise/auth handshake: was implicitly LAN-scale (reused the 32 MiB
  document cap), now fixed test-first** — `AUTH_MAX_FRAME_BYTES = 64 * 1024` wired into `authGate.js`.
- **Named residual (not a blocker for this chunk, not silently accepted):** the global
  `MAX_CONNECTIONS = 200` ceiling has no admission priority for trusted devices and remains exposed to
  a distributed-source slot-exhaustion flood once internet-reachable. Flagged forward.

This review does not itself authorize `SHORESH_RELAY_ENABLED=true`; that remains gated on the dcutr
capability's own signoff and T337's F-1 enablement-coupling guard, unchanged by this review.
