---
title: "Import, undo and pairing decisions are not tied to the setup device"
document_type: adr
authority: normative
status: accepted
implementation_state: partial
date: 2026-10-09
decided: 2026-10-09
deciders: [product-owner]
governing_docs: [docs/governance/constitution/CONSTITUTION.md, docs/governance/standards/ARCHITECTURE_STANDARD.md]
supersedes: []
amends:
  - docs/adr/2026-08-28-stage-aware-nav-landing.md (Decision 2(a): "staff on the Host device" scope for import is removed; the role rule stands)
implements: [docs/work/tickets/T351-lift-setup-device-gates-to-any-admin-device.md]
related_adrs: [docs/adr/2026-10-02-distributed-revocation-authority.md]
---

# Import, undo and pairing decisions are not tied to the setup device

## Decision of record (owner, 2026-10-09)

> "Staff too": staff holding `groups.import` may import, replace and undo on any trusted device.

> "Leave per-device": reconciliation, alias and split decisions stay device-local, with no replication.

## Decisions

1. **Supersedes Decision 2(a)'s device scope.** ADR 2026-08-28 limited import to "a non-admin staff member logged in on the Host device". T351 removed the `mode === 'client'` refusal, so the rule is now `requireAuthorized()` alone: the permission, a trusted device, not revoked, re-checked on every call. Staff keep `groups.import`; nothing narrows it to admin.
2. **Reconciliation/alias/split decisions stay per-device.** They live in device-local tables that are never replicated. A decision made on device B is not seen on device A. This is accepted, not a gap to close here.
3. **Deny is this-device-only, and says so.** `denyDevice` flips `pairing_status` in this device's `devices` table and tells the joiner. It mints no `camp_authority_log` entry: a revoke entry would permanently tombstone a device id that was never granted, which is the wrong meaning for "not now". The DeviceManager shows Approve/Deny on any admin device and, after a deny, states inline that it applied to this device only.
4. **Not lifted:** showing the camp code / "Add a device". A join hosted without the setup device's signing key cannot finish (`electron/sync/automerge/clientHostedJoin.test.js`). Needs a separate design decision.
