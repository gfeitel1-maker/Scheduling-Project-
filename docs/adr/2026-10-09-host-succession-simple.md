---
title: "Host succession (simple): another admin becomes the host by re-minting the host key"
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
  - SECURITY.md
supersedes: []
amends: []
related_adrs:
  - docs/adr/2026-10-02-distributed-revocation-authority.md
  - docs/adr/2026-09-14-device-identity-and-token-binding.md
  - docs/adr/2026-10-09-setup-device-gates-lifted-to-any-admin-device.md
related_tickets: []
affects:
  - electron/automerge/authorityLog.js
  - electron/automerge/authorityReplay.js
  - electron/auth/localAuth.js
  - electron/main.js
  - electron/db/schema.sql
---

# ADR: Host succession (simple)

## Owner rulings (2026-10-09, relayed verbatim by the keeper)

> "if the founding computer or original host s removed, someone else becomes the host and then holds the keys"

- A 2-device camp where one device leaves must work.
- Threat model is **honest failures only** (lost laptop, sync lag, a director leaving): "this is just so not worth the time ... a hostile take over of a camp ... i have never, ever, heard of that happening".
- Fallback for any edge case: "export the last file, start a new camp, and reupload it".
- T331 grant/vote semantics are **unchanged**. This ADR amends nothing.

**Out of scope (owner ruling): malicious admins.** No design effort goes to a hostile admin backdating grants, racing claims, or seizing a camp. The fuller defence in the parked background ADR (`origin/claude/adr-host-succession`, `docs/adr/2026-10-09-host-succession-by-remint.md`, which amends T331 with an effective-grant fixed point) is background only and is not adopted.

## Context

The host is whichever device holds the unreplicated `host_signing_key` row. That one key signs camp/device session tokens, `users` credential tuples and purge tombstones; every device verifies against the local `camps.signing_public_key`. Admin authority is already distributed (T331 `camp_authority_log`). If the only key holder is removed or lost, nobody can sign tokens, credentials or tombstones, and the camp code and Add-a-device are founder-only.

## Candidates (closed by owner ruling; recorded for the record)

Re-mint (chosen) works when the old host is dead. Key transfer fails for a lost host and leaves a live copy on a removed one. Shamir shards, host-less admin signing and automatic election were dropped as heavier or as giving unchosen devices power. Full reasoning is in the background ADR.

## Decision

1. **Two authority-log kinds**, neither changing admin membership. `host_release` (signed by the current host, names a successor admin) and `host_claim` (signed by the claimant with its device identity key; carries the new `host_public_key` and `parent_epoch_id`). Founder is epoch 0; its key is today's `camps.signing_public_key`. Devices adopt the key of the winning chain by replaying the log.
2. **Live handoff.** Host signs `host_release`; the successor generates a new host signing key on its own device and publishes `host_claim`.
3. **Host removed (today's T331 quorum, unchanged) or lost.** A remaining admin (admin under today's rule at heads) claims. Requires director PIN re-auth through `attemptLogin`. The lost path adds a short claimant-local delay (default 5 minutes) plus a typed confirmation; the delay is friction, not a verifier rule.
4. **Concurrent claims**: deterministic tie-break, lowest change hash wins, so all devices converge. Honest simultaneous clicks are the only case designed for.
5. **Staff/client devices keep working (B1).** Today a device approved by the old host is trusted via host-local state. Replace with replicated signed `device_approval` records (device id, peer id, role, signed by the approving host key). Login for a non-admin device is by device identity key bound to the authority-log peer id; no host-held secret is needed, so the new host admits devices the old host approved without a local `devices` row.
6. **Peer trust is two-way.** `createBoundPeerTrust`, `peerAddressBook` and `mutualAuth` accept authority-recorded devices (admins from the log, others from `device_approval`), so sync works both directions with the new host.
7. **Late adoption.** On OK login the new host returns its `host_claim` chain plus the grants needed to verify it, so a device that missed the change adopts the new key. Nothing is disclosed to a denied peer.
8. **`isCurrentHost`** (derived from the log and the local key) replaces founding-device checks in `getJoinCode`, `setJoinWindow` and approve, so the current host shows the camp code and adds devices.

## Migration

Founder is epoch 0; a camp that never succeeds has no new entries. On the host's **first upgraded launch**, backfill a signed `device_approval` for every existing approved device. Down-migration drops nothing in the document; the new table/columns get a rollback per the usual `vNN_down` rule.

## Fallback

Any case this does not cover (no remaining admin, divergent chains, a missed handoff): export the last file, start a new camp, reupload it. This is the supported recovery, not a gap.

## Consequence

Adds two log kinds, one replicated record type and the key-adoption path. A removed host's copy of the old key is simply no longer the trusted key. Not designed to resist a malicious admin (see above).

## Slice plan (small, red-first PRs, in order)

Interface contract (`org-interface-contracts`) per slice: idempotent by entry/record id; unknown outcome is safe to retry; denied paths write nothing and audit.

- **S1 device_approval replication + identity-key login.** Red: staff device approved by old host logs in to a new host with no `devices` row; forged/unsigned approval rejected; replay of same approval is a no-op.
- **S2 peer-trust seams.** Red: authority-recorded device is accepted by `createBoundPeerTrust`/`peerAddressBook`/`mutualAuth`; sync is two-way between new host and an old-host-approved device; unrecorded peer still denied.
- **S3 host_release/host_claim + isCurrentHost + key re-mint.** Red: live handoff converges on all devices; concurrent claims pick lowest change hash identically in both merge orders; claim by non-admin ignored; old key tokens rejected after adoption.
- **S4 lost-host claim UI (PIN + delay).** Red: 2-device camp, host lost, T331 quorum revokes it, remaining admin claims, becomes host and adds a device; wrong PIN writes nothing and audits; delay and typed confirm enforced locally. DESIGN_STANDARD s5/s8 states and reduced-motion equivalents apply.
- **S5 login-reply chain adoption.** Red: a device offline during the claim adopts the new key on reconnect via the login reply; denied peer receives no chain.
- **S6 camp-code / Add-a-device on current host + guide.** Red: `getJoinCode`/`setJoinWindow`/approve succeed on the current host and fail on a non-host; founder after losing host status fails; guide and `SECURITY.md` updated.
