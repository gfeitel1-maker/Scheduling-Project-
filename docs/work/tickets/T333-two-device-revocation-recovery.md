---
ticket: T333
document_type: ticket
title: Two-device-camp revocation recovery — Gate-A uncorroborated-marker consult + marker lifecycle (no readmission)
status: open
created: 2026-10-03
archive_when: "a strict two-device camp recovers from a blind admin-revoke under sync lag (the locked-out admin can reconnect and the state self-corrects) AND Security has re-confirmed, red-before-green, that the blind-revoke-then-genuine-quorum sequence cannot readmit a genuinely quorum-revoked device"
task_class: security-auth
parent: ""
related_prs: []
---

# T333 — Two-device-camp revocation recovery (fast-follow)

## Context

Fast-follow from T332 / the distributed-revocation ADR
(`docs/adr/2026-10-02-distributed-revocation-authority.md`). The owner ruled 2026-10-03 (Option 2)
to ship T332 with the two-device deadlock documented as an accepted v1 limitation (see the ADR's
"Known limitation (v1)" section and `SECURITY.md` Known limitations) rather than block the release on
a 4th iteration that re-touches the admission gate's readmission guarantee.

The limitation: in a strict two-device camp where the two devices are each other's only peer, a blind
revoke of an admin under sync lag (the revoking device has not synced that admin's grant) projects the
target as `'revoked'` in its own `authority_cache` and then denies — via Gate A — the only connection
over which the correcting grant could arrive. It never self-heals without a third device. Camps of 3+
devices self-heal automatically (the grant propagates via any third peer and the replay reclassifies
the target to `'admin'`, clearing the stale `devices.revoked_at`).

A recovery affordance was designed and implemented (ADR amendment 2026-10-03b, Maker round 4) then
**reverted** before merge: it cleared the legacy `devices.revoked_at` column, but the block is Gate A's
`authority_cache` read, which the recovery (correctly, to avoid readmission) did not touch — so the
affordance was inert, and shipping an "undo" button that does nothing would itself be the Art-V lie
the ADR chain exists to prevent.

## The fix (design to confirm, not yet settled)

The proper fix re-touches the admission gate and MUST preserve the no-readmission guarantee:

1. **Gate A consults an uncorroborated-revoke marker.** When `authority_cache` says `'revoked'` for a
   peer but that revocation is *uncorroborated* (made by this device under no authority knowledge of
   the target — i.e. no synced grant establishing the target's role at revoke time), Gate A should
   **allow the connection** so the correcting grant can sync and the replay can self-correct — rather
   than deny permanently.
2. **Marker lifecycle (the dangerous part).** The marker MUST be cleared the moment corroboration
   arrives: if the grant syncs and the target reclassifies to `'admin'`, clear it and self-heal; if a
   *genuine* quorum-revocation syncs (grant present + quorum votes), clear the marker so Gate A then
   legitimately denies. Without this lifecycle a **blind-revoke-then-genuine-quorum** sequence becomes
   a readmission hole: a device that blind-revoked an admin (marker set) and later learns that admin
   was legitimately quorum-revoked would keep admitting it on the stale marker.

## Acceptance

- Architect design pass settling the marker semantics + Gate-A consult + the lifecycle, as an
  amendment to `docs/adr/2026-10-02-distributed-revocation-authority.md`.
- Maker implements test-first; red-before-green for: (a) a strict 2-device camp recovers from a blind
  admin-revoke (the admin is not permanently locked out); (b) a genuinely quorum-revoked device is
  **never** readmitted, including the blind-revoke-then-genuine-quorum sequence.
- Full gate: **Security AND Red Hat must re-confirm the no-readmission sequence**; Verifier full
  suite; Grader.
- When done, update the ADR "Known limitation (v1)" section and `SECURITY.md` Known limitations to
  record the limitation as closed.
