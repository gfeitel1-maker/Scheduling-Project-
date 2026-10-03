---
document_type: reference
authority: descriptive
status: active
date: 2026-10-02
program: security-hardening
related_tickets: []
related_adrs:
  - docs/adr/2026-10-02-distributed-revocation-authority.md
related_docs:
  - docs/work/security/2026-10-02-t329-slice2-camp-epoch-assessment.md
---

# Security assessment — T331 distributed revocation (post round-3 correction)

Assessed against commit 8a85a182 (branch claude/t331-distributed-revocation-build).
Scope: the four questions posed by the dispatch. Not a whole-surface re-audit.

## Boundary verdict

Trusted-LAN boundary: HOLDS. No new transport, no libp2p package, no
`transportCapabilities.js` row touched; all mechanism rides the existing
document-sync layer. The revocation enforcement property itself is now REAL.

## Q1 — Revocation real end-to-end in production: YES (property holds)

Trace confirmed in code:
- Mint: `electron/main.js:1396` `revokeDevice` -> `mintRevokeEntry`
  (`electron/automerge/authorityLog.js:50`) signs with the acting device's own
  `device_identity_key` and writes the entry through the generic `appendOp` path
  (syncs like any other modeled entity).
- Replay: `electron/automerge/projector.js:419` `upsertCampAuthorityLogEntity`
  verifies each entry's signature (authenticity, `verifyAuthorityEntry`) then runs
  the causal-ancestor/quorum replay (`authorityReplay.js:184` `stateAt`) and writes
  `authority_cache(device_id, status)` fully re-derived each pass.
- Gate A (handshake): `electron/auth/connectionAuth.js:168-178` reads
  `authority_cache`; `status === 'revoked'` returns `{ok:false, code:4404,
  reason:'device_revoked_by_authority'}` BEFORE the success return at line 183.
- Gate B (production sync message): `electron/sync/automerge/syncNode.js:461-469`,
  inside `handleSyncMessage`, before `A.receiveSyncMessage`.
- Gate C (live teardown): `syncNode.js:149-161` calls `transport.revokePeer` the
  moment the derived cache marks a connected peer revoked.

Both prior failure modes are closed:
- T329 test-only-path: Gate B is in the production `handleSyncMessage`;
  `handleReceived` is only mirrored, and ADR battle-test 6 asserts it is NOT the
  exercised path.
- Signature-replay CRITICAL: the entry's own record `id` is now bound into
  `SIGNED_FIELDS` and the signing context bumped to `shoresh-authority-sig-v2`
  (`authorityLogSignature.js:38,50`; mint sites sign `{id,...}`
  `authorityLog.js:35,52`). A captured (kind,target,signer) tuple no longer
  verifies under a fresh id; the replay is keyed by id, so a re-inserted id is an
  idempotent no-op, not a resurrection.

Ordinary-device immediate removal works even though the quorum loop only deletes
targets already in `grantedSet`: a never-granted target is simply absent from
`grantedSet`, and `projector.js:451-452` writes every target not in `grantedSet`
as `'revoked'` — so one admin's single `revoke` yields a `'revoked'` cache row and
Gate A/B refusal.

No remaining production path found where a revoked device's writes land: inbound
changes arrive only via sync messages (Gate B) over connections admitted by Gate A,
with Gate C tearing down a live one. The device-local `authority_cache`/
`applied_authority_log` are in the never-synced exclusion class
(`schema.sql:1870+`, v90) and carried forward by re-derivation on purge/rebuild
(`purgeCollateral.js:68-77`, `rebuildSupportCommand.js:63-67`).

## Q2 — Actually distributed: YES at the trust root, WITH a wiring residual

At the cryptographic/replay layer it is genuinely distributed: any device's
`device_identity_key` can sign; the founder is seeded as an ordinary granted admin
(`authorityReplay.js:190`) and is removable by a quorum of the other admins with NO
`host_signing_key` involvement — the exact T330 single-point-of-failure is gone.

Residual central dependency (production wiring, not trust root): `revokeDevice`
and `approveDevice` both throw when `mode === 'client'`
(`main.js:1297-1299`, `1367-1369`). `mintRevokeEntry`/`mintGrantEntry` have no other
production caller. So through the shipped UI, only the device running in `host`
mode can mint an authority entry. The ADR's own motivating scenario — the founder/
host is the device to be fired and another admin on a client device removes it — is
exercised by the battle tests by calling the mint path directly, but is NOT
reachable end-to-end through the IPC surface from a non-host admin device today.
The capability is present in the crypto and replay; the production trigger is still
host-gated.

## Q3 — Slice-1 cached-WAN-address carry-forward: CONFIRMED refused

Gate A's `authority_cache` check runs on the ADMITTING peer against the CONNECTING
device's resolved identity, independent of how that device discovered or dialed —
cached `peer_last_addresses` redial or fresh discovery alike
(`connectionAuth.js:159-178`). Additionally, `revokeDevice` calls
`forgetPeerAddress` (`main.js:1421`) so this device will not itself redial the
revoked peer. A revoked device reconnecting via a Slice-1 cached address is refused
at Gate A, and if it slips past admission, at Gate B.

## Q4 — Carry-forward to Slice 3 (DHT)

With revocation now real on the LAN/document layer, the Slice-3 gate must still
prove, specifically for WAN/DHT:
1. Gate A/B/C fire identically on a connection established via DHT
   (`findProviders`) or circuit-relay as on an mDNS/LAN one — the `authority_cache`
   check is transport-agnostic, so the gate must assert it is actually invoked on
   the relayed/DHT code path, not only the LAN path.
2. A revoked device cannot act as a DHT provider or relay to feed other peers a
   stale authority frontier that omits its own revocation (eventual-consistency
   over WAN must still converge to refusal; a partition cannot be weaponized into a
   durable readmission).
3. Revocation/vote entries propagate over DHT/relay so a device that was offline at
   the instant of firing learns of its revocation on reconnect through any WAN
   transport, not only direct LAN sync.

## Open questions (not findings)

- Is the `mode === 'client'` guard on `revokeDevice`/`approveDevice` an intended v1
  scope line (minting stays on the main computer) or a wiring gap that defeats the
  ADR's founder-removal scenario in production? The ADR text ("any admin signs",
  "founder removable by someone else") reads as if a non-host admin should be able
  to initiate; the code restricts initiation to host mode. Settling this needs an
  owner/Governor scope ruling, not more code reading. It does not break the
  revocation ENFORCEMENT property (Q1), only the reachability of the distributed
  INITIATION (Q2).

## Re-opened tradeoffs

- Offline-race residual: accepted by owner as bounded for v1 (ADR "Owner rulings").
  Conditions unchanged (small, in-person-vetted fleet; full auditability; symmetric
  mutual-destruction). Still holds. No action.
- Purge-tombstone `host_signing_key` single-host gap: explicitly a separate
  follow-up (`h-purge-survives-fired-founder`), not in T331 scope. Unchanged.

## Verdict

Revocation enforcement property: REAL — PASS. The round-3 corrections (signature
replay, N=2 convergence) are present and the two prior failure modes are closed; no
production path was found that lets a revoked device's writes land once a valid
revoke entry exists in the document.

One substantive residual: distributed INITIATION is host-mode-gated in the shipped
IPC wiring (Q2), so the headline "any admin, including a client device, fires the
founder" is not yet reachable end-to-end through the UI. This is a completeness gap
in distribution, not a hole in enforcement — flagged for an owner scope ruling.

## Summary Score (for Grader)

Security posture: 4 — the revocation property is genuinely real and the prior
CRITICAL/HIGH are closed; held back from 5 by the host-mode wiring residual that
leaves the founder-removal-by-a-client-admin scenario unreachable end-to-end.
