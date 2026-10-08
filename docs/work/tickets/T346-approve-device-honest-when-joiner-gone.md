---
ticket: T346
document_type: ticket
title: approveDevice reports failure when the joining device is gone, and leaves no half-authorized row
status: open
created: 2026-10-08
archive_when: "approveDevice returns { authorized: false, reason: 'joiner_disconnected' } and leaves the devices row unauthorized (no secret, no admin grant, no allow audit) whenever pairing-decision delivery returns false or no libp2p node exists, and DeviceManagerScreen renders the inline flag 'The device disconnected before approval — ask it to request again' on that request; both pinned by red-first tests"
task_class: security-auth
parent: ""
governing_docs: [docs/governance/standards/DESIGN_STANDARD.md, docs/governance/standards/TESTING_STANDARD.md, SECURITY.md]
related_prs: []
related_tickets: []
---

# T346 — approveDevice is honest when the joiner is gone

## Context

`approveDevice` in `electron/main.js` writes `pairing_status='authorized'` plus a fresh
`device_secret_identifier`, records an `allow` audit event, optionally mints a fleet-wide admin
grant, then calls `getAutomergeNode()?.sendPairingApproved(...)` and discards its result. That call
resolves `false` (from `deliverPairingDecision` in `electron/sync/automerge/authGate.js`) when no
pairing peer is pending (the joiner disconnected; T340 clears pending state on disconnect) or the
dial fails. The handler still returns `{ authorized: true }`: the director sees success, the joiner
never received its secret, and the row is authorized with a secret nobody holds.

## Decision

Persist first, deliver, and **revert on non-delivery**. The row must exist before the frame is sent,
because the joiner may reconnect the instant it receives approval. If delivery fails, the row is
restored to its pre-approval values, so no half-authorized device exists. The admin-grant mint and
the `allow` audit happen only after delivery succeeds, since the mint replicates fleet-wide and
cannot be cleanly undone.

## Remaining

- Implement and test per the Governor brief (handler seam + rendered-text seam), Red Hat on the
  pairing path.
