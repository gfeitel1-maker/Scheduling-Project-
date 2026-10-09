---
title: "Host succession (simple): planned handoff of the existing host key to another admin device"
document_type: adr
authority: normative
status: proposed
implementation_state: not-started
date: 2026-10-09
decided: ""
deciders: [product-owner]
program: security-hardening
governing_docs:
  - docs/governance/constitution/CONSTITUTION.md
  - docs/governance/standards/ARCHITECTURE_STANDARD.md
  - docs/governance/standards/DESIGN_STANDARD.md
  - SECURITY.md
supersedes: []
amends: []
related_adrs:
  - docs/adr/2026-10-02-distributed-revocation-authority.md
  - docs/adr/2026-09-14-device-identity-and-token-binding.md
  - docs/adr/2026-10-09-setup-device-gates-lifted-to-any-admin-device.md
related_tickets: []
affects:
  - electron/auth/localAuth.js
  - electron/main.js
  - electron/sync/automerge/authGate.js
  - electron/db/schema.sql
  - src/hooks/useDeviceMode.js
  - docs/guide/DIRECTOR_GUIDE.md
---

# ADR: Host succession (simple)

## Owner rulings (2026-10-09, relayed by the keeper)

- Hosting must be movable to another admin device. A 2-device camp where one device leaves must work.
- Threat model: honest failures only (lost laptop, a director leaving). **Out of scope: malicious admins.** A turned-in laptop still holds a copy of the key; this is noted and accepted.
- **Unplanned loss of the host**, verbatim: "export the last file, start a new camp, and reupload it". Documented in the guide; no mechanism.

Background only (not adopted; they solve the unplanned case this ADR deliberately does not): `origin/claude/adr-host-succession` (re-mint with authority-log kinds) and `origin/claude/authority-model`.

## Decision

A **planned handoff**: the current host sends its existing `host_signing_key` to a connected admin device, sealed to that device, then both sides flip role. **No rotation**: `camps.signing_public_key` is unchanged, so every token, `users` credential tuple, purge tombstone and device approval stays valid and offline devices keep verifying.

### Where things live today (verified in code)

- The key is the singleton row `host_signing_key` (`electron/db/schema.sql`), created by `ensureHostSigningKey` (`electron/auth/localAuth.js`), never synced. Custody is the SQLite file itself (SQLCipher at rest when enabled), not `safeStorage`; the successor stores it the same way, so it inherits identical custody. "Is this device the Host" is **re-derived from the row's presence** (`getHostSigningKey`, `issueTokenForThisDevice`), not passed in.
- Device mode is `localStorage['shoresh-mode']` in the renderer (`src/hooks/useDeviceMode.js`), sent to main once per process by `chooseMode` (`electron/main.js`), which throws on a different mode in the same process ("mode already chosen"). Main's `mode` variable is process-lifetime.
- Host-service gates keyed on `mode`: `chooseMode` host branch (start-up of host services), `login` (`mode === 'client'` offline path), `getJoinCode` and `setJoinWindow` (`mode === 'client'` throws), and the status report (`mode === 'host'`). Key presence additionally drives token issuance and verification paths in `localAuth.js`, `authSignature.js`, `tombstoneSignature.js`, `authorityLogSignature.js`, `purgeCollateral.js`.
- Transport seam: authenticated libp2p streams under `/shoresh/auth/1.0.0` (`electron/sync/automerge/authGate.js`, Noise + admission set). The handoff is a new protocol `/shoresh/handoff/1.0.0` registered on the same node and reachable only by peers already admitted by `authGate` **and** recorded as admin. LAN only (peer must be directly connected on the LAN; the control is disabled otherwise).

### Sealing

Successor S sends an ephemeral X25519 public key signed by its device identity key (`electron/auth/deviceIdentity.js`); host H verifies the signature against S's known device identity, generates its own ephemeral X25519 key, derives a key by ECDH + HKDF, and encrypts the private key with AES-256-GCM. AAD binds `handoff_id`, `camp_id`, H's and S's device ids. Only S can decrypt; a recorded stream yields nothing later. S checks that the decrypted key's public half equals `camps.signing_public_key` before storing.

### Protocol and persisted state machine

One singleton table per device, `host_handoff` (never synced, same exclusion class as `host_signing_key`): `handoff_id`, `role` (`giver`|`taker`), `peer_device_id`, `state`, `updated_at`. Writes are single transactions. Message ids are `handoff_id`; every message is idempotent on it (re-send is a no-op or repeats the same reply).

| # | Message | Effect |
|---|---|---|
| 1 | H to S `OFFER{handoff_id}` | H state `offered` (still host). S shows one confirm. |
| 2 | S to H `ACCEPT{handoff_id, signed eph pub}` | S state `accepted`, no key yet. |
| 3 | H to S `KEY{sealed}` | H state `sent` (still host). |
| 4 | S to H `STORED{handoff_id}` | S, in one transaction, writes the key to a **pending** slot (`host_signing_key_pending`, not the live row) and sets `stored`. S is not a host yet. |
| 5 | H commit | **Decision point.** One H transaction: delete the live `host_signing_key` row, set `committed`. H is now a client. H sends `COMMIT{handoff_id}`. |
| 6 | S on `COMMIT` | One S transaction: move pending to live `host_signing_key`, set `done`. Renderer sets mode host and the app relaunches (mode is per process). H also relaunches into client mode. |
| 7 | S to H `DONE` | H clears its row. |

The safety property: **the live key exists on exactly one device at all times except never-two**. H deletes before S activates, so two live hosts is impossible. The window with zero live hosts is between step 5 and step 6.

### Failure rules (no banner; the result is shown on the control)

- Any failure, refusal, disconnect or timeout before step 5: H stays host untouched; S deletes any pending key and its handoff row; the "Hand hosting to <device>" control shows "Handoff did not complete. <device> was not changed; this computer is still the host." Retry is a fresh `handoff_id`.
- Restart recovery, by persisted state:
  - H `offered`/`sent` at start: clear row, stay host (nothing was decided).
  - S `accepted`/`stored` at start (crashed before COMMIT seen): S keeps the pending key and **asks H** `STATUS{handoff_id}` on next contact. H answers `committed` (S activates, step 6) or `unknown`/not committed (S discards pending). S never activates without H's `committed`.
  - H `committed` at start (crashed after deleting the key): H is a client; it re-sends `COMMIT` whenever S next connects (S `STATUS` also triggers it).
- **Bound, stated plainly:** between step 5 and S receiving `COMMIT` the camp has zero live hosts, and that lasts until H and S next reach each other. The pending key is not lost (it sits on S), so this is a delay, not data loss. If H never returns after committing, treat it as the unplanned case below. Two live hosts cannot occur.

### UI (DESIGN_STANDARD §5, §8)

On the current host, Devices screen: one action per eligible device row, "Hand hosting to <device>" (admin devices connected on the LAN only; hidden otherwise). Inline progress on that control (reduced motion: the same states as text, never no feedback), then a result line on the control. On the successor: one confirm, "<this computer> becomes the host for <camp>". After success the new host shows the camp code and can add devices; the old host shows as a client. No banners, no coming-soon controls.

## Contract check (`org-interface-contracts`)

Idempotent by `handoff_id`; unknown outcome resolved by `STATUS` before any activation; denied or malformed messages write nothing and are audited; error shape is `{ok:false, reason}`; the new handlers pass `authorize()` for `devices.approve`, and the peer must be an authenticated admin; the sealed payload and decrypted key are validated at the trust boundary (public half must match `camps.signing_public_key`).

## Unplanned loss

If the host is lost or broken without a handoff: export the last file, start a new camp, reupload it. Supported recovery, not a gap; no mechanism.

## Consequences

One new protocol, one new singleton table pair, one role flip needing a relaunch. No schema change to replicated data, no authority-log change, T331 untouched. A copy of the key on a returned laptop remains valid (accepted by the owner).

## Slice plan (small, red-first)

- **S1 sealed transfer + atomic flip + UI.** Red first: (a) two-device handoff succeeds: new host shows the camp code and adds a device; old device is a client and still syncs; PIN logins on all devices still verify against the unchanged public key; (b) interruption at each of steps 1-5 leaves H host and S with no key and no pending row; (c) restart recovery: S crashed after `stored`, H crashed after `committed`, S asks `STATUS`; never two live keys, zero-host window asserted bounded to non-contact; (d) tampered ciphertext, wrong-camp key, non-admin peer, replayed message all rejected.
- **S2 guide.** `docs/guide/DIRECTOR_GUIDE.md`: handoff steps plus the unplanned fallback sentence.

## Open items for the keeper

None blocking. Confidence medium-high; the zero-host window and the relaunch on flip are the two judgments a Red Hat pass should attack.
