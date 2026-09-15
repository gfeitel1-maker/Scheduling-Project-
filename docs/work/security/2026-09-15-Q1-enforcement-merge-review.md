# SECURITY ASSESSMENT — Q1 CRDT-merge credential-forgery enforcement (pre-merge review)
Date: 2026-09-15   Assessed against commit: 07903cd (branch claude/security-testing-agent-8e9c63)

## Scope
The Q1 enforcement slice: Host-signed credential fields (auth_sig) minted at createUser +
promoteToAdmin, verified at the doc->SQLite projection boundary (projector.js upsertUsersEntity).
Files: electron/auth/authSignature.js, electron/auth/localAuth.js (createUser),
electron/ops/promoteToAdmin.js, electron/db/localDb.js (v60 + backfillAuthSignatures),
electron/ops/projections.js, electron/automerge/projector.js.

## Boundary verdict
Trusted-LAN boundary: HOLDS. This change strengthens the merge-trust surface. The residual
findings below become HIGH/CRITICAL only when transport becomes internet-reachable — they are
hard-blockers for the Tier-4 internet-transport gate, not for the current LAN boundary.

## Does the enforcement close Q1's primary attack? YES (with residuals).
The core Q1 escalation — a compromised paired STAFF device self-promoting to admin, or overwriting
the real admin's PIN — is closed. A never-admin staff id has no Host signature over role=admin, so a
forged change is refused (verifyAuthFields false -> credential fields skipped, prior local values
kept). camps.signing_public_key is NOT a replicable projection field (PROJECTIONS.camps.fields =
['name']), so the "swap in my own pubkey via the doc" bypass is closed. Signatures bind `id`, so a
signature cannot be moved to another user. Canonicalization (domain-prefixed JSON array of 4
string-coerced fields) is unambiguous and domain-separated from the session-token path; key formats
match issueCampToken/verifySessionToken.

## Confirmed findings (ranked by leverage)

1. Signature replay / rollback — no freshness binding | MEDIUM (HIGH if internet-reachable)
   authSignature.js:22 (SIGNED_FIELDS) + projector.js:205-235
   The signed tuple is {id, role, pin_hash, pin_salt} with no version/counter/nonce/timestamp.
   Ed25519 signatures do not expire, and enforcement applies ANY tuple that verifies. Attack path:
   a user promoted staff->admin via promoteToAdmin has a PRIOR Host-signed STAFF tuple
   {id, staff, pinHashA, saltA} that replicated in the doc. A compromised paired device replays that
   old signed tuple (role=staff, old pin, old sig) as a merge. On projection: credChanged=true
   (admin->staff), verifyAuthFields returns TRUE (it is a genuine old Host signature), so the change
   is APPLIED — silently demoting the admin back to staff and reverting their PIN to the previously
   known value. This is an unauthorized credential mutation on the exact merge path Q1 was meant to
   lock down. (Escalation-by-replay is NOT achievable because no never-admin id has an admin
   signature and admin->staff demotion is not a live flow; the achievable direction is
   demotion/PIN-rollback of a promoted admin.)
   Fix: bind a monotonic per-user credential version (or the prior auth_sig / a document logical
   clock) into the signed payload and refuse a verified tuple whose version is <= the local row's.

2. Degrade-accepted forgeries become PERMANENT | MEDIUM (HIGH if internet-reachable)
   projector.js:194-196 (pub read) + 205-208 (change-triggered gate)
   The no-public-key degrade (#401 rebuilt device) accepts all credential changes. Because
   enforcement is CHANGE-triggered (credChanged compares doc vs local SQLite) and never re-verifies
   at-rest rows, a forged admin row accepted during the no-key window becomes the local "current"
   value; after the device re-syncs the public key, the same doc row now reads as UNCHANGED
   (credChanged=false) and is applied as a no-op that is never verified. The code comment
   (projector.js:193) and the ADR both claim the device "re-enforces once it re-syncs the public
   key" — that is FALSE for anything accepted during the window. A compromised peer that forges an
   admin row into the shared doc before a victim's rebuild makes that forgery permanent on the
   rebuilt device.
   Fix: when the public key transitions absent->present, re-verify all at-rest credential rows once
   (or on key-return, refuse any local credential row whose auth_sig does not verify).

## Open questions (need investigation before confirm/drop)

- Change-PIN flow: I found only createUser and promoteToAdmin minting auth_sig. If any other
  credential-write flow exists or is added (self-service PIN change; admin->staff demotion) and does
  NOT re-mint auth_sig, its write goes through the generic write() path (which does not sign) and
  will be REFUSED on projection camp-wide — a latent propagation failure / "can't demote a rogue
  admin" gap. write() blocks only role->'admin'; role->'staff' is permitted but unsigned. No
  demotion UI exists today, so this is latent, not a live lockout. Settle by auditing every
  users credential write call site against the two mint sites.

- Forged data persists in the shared CRDT document. Enforcement is at the projection (doc->SQLite)
  boundary, not the merge boundary; there is no doc scrub. Forged role/pin/auth_sig sit in the
  shared doc indefinitely, refused on keyed devices but a landmine for any degrade-mode projection
  (finding 2). Confirmed as a design property; worth documenting explicitly.

## Re-opened tradeoffs

- #401 degrade-on-no-key (ADR "keep last-known / do-not-newly-enforce; re-enforces on re-sync").
  Conditions when accepted: transient window, self-healing. Do they still hold? PARTIALLY — the
  window self-heals for NEW changes but NOT for values accepted during it (finding 2). Recommend
  at-rest re-verification on key-return before the Tier-4 gate.

## Summary Score (for Grader)
Security posture: 4 — the primary Q1 escalation is correctly and tightly closed; two residual
merge-path credential-mutation gaps (replay/rollback, degrade-permanence) remain and must be fixed
before the internet-transport (Tier-4) gate, but do not block merge under the current LAN boundary.
