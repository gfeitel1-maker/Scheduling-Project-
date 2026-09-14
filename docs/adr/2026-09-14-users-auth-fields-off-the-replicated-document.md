---
title: "Take users' auth fields (role, pin_hash, pin_salt) off the replicated document"
document_type: adr
authority: normative
status: accepted
date: 2026-09-14
supersedes: []
implementation_state: in_progress
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

**Status: ACCEPTED 2026-09-14.** Mechanism refined to Host-signed credential fields (see Decision). Implemented in staged, test-first slices; enforcement flips only after backfill + independent review. The refinement resolves the offline-login cost that made the original de-replicate proposal a hard judgment call.

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

## Decision (ACCEPTED 2026-09-14 — refined mechanism)

Owner approved the direction ("go with your recommendation; make it secure"). On implementation
review a **strictly better mechanism than pure de-replication** was found, and is what will be
built:

**Host-signed credential fields.** The three auth fields keep replicating (so offline and
new-device login are NOT regressed), but each user's `role`/`pin_hash`/`pin_salt` are covered by an
Ed25519 signature produced by the **Host's existing signing key** (`host_signing_key` — the same key
that signs camp tokens; every device already holds the public half via `camps.signing_public_key`).
A new replicated field, `auth_sig`, carries that signature. On projection, a device **verifies
`auth_sig` before applying any of the three fields**; an unsigned or invalidly-signed credential
change is refused and the prior local values are kept. Because only the Host can produce a valid
signature, a compromised staff-paired device can no longer forge a role change or overwrite a PIN
hash — while legitimate, Host-signed credentials still replicate to every device including offline
ones.

This supersedes the original "de-replicate" proposal below (kept for the record) because it closes
the same attack **without** the offline-login regression that was the deciding cost. Only the Host
can sign, so credential *changes* still require the Host — but credential *replication* does not,
which is the property that preserves offline login.

### Staged implementation plan (test-first; enforcement flips only after backfill)

1. **Primitives (safe, isolated):** `signAuthFields` (Host-only) / `verifyAuthFields` (any device,
   using `camps.signing_public_key`) over a canonical serialization of `{id, role, pin_hash, pin_salt}`.
   Unit-tested in isolation. No behavior change yet.
2. **Sign on write + backfill:** `createUser` (the sole credential-write path) emits `auth_sig`;
   a Host migration backfills `auth_sig` for existing users by signing their current values. The
   **client-admin wrinkle**: a credential write started on a client must round-trip to the Host to be
   signed — designed here (a Host-authorized sign step), since a client cannot self-sign.
3. **Enforce on projection:** once every row is signed (verified by a check), projection rejects
   unsigned/badly-signed changes to the three fields. This is the slice that closes the attack; it
   ships behind a guard that confirms backfill completed, so no one is locked out.
4. **Independent security re-review** (security-assessment + red-hat) before merge, given this is
   auth+sync+migration core and a wrong enforcement flip locks a camp out.

### Interlock with T163 (coordinated with the app-icon-audit / architecture-review program, 2026-09-14)

T163 (merging around the same time; rebase this work onto it) enforces credential **strength and the
promotion workflow at the API boundary**, complementary to this ADR's **authenticity at the
projection boundary**. It changes two assumptions this ADR was written under:

- **There is now more than one credential-write call site.** T163 adds `electron/ops/promoteToAdmin.js`
  — the *only* path that sets `role = 'admin'` — which writes `role` + `pin_hash` + `pin_salt`
  together inside `runAtomic`, and refuses a bare `users.role → 'admin'` flip through the generic
  `write()` IPC path. So the set of places that must **mint `auth_sig`** is exactly `createUser`
  **and** `promoteToAdmin` (the generic write path is closed by T163, not by this ADR). Any credential
  write that does not mint the signature will produce credentials this ADR's projection correctly
  *refuses* — a legitimate promotion would fail and look like broken verification. The mint must sit
  **inside** `promoteToAdmin`'s `runAtomic` step, signing the same three fields it writes as a unit.
- **T160 (#398, merged) touched `localAuth.js`:** `SCRYPT_PARAMS` is an exported frozen constant,
  `hashPin` reads a module-level `activeScryptParams`, `SHORESH_TEST_SCRYPT_N=1024` keeps the suite
  fast, and `attemptLogin` takes an optional `{ now }`. This work must not undo any of it; test users
  in these slices use those fast params.

Net effect on the plan: the "sole credential-write path is `createUser`" assumption in slice 2 is
replaced by "`createUser` + `promoteToAdmin`", and the canonical signed payload stays
`{id, role, pin_hash, pin_salt}` so it covers exactly what `promoteToAdmin` writes atomically.

### Original proposal (superseded, kept for the record)

Take `role`, `pin_hash`, and `pin_salt` out of the shared Automerge document and route writes
through a Host `authorize()`-gated path. Rejected in favor of signing because de-replication
regresses offline/new-device login for changed/new credentials (see the tension section above),
which the signature approach avoids.

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
