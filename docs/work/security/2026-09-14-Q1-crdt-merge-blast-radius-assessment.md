---
title: "Q1 — CRDT-merge blast radius of a compromised paired device"
document_type: reference
authority: descriptive
status: active
date: 2026-09-14
program: security-hardening
---

# SECURITY ASSESSMENT — Q1: CRDT-merge blast radius of a compromised paired device
Date: 2026-09-14   Assessed against commit: 7686437 (worktree; files read directly, not the committed graph)

Scoped Tier-3 follow-up settling open question **Q1** from
`docs/work/security/2026-09-14-auth-sync-threat-assessment.md`. Descriptive; the code is authority.

## Boundary verdict
Trusted-LAN boundary: **HOLDS today (transport is loopback + mDNS), AT RISK on the roadmap.**
Q1 is orthogonal to the transport boundary but its *severity* is gated by it: the finding below is
an insider-with-a-paired-device attack today and becomes a remote attack the moment the transport
becomes internet-reachable (Tier-4).

## Confirmed finding

### Q1 — CONFIRMED — Camp-wide privilege escalation and admin-credential overwrite via a merged CRDT op (HIGH today; CRITICAL if transport goes internet-reachable)

**Attack path (paired staff device → op → effect), fully traced:**

1. `users` is a replicated document entity. `EXTRA_MODELED_ENTITIES = ['camps','users']`
   (`electron/automerge/campDocument.js:83`) puts it in `MODELED_ENTITIES`, so it is part of the
   shared Automerge document that syncs between peers (genesis-included, projected by `projectAll`).
2. Its projected fields include the security-critical ones:
   `PROJECTIONS.users.fields = ['camp_id','name','pin_hash','pin_salt','role']`
   (`electron/ops/projections.js:112`).
3. The receive path performs **no authorization**. `onDocReceived: handleReceived`
   (`electron/sync/automerge/syncNode.js:366`) → `A.merge` (`syncNode.js:157`) →
   `reconcileForProjection` → `projectAll(db, merged)` (`syncNode.js:85`). `projectAll`
   (`electron/automerge/projector.js:353`) calls `upsertEntity(db, doc, 'users')`, which iterates
   every field present in the doc row and replays it through `applyProjection`
   (`projector.js:193-197`). There is no `authorize()`, no role check, no author check anywhere on
   this path. This matches the documented, owner-accepted tradeoff "Role enforcement is device-side
   under CRDT sync" (`docs/work/evidence/2026-09-08-crdt-removes-host-side-authorization.md`).
4. A compromised but legitimately-paired **staff** device (running modified code or writing its own
   doc directly — the exact threat class the tradeoff doc names) emits Automerge changes for the
   `users` collection and broadcasts them. On every peer they merge and project unconditionally.

**What this lets a merged op do that a `staff` IPC caller categorically cannot:**
- **Self-promotion / forged admin.** Staff holds **no** `users.write` at all — the staff allowlist
  in `electron/auth/permissions.js` grants only `users.read`; all `users` writes are admin-only via
  `admin:['*']` + default-deny, and `createUser` is gated `users.create` (`electron/main.js:701`).
  Via merge, the attacker writes `users/<self>/role = 'admin'`; it projects onto every device. The
  real admin's device now shows the attacker as admin, and the attacker's own `authorize()` (which
  re-queries the local `users` row) now grants admin locally.
- **Admin credential overwrite / account takeover.** The attacker writes `pin_hash`/`pin_salt` for
  the *real admin's* user id to a hash of a PIN they choose. `attemptLogin` verifies against the
  local `users` row (`electron/auth/localAuth.js:155`, `parseStoredHash` + `scryptSync` +
  `timingSafeEqual`), so after the merge lands the attacker can log in as the admin on any device,
  and the legitimate admin is locked out. The code already *knows* this field is attacker-writable —
  `localAuth.js:75-81` states "`users.pin_hash` is a MODELED DOCUMENT FIELD: it replicates, so any
  peer admitted to the camp can set it to anything" — but the mitigation there addresses only the
  memory-bomb DoS, not the takeover.
- **Create new admin accounts** (mint a fresh `users` row via merge) and **delete/bulk-replace
  entities** that are admin-only via IPC (staff lacks `.delete`/`.restore` for most entities;
  a merged `DELETE_FIELD` write is not subject to that matrix).

**Confirmed how:** static trace of the receive→merge→project→login chain across the five files
cited above; consistent with the project's own measured evidence
(`docs/work/evidence/2026-09-08-...`: "HOST ACCEPTED the write from a demoted device").

## What bounds it today (and what does not)
- **`devices` is NOT a modeled document entity** (`EXTRA_MODELED_ENTITIES` is only `camps`,`users`).
  Device approve/revoke stays host-local. So a merged op **cannot** approve a brand-new device into
  the admission set — admission remains gated by `authGate.js`/`mutualAuth.js`. This bounds the
  attack to *what an already-admitted peer can write*, not to admitting strangers. (Role escalation
  does not, on its own, let a client approve devices on the Host, since that call is host-side.)
- **`camps` is clamped** — `upsertCampsEntity` (`projector.js:156`) refuses any foreign camp id, and
  `applyProjection`'s camp_id guard is inherited. This bounds cross-camp/scope drift. NOTE: this
  guard bounds a HONEST bug (wrong-camp doc) and cross-tenant drift; it does nothing against the
  `users` attack, which is within the device's own camp.
- **`parseStoredHash` clamp** (`localAuth.js:87`) bounds only the scrypt **memory-bomb DoS** — a
  malicious op is stopped from allocating hundreds of GB. It does NOT bound credential overwrite:
  a normal-cost hash of an attacker-known PIN passes the clamp and verifies.
- **`sanitizeOpForIpc`** (`electron/main.js:121`) strips pin fields from IPC op *events* only; it is
  not on the merge path and does not gate replication.

Net: the existing guards bound accidental drift and resource-exhaustion (honest-bug / DoS class).
They do **not** bound the malicious privilege-escalation / credential-overwrite class.

## Re-opened tradeoff
| Tradeoff | Accepted when | Do conditions still hold? | Recommendation |
|---|---|---|---|
| "Role enforcement is device-side under CRDT sync" (SECURITY.md) | 2026-09-08, framed as *"role separation is a UI/workflow control rather than an enforced boundary"* on a director-approved LAN | Partially. The framing understated blast radius: it reads as "staff can edit data above their role." It was NOT explicitly framed as "any staff device can silently overwrite the admin's PIN and forge admin accounts across every device." Credential overwrite/impersonation is a different, larger category than data-role bypass. | Keep the accept for *data* role separation, but (a) update SECURITY.md so the owner has explicitly accepted the **credential-overwrite + admin-forgery** consequence in plain terms, and (b) strongly prefer Option 3 below for the `users` credential/role fields specifically. |

## Recommendation (ranked)
1. **Narrow what replicates for `users` (evidence-doc Option 3).** Keep `pin_hash`/`pin_salt`/`role`
   out of the shared document; route those writes through a Host-side IPC call that goes through
   `authorize()`. This removes the highest-leverage half of the attack (credential overwrite + role
   forgery) without reintroducing per-merge authorship validation for the whole model. Cost: `users`
   auth-critical fields sync by a different mechanism than the rest of the row. Best value/leverage.
2. **Authorize at the merge boundary for `users` only** (evidence-doc Option 2, scoped): reject
   incoming `users` role/pin writes whose Automerge actor id is not an admin device. Requires
   per-change authorship + a partial-doc-acceptance rule; partially reintroduces a central decision.
3. **If neither is done now:** record the accept in SECURITY.md in the explicit terms above, and add
   the credential-overwrite/admin-forgery scenario to the Tier-4 gate's mandatory re-assessment list.

## Roadmap dimension (Tier-4)
Today the attacker must be an insider the director personally paired and who then tampers with their
device — a meaningful barrier on a trusted LAN. If the transport becomes internet-reachable (the
parked relay/Syncthing track; libp2p makes it a small config change), the same op becomes a **remote
account-takeover of the camp admin**, and the pairing/PIN barrier is the only thing between a remote
attacker and camp-wide admin. Severity rises HIGH → CRITICAL. This is a hard blocker that must be
resolved (Option 1 or 2) before the Tier-4 gate is signed off, not deferred.

## Summary Score (for Grader)
Security posture: **3** — the auth/admission/transport boundary is sound and the tradeoff is
honestly documented, but the CRDT-merge path lets a compromised paired staff device escalate role and
overwrite the admin's credentials camp-wide with no authorization, which exceeds the blast radius the
accepted tradeoff was framed around and is a Tier-4 blocker.
