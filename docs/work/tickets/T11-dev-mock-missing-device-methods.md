---
title: T11-dev-mock-missing-device-methods
document_type: ticket
status: completed
created: 2026-07-28
governing_docs: [docs/governance/standards/TESTING_STANDARD.md, docs/governance/standards/ARCHITECTURE_STANDARD.md]
related_adrs: [docs/adr/2026-07-25-device-trust-revocation.md]
archive_when: next archive sweep — resolved
---

> **RESOLVED** — the mock implements all 26 methods the renderer calls; the pinned
> gap in `test/governance.test.js` is now empty and the parity check enforces zero
> divergence. Implemented statefully (approve/deny/revoke move a device between
> states) rather than as stubs, so the Device Manager flow can actually be
> evaluated in `npm run dev`. Sample devices are labelled "(sample)".

# T11 — Device Manager cannot work under `npm run dev`

**Status:** CONFIRMED by surface comparison, 2026-07-28.

## What

`src/localClient.js` calls 26 `window.shoresh` methods. `src/localClient.mock.js` implements 16.
The ten missing are all device-trust related:

`approveDevice` · `denyDevice` · `getDevicePairingStatus` · `listDevices` ·
`listPendingPairingRequests` · `onPairingApproved` · `onPairingDenied` · `onPairingRequest` ·
`onTokenRenewed` · `revokeDevice`

## Why it matters

`localhost:5200` is the environment Tester drives and the one a director-facing UX review runs in.
Device Manager — pairing approval, revocation, the pending-request list — is unreachable there.
Per `TESTING_STANDARD.md` §2 those flows already require `electron:dev` for any completion claim,
so this is not a correctness hole in the product. It is a hole in what the cheap environment can
show, and it silently narrows what a UX review can cover.

This is the same class of defect as the write-blind mock recorded in `PLATFORM_STATE.md` Known
Issues, caught earlier this time because the surface is now asserted.

## Guard in place

`test/governance.test.js` → "dev mock fidelity" pins the gap at exactly these ten. Any *new*
divergence fails the build. Closing this ticket means implementing them and emptying
`KNOWN_UNIMPLEMENTED`.

## Not in scope here

Whether the mock should emulate pairing *semantics* (approval state machine, revocation effects) or
only satisfy the surface. Decide when implementing — surface-only would let the screen render
without proving anything about its behaviour, which may be worse than absence.
