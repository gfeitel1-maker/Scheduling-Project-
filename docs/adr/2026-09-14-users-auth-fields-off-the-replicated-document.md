---
title: "Take users' auth fields (role, pin_hash, pin_salt) off the replicated document"
document_type: adr
authority: normative
status: proposed
date: 2026-09-14
supersedes: []
implementation_state: proposed
program: security-hardening
affects:
  - electron/ops/projections.js
  - electron/automerge/campDocument.js
  - electron/automerge/projector.js
  - electron/auth/localAuth.js
  - electron/auth/authorize.js
  - electron/main.js
  - SECURITY.md
  - docs/work/evidence/2026-09-08-crdt-removes-host-side-authorization.md
---

# Take users' auth fields (role, pin_hash, pin_salt) off the replicated document

**Status: PROPOSED.** This ADR records a decision for the product owner. Nothing is implemented.
It exists because the fix has a real, non-obvious cost (offline login for changed/new credentials)
that the owner — not an agent — should weigh.

## Context

The Q1 assessment (`docs/work/security/2026-09-14-Q1-crdt-merge-blast-radius-assessment.md`,
verified independently) confirmed a **HIGH** finding (CRITICAL if the transport ever becomes
internet-reachable):

> A compromised but legitimately-paired **staff** device can emit a merged Automerge op that sets
> `users/<self>/role = 'admin'` or overwrites the **real admin's** `pin_hash`/`pin_salt` — camp-wide,
> on every peer, with **no authorization on the receive path**. A staff IPC caller categorically
> cannot do this (staff holds only `users.read`; all `users` writes are admin-only).

Root cause: `users` — including `pin_hash`, `pin_salt`, `role` — is a replicated document entity
(`electron/ops/projections.js:112`, `EXTRA_MODELED_ENTITIES` in `campDocument.js`), and the merge→
projection path (`syncNode.js` → `projector.js` `applyProjection`) runs **no `authorize()`, no role
check, no author check**. This is the accepted "role enforcement is device-side under CRDT sync"
tradeoff — but that tradeoff was framed as *data* role-separation, and its real blast radius includes
**admin credential overwrite and admin forgery**, which was never explicitly accepted.

### The tension that makes this a decision, not a mechanical fix

`pin_hash`/`pin_salt` replicate **on purpose**. `localAuth.js:75-81` records why: "a device that
cannot reach anyone still has to be able to log its staff in." If those fields stop replicating, a
device that has **never synced a given user** (a brand-new staff member, or a user whose PIN just
changed) cannot authenticate that user until it next reaches the Host. That is a genuine regression
of the offline-first promise for the *credential-change / new-user* case — and it is exactly the
cost that must be traded against the security gain. (A device that has already synced keeps its
last-known projection, so steady-state offline login is unaffected; only *changed/new* credentials
are affected.)

## Decision (proposed)

**Take `role`, `pin_hash`, and `pin_salt` out of the shared Automerge document. Route writes to
those three fields through a Host-side IPC path gated by `authorize()`** (the existing central
permission check), replicating them to a device only after the Host has authorized the change —
not as free-form CRDT ops any peer can author. `users.name` and non-auth fields may continue to
replicate as ordinary document fields. (Evidence-doc "Option 3", scoped to the auth fields.)

## Options considered

1. **Option 3 — de-replicate the three auth fields (recommended).** Removes the entire escalation +
   credential-overwrite class: a merge op can no longer touch `role`/`pin_hash`/`pin_salt` at all.
   *Cost:* those fields sync by a different mechanism than the rest of the row; and the offline
   regression above (new/changed credentials need a Host round-trip before an un-synced device can
   use them). Smallest blast-radius reduction per unit of complexity.
2. **Option 2 — authorize `users` auth-field writes at the merge boundary.** Keep them replicating,
   but reject an incoming `users` role/pin change whose Automerge actor id is not an admin device.
   *Preserves* offline login for changed/new credentials (they still replicate), but reintroduces a
   partial central decision on the merge path (per-change authorship + a partial-doc-acceptance
   rule + a trusted mapping from actor id → device → role). More machinery, and it puts an
   authorization decision back on the sync path the CRDT design deliberately removed.
3. **Do neither now; re-accept explicitly.** Update `SECURITY.md` to state the credential-overwrite
   + admin-forgery consequence in plain terms and defer the fix to the Tier-4 gate. Lowest effort;
   leaves a HIGH finding live.

**Recommendation: Option 1 (Option 3 in the evidence doc), confidence medium-high.** It is the only
option that *removes* rather than *guards* the dangerous capability, and the auth fields are the
right scope — they are rarely changed, admin-driven, and already conceptually Host-authoritative
(the Host mints tokens; it is reasonable for the Host to be authoritative for credentials too). The
deciding question the owner must answer is the **offline cost**: is it acceptable that a device
which has not synced since a PIN/role change cannot use the new credential until it reaches the
Host? If that offline case must be preserved, Option 2 is the fallback despite its extra machinery.

Confidence is medium-high rather than high precisely because that offline tradeoff is a product
judgment about how camps actually operate (do new staff get added while a device is off-network?),
which is the owner's call.

## Consequences

- **Security:** the confirmed Q1 escalation + admin-credential-takeover path is closed for the auth
  fields; a compromised staff-paired device can no longer promote itself or overwrite the admin PIN.
- **Offline:** a device that has not synced a user's *changed or new* credentials cannot log that
  user in until it reaches the Host. Steady-state offline login (already-synced users) is unchanged.
- **Migration:** existing documents carry `pin_hash`/`pin_salt`/`role` in the replicated doc; the
  change needs a migration path that stops projecting them from the doc and seeds the Host-authoritative
  store from current values, without a flag day that logs everyone out. This is design work, not
  covered here.
- **Tier-4:** this finding is a **hard blocker** on signing off the internet-transport gate
  (`docs/adr/2026-09-14-internet-transport-security-gate.md`). If this ADR is not implemented, that
  gate's re-assessment must resolve it before internet transport ships.

## Verification (when implemented)

- A test proving a merged `users` op that sets `role`/`pin_hash`/`pin_salt` from a non-admin actor
  is **not** projected (the counterpart to the current `syncNodeAuthGate.test.js`).
- The offline steady-state login path (already-synced user) still works with the auth fields sourced
  from the Host-authoritative store.
- `SECURITY.md` "Role enforcement is device-side under CRDT sync" updated to reflect the narrowed
  surface (auth fields no longer replicate; data-role separation unchanged).
