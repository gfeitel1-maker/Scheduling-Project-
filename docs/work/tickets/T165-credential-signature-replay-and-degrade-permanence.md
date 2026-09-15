---
title: "Credential-signature replay + degrade-window permanence — hard blockers before internet transport"
document_type: ticket
status: completed
created: 2026-09-15
task_class: security-auth
governing_docs: [docs/governance/GOVERNANCE_INDEX.md, docs/adr/2026-09-14-users-auth-fields-off-the-replicated-document.md, docs/adr/2026-09-14-internet-transport-security-gate.md]
archive_when: both findings are fixed (freshness binding + at-rest re-verification) and covered by tests, OR the internet-transport (Tier-4) gate is being signed off and this is resolved as part of that mandatory re-assessment
---

# T165 — Credential-signature replay + degrade-window permanence

**RESOLVED 2026-09-15** (the product owner escalated this to present-risk: "there are other pathways
connecting devices besides LAN"). Both findings are fixed and test-covered; the mechanism differs
slightly from the fix directions originally sketched below, and the difference is deliberate:

- **Finding 1 (replay) — fixed by a monotonic credential version.** Schema v61 adds
  `users.cred_version`, bound into the signature (canonical shape bumped v1→v2). `createUser` mints
  version 1; `promoteToAdmin` mints `previous + 1`. Projection (`upsertUsersEntity`) applies a
  verified credential change only if its `cred_version >= the local row's` — so a replay of an older
  genuinely-signed tuple (lower version) is refused. Tested in `authSigEnforcement.test.js`
  ("REPLAY DEFENSE …") and the primitive binding in `authSignature.test.js`.
- **Finding 2 (degrade-window permanence) — fixed by NOT accepting during the no-key window,**
  rather than the "accept-then-re-verify-on-key-return" sweep originally proposed. When a device has
  no `signing_public_key`, `upsertUsersEntity` now **skips** an unverifiable credential change
  (keeps current values) instead of accepting it — so a forgery is never applied and cannot become
  permanent. This does not lock anyone out because `camps` (carrying the key) projects before
  `users` in the same `projectAll` pass, so the key is present on any real sync that carries users;
  the device recovers the genuine value once the key is present. Tested in `authSigEnforcement.test.js`
  ("with no signing_public_key … SKIPS" and "recovers once the key returns").
- **`NOT_RECOVERABLE_NOTICE`** (deferred sub-item) updated in `rebuildSupportCommand.js`: a rebuilt
  device cannot verify credential changes until it re-syncs `camps.signing_public_key`, and a rebuilt
  Host cannot mint until its key is re-established.

**Still open (watch-item, not a code change here):** any future migration that re-hashes existing
PINs (e.g. a scrypt-cost raise) must re-sign the affected rows through the Host, or every re-hashed
row becomes a credential change with a stale signature that enforcement refuses. Noted in the ADR.

---

## Original findings (for the record)

Two MEDIUM findings from the independent `security-assessment` review of the Q1 enforcement slice
(`docs/work/security/2026-09-15-Q1-enforcement-merge-review.md`). Both were rated **safe under the
current trusted-LAN boundary** by that review and by `red-hat`, and both are **HARD BLOCKERS on the
Tier-4 internet-transport gate** (`docs/adr/2026-09-14-internet-transport-security-gate.md`) —
because their severity rises from MEDIUM to HIGH the moment a paired peer can be a remote attacker.
The primary Q1 attack (a compromised paired device *escalating* to admin or overwriting the admin
credential to attacker-chosen values) is already closed and merged; these are the residual,
lower-severity merge-path credential-*mutation* vectors that closing it left.

## Finding 1 — Signature replay / rollback (no freshness binding)

`electron/auth/authSignature.js` signs `{id, role, pin_hash, pin_salt}` with no version/nonce/
timestamp, and `projector.js`'s `upsertUsersEntity` applies *any* tuple that verifies. When a user
is promoted staff→admin, their **prior** Host-signed *staff* tuple still sits in the replicated
document. A compromised paired device can replay that old, genuinely-Host-signed tuple; on
projection `credChanged` is true, `verifyAuthFields` returns **true** (it is a real Host signature),
and the change applies — **demoting the admin back to staff and rolling their PIN back** to the
previously-known value. Escalation-by-replay is NOT reachable (no never-admin id has an admin
signature), so the achievable direction is demotion / PIN-rollback of a promoted admin.

**Fix direction:** bind a monotonic per-user credential version into the signed payload (the Host is
the single writer of credentials, so a monotonic counter is safe), and reject a verified tuple whose
version is ≤ the local row's. Adds a `cred_version` column (schema bump) minted+incremented by
`createUser`/`promoteToAdmin`.

## Finding 2 — Degrade-window forgeries become permanent

Enforcement is change-triggered (`credChanged` compares doc vs local SQLite) and never re-verifies
at-rest rows. On a device rebuilt from the document (#401) with no `signing_public_key`, all
credential changes are accepted (the intended graceful degrade). But a forged row accepted during
that window becomes the local "current" value; after the key re-syncs, the same doc row reads as
*unchanged* and is applied as an unverified no-op forever. The ADR/code comment claim the device
"re-enforces once it re-syncs the public key" — that is **false for anything accepted during the
window**.

**Fix direction:** on a key transition absent→present, run a one-time re-verification sweep of
at-rest credential rows, reverting rows that carry a non-empty-but-invalid `auth_sig` (a legacy
`auth_sig=''` row must NOT be reverted — that would be the lockout this whole design avoids). This
is lockout-risky and must be designed and reviewed carefully — it is deliberately NOT rushed into
the enforcement slice.

## Also do with this ticket
- Update `NOT_RECOVERABLE_NOTICE` in `electron/automerge/rebuildSupportCommand.js` (the deferred
  task already recorded in the Q1 ADR): a rebuilt device cannot verify credentials until it
  re-syncs `camps.signing_public_key`, and a rebuilt Host cannot mint until re-established.
- Watch-item: any future migration that re-hashes existing PINs (e.g. a scrypt-cost raise) must
  re-sign the affected rows through the Host, or every re-hashed row becomes an unsigned change that
  enforcement refuses camp-wide (Red Hat review).
