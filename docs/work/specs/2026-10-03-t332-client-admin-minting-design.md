---
title: "T332 — client-mode admin minting (closing the approveDevice/revokeDevice host-only gap)"
document_type: spec
authority: proposed
status: draft
created: 2026-10-03
task_class: security-auth
governing_docs:
  - docs/governance/constitution/CONSTITUTION.md
  - docs/governance/standards/ARCHITECTURE_STANDARD.md
  - SECURITY.md
depends_on:
  - docs/adr/2026-10-02-distributed-revocation-authority.md
archive_when: "a client-mode admin can mint a camp_authority_log grant/revoke from the UI end-to-end (founder removable from a non-founder admin's client device), a client-mode non-admin is refused, Security + Red Hat have reviewed the relaxed authorize path, and the red-before-green tests below are green"
---

# T332 — client-mode admin minting

**Implements** `docs/adr/2026-10-02-distributed-revocation-authority.md` (T331, already merged).
**Writes no new architecture decision** — this is closing an app-level IPC gap the ADR's own
"Blast radius" section already named as changed (`electron/main.js`'s `approveDevice`/`revokeDevice`
"now also mint a signed `camp_authority_log` entry... in addition to any existing immediate local
action") but did not itself relax the pre-existing `mode === 'client'` throw that still blocks
reaching that code at all on a Client device.

## Candidate approaches considered

**Closed case per the `adhd` pre-flight gate.** The accepted ADR already picked the authority
primitive (causal-ancestor `camp_authority_log`, mode-agnostic by construction — `mintGrantEntry`/
`mintRevokeEntry` write through the same `appendOp` path every synced entity uses). The only question
left here is mechanical: *which of three existing guards in `electron/main.js` still has a real
reason to exist, now that the fleet-wide mechanism they used to be a (weak) substitute for actually
ships.* That is not a question with multiple live technical shapes — it is answered by reading what
each guarded handler's body actually does post-T331. Divergent ideation would manufacture options
(e.g. "add a new client-approval relay through the Host," "require the Host to co-sign every
client-minted entry") that the accepted ADR has already foreclosed: there is no standing Host in
this architecture, and reintroducing a Host-co-sign requirement is exactly the single-point-of-failure
the ADR was written to eliminate. Proceeding directly to the investigation and the design it settles.

## Investigation — what each guard actually protects

Three `mode === 'client'` guards exist in the functions named by the ticket. Read in full
(`electron/main.js:1287-1427`, `:1105-1200`):

### `approveDevice` (line 1297, guard reads `'Device management can only be done on the main computer.'`)

Body, in order: (1) `requireAuthorized(db, { token, action: 'devices.approve' })` — role check,
mode-agnostic; (2) **the guard**; (3) `UPDATE devices SET authorized_at = ..., device_secret_identifier = ...` —
a write to **this device's own, never-synced `devices` table**; (4) if `makeAdmin`, `mintGrantEntry`
(appendOp into the shared Automerge document — fleet-wide, mode-agnostic) + local projection refresh;
(5) `getAutomergeNode()?.sendPairingApproved(targetDeviceId, secret)` — sends the pairing secret to
the joining device over **this device's own** libp2p node, a no-op if this device has no pending
stream for that device (confirmed by the existing comment at line 1335-1338: "safe to call
unconditionally").

The historical (T86-era) justification, still in the comment at 1290-1299: *"this writes straight to
THIS device's local, never-synced `devices` table. On a Client that write can never reach the Host,
where device trust is actually enforced."* That premise was true before any distributed mechanism
existed: the local `devices` table was the **only** admission record, read back by
`deviceTrustStatus` (`electron/auth/deviceTrust.js`) and consulted by `connectionAuth.js` —
**per-device, never synced**, confirmed by `grep` showing no sync/projection path touches it. A
Client's local write to its own `devices` table was real but **inert** for every other device's
admission decisions, because nothing propagated it.

### `revokeDevice` (line 1367, guard reads the same message)

Body: (1) `requireAuthorized(db, { token, action: 'devices.revoke' })`; (2) **the guard**; (3)
`UPDATE devices SET revoked_at = ...` — same local, never-synced table; (4) `mintRevokeEntry` (same
appendOp path as grant, **always** run regardless of target — the replay, not this call site,
decides immediate-removal vs. vote-toward-quorum, per the comment at 1386-1394); (5)
`getAutomergeNode()?.revokePeer(peerId)` — tears down **this device's own** live connection to the
target, if any; (6) `forgetPeerAddress(db, peerId)` — removes the target from **this device's own**
`peerAddressBook`.

### `bootstrapCamp` (no `mode === 'client'` guard exists)

Read in full (`electron/main.js:1105-1190`): gated only by "camp already exists" and "sync not
initialized." It is not mode-gated because it cannot be — the act of calling it **is** what makes
this device the founder/Host-signing-key holder (`ensureHostSigningKey`, line 1128). The ticket's
instruction to check it is satisfied by this reading: **there is no guard here to relax.** It is out
of scope by construction, not by omission.

### What the guard is a proxy for, concretely

Every one of `approveDevice`/`revokeDevice`'s **local** side effects (the `devices` table UPDATE,
`sendPairingApproved`, `revokePeer`, `forgetPeerAddress`) operates on data and connections scoped to
**the calling device itself** — exactly the kind of state every device, Host or Client, already
maintains independently (each device runs its own `devices` table, its own libp2p node, its own
`peerAddressBook`). None of them write to, or require, anything that is unique to a designated Host
process. The **one** effect that is authoritative fleet-wide — `mintGrantEntry`/`mintRevokeEntry` —
is already mode-agnostic by the ADR's own design (`appendOp`, the same path every other synced write
uses; confirmed by direct read of `electron/automerge/authorityLog.js`, which contains no device-role
branch of any kind).

**Contrast with the guards this ticket does NOT touch** (`ingestCommit` ~504, `ingestUndo` ~682,
`confirmAlias` ~706, `recordDeclinedSplit` ~736): those write directly to genuinely host-local tables
excluded from the sync/document model altogether (`source_aliases`, `compound_cell_decisions`,
`location_word_decisions`, `declined_two_row_splits`) — there is no fleet-wide mechanism standing in
for them, so "only visible on this device" is still a real defect on a Client today, and those guards
are correctly left in place. `approveDevice`/`revokeDevice` are categorically different post-T331:
their authoritative half is no longer host-local.

**Conclusion: the guard in `approveDevice` and `revokeDevice` is now vestigial.** It was a correct
proxy for "this won't actually take effect fleet-wide" before T331 and is a stale proxy for nothing
after it — the real effect (the signed `camp_authority_log` entry) takes effect fleet-wide
regardless of which device signs it, which is the entire point of the accepted ADR.

## Authorize gate

No new gate is needed; the existing composition already does the right thing, and this section
states it precisely so Security/Red Hat can check it rather than re-derive it:

1. **Role check (mode-agnostic today, unchanged by this ticket):** `requireAuthorized(db, { token,
   action: 'devices.approve' | 'devices.revoke' })` → `authorize()` (`electron/auth/authorize.js:19-77`)
   re-queries `users.role` fresh from the DB on every call, looks it up against
   `PERMISSIONS[role]`, and `devices.approve`/`devices.revoke` appear **only** under `admin: ['*']`
   (`electron/auth/permissions.js:181-182` — explicitly absent from the staff list, confirmed by
   direct read). **A client-mode staff caller is refused here, today, with no code change** — this
   is the "client-mode non-admin is refused" requirement, already satisfied.
2. **Device-trust check (also mode-agnostic, inside the same `authorize()` call):** `trust =
   deviceTrustStatus(db, session.deviceId)`, denying if `!trust.found || !trust.authorized ||
   trust.revoked` — re-derived from **this device's own** local `devices` row on every call. A
   revoked caller device is refused regardless of mode.
3. **Causal-admin check (new in T331, verified fleet-wide, not locally at mint time):**
   `mintGrantEntry`/`mintRevokeEntry` do not themselves check "is the signer currently a valid
   admin" — per the ADR's explicit design, that question is answered by `authorityReplay.js`'s
   `isValidAdminAt` **at projection time, on every peer**, walking the signer's own causal ancestry.
   A device whose own `users.role` is `'admin'` (passes check 1) but whose `camp_authority_log`
   state has **already been causally revoked** as an admin will still pass `authorize()` (role is a
   separate, not-yet-unified concept per the ADR's own "Open questions" — `users.role` is Host-signed
   credential state, `camp_authority_log` is the new distributed concept) but **its minted entry will
   be silently dropped by every peer's replay** once that peer's local causal state reflects the
   revocation. This is the ADR's "never trust a self-report" invariant working exactly as designed —
   it is a feature of the design, not a gap this ticket needs to close, and it is the reason `isValid
   AdminAt` exists rather than a flag the minter could assert about itself.

**The gate this ticket actually changes:** removing the `mode === 'client'` throw in `approveDevice`
and `revokeDevice`. Nothing about the authorize composition above changes — it already composes
correctly with the causal-admin check, because the causal-admin check lives one layer further out
(at every peer's projection, not at the minting call site) and was never mode-dependent to begin
with.

## Design — exactly what changes

**Relax exactly two guards, delete nothing else:**

- `electron/main.js` `approveDevice`, line 1297: delete the `if (mode === 'client') { throw ... }`
  block and its comment (lines 1290-1299 describe a premise the "Why T86 no longer holds" reasoning
  above supersedes — replace the comment, do not just delete it, so a future reader does not
  wonder why the guard vanished with no trace). Everything else in the function is unchanged — the
  local `devices` UPDATE, the `makeAdmin` → `mintGrantEntry` branch, and `sendPairingApproved` all
  already run identically regardless of mode; they were never mode-branched internally.
- `electron/main.js` `revokeDevice`, line 1367: same treatment — delete the guard and its comment,
  replace with a short comment recording why (point readers at T332/the ADR, not at a restated
  T86 rationale). Everything else unchanged.

**Leave untouched:**

- `denyDevice` (line 1347) — **not named in the ticket's three functions**, and it mints no
  `camp_authority_log` entry at all (it only flips `pairing_status = 'denied'` locally and sends a
  denial message over this device's own libp2p node — a Client could trivially run this safely
  today, by the same reasoning as above, but it is outside what the organizer scoped). Flagged as an
  **open question for Governor** below rather than touched unilaterally.
- `bootstrapCamp` — no guard exists; out of scope by construction (see Investigation).
- `ingestCommit`/`ingestUndo`/`confirmAlias`/`recordDeclinedSplit` and every other `mode ===
  'client'` guard in the file (lines ~504, 682, 706, 736, 1046, 1985, 2000, 2542, 2558) — all guard
  genuinely host-local, never-synced tables with no fleet-wide mechanism standing in for them. None
  of this ticket's reasoning applies to them; do not relax any of them as a side effect of touching
  this file.

**No schema or migration change.** `camp_authority_log`, its signing module, and its replay already
exist (T331, merged). This ticket is a two-line deletion (plus comment) in `electron/main.js`.

**No new Tier-4 (or any new) capability is opened.** `devices.approve`/`devices.revoke` already exist
as admin-only actions; this ticket does not add, widen, or rename a capability — it removes an
app-level mode check that sat *after* the existing capability check and in front of code that was
already mode-agnostic in its authoritative effect.

## Privilege-escalation checklist for Security + Red Hat

Enumerated so the review has a fixed list to confirm against, not just "does this look okay":

1. **Can a client-mode admin now do anything a host-mode admin couldn't already do?** No new
   capability is reachable — `devices.approve`/`devices.revoke` were always admin-only; relaxing the
   guard only changes *which device* can reach code that was always reachable on the Host.
2. **Can a client-mode non-admin reach minting?** No — `authorize()`'s role check runs before the
   (now-removed) mode guard ever did, and is unchanged. Confirm by test (list below) that a staff
   token still gets `allowed: false, reason: 'forbidden'` from `requireAuthorized`, never reaching
   `mintGrantEntry`/`mintRevokeEntry`.
3. **Can a client-mode admin forge a causal basis to resurrect itself after being revoked, or to
   make its own signature count retroactively?** No — this is unchanged from T331's own guarantee
   (`isValidAdminAt` walks real Automerge `deps`, not a self-report); this ticket does not touch
   `authorityLogSignature.js` or `authorityReplay.js`.
4. **Does relaxing the guard let a Client touch `host_signing_key`, `signing_public_key`, or
   anything `bootstrapCamp`/`ensureHostSigningKey` owns?** No — neither `approveDevice` nor
   `revokeDevice` reads or writes `host_signing_key` anywhere in their bodies (confirmed by direct
   read; the only Host-signing-key code path in this file is inside `bootstrapCamp`, untouched).
5. **Does a client-mode `approveDevice` call let a Client authorize a device that the actual Host
   (if the camp still has a human-designated "main computer" in practice) did not see or approve
   in person?** This is unchanged risk, not new risk: the in-person pairing UX
   (`sendPairingApproved`) already requires the approving device to have a pending libp2p stream for
   the target (an actual physical join attempt), and `makeAdmin` is an explicit, logged
   (`recordAuditEvent('device.approve', ...)`) choice by whichever admin is physically present at
   approval time — this was already true when only the Host could do it; now any admin, on any
   device, can be the one physically present. This is the ADR's **intended** effect, not a side
   effect to flag as new risk.
6. **Does a client-mode `revokeDevice` call let the target's revocation be "lost" or weaker than a
   Host-mode revocation?** No — `mintRevokeEntry` is unconditional and identical regardless of
   caller mode; the local `devices.revoked_at` write, `revokePeer`, and `forgetPeerAddress` are all
   best-effort local conveniences on top of the fleet-wide mint, exactly as they already were on the
   Host (see `revokeDevice`'s own existing comments at 1402-1424 — those three steps were already
   "nice to have, not load-bearing" relative to the T331 gates A/B/C that do the actual enforcement
   on every other peer).
7. **Audit trail parity:** confirm `recordAuditEvent` still fires identically from a client-mode
   call (it is unconditional in both handlers, unchanged by this ticket) — a client-mode admin
   action must be just as auditable as a host-mode one.
8. **`PROJECTIONS`/camp-scoping boundary:** `camp_authority_log` is already excluded from
   `PROJECTIONS`/`campScopedEntities.js` per the ADR's own design (never a modeled camp entity in the
   ordinary CRUD sense) — this ticket introduces no new entity and does not touch that boundary.

## Red-before-green tests

All run against the real IPC handlers (`electron/main.js`), not a mocked `authorize()` — the point
is proving the *composition*, not any one layer in isolation.

1. **Client-mode admin mints a founder-removal revoke, end-to-end.** Three devices: founder (Host,
   holds the only `host_signing_key` row ever created in the scenario), admin-2 (mode: client),
   staff (mode: client). admin-2 calls `revokeDevice` targeting the founder. Assert: (a) the call
   does not throw the `mode === 'client'` error (it must not exist after this change); (b) a signed
   `revoke` entry lands in `camp_authority_log` with `signer_device_id = admin-2`; (c) after
   propagation/merge, the founder is refused at gate (A)/(B) on its next connection attempt to either
   other device; (d) this holds even though the founder's device is the **only** one that ever held
   `host_signing_key` — confirming no Host-only code path was silently required.
2. **Client-mode staff is refused minting, before `mintRevokeEntry` is ever called.** staff (mode:
   client) calls `revokeDevice` targeting any device. Assert `requireAuthorized` throws (or the
   handler surfaces the `forbidden` denial) and no `camp_authority_log` entry is written — spy on
   `mintRevokeEntry`/`mintGrantEntry` (or assert the document's entry count is unchanged) to prove
   the refusal happens before minting is attempted, not merely that the end state looks right.
3. **Non-founder admin fires another admin from a client device — the owner's core scenario.**
   Four admins (founder + 3 granted later, one of them mode: client); the client-mode non-founder
   admin revokes a different non-founder admin; with N=4 (threshold 2 of 3 others), assert the
   target is removed only once a second admin's vote also lands, exactly per the ADR's quorum table
   — proving this ticket's change composes correctly with T331's quorum logic, not just with
   immediate single-admin revocation of an ordinary device.
4. **Client-mode admin approves a new device and grants admin, end-to-end.** admin-2 (mode: client)
   calls `approveDevice({ deviceId: newDevice, makeAdmin: true })`. Assert: (a) no throw; (b) the
   local `devices` row for `newDevice` is authorized; (c) a signed `grant` entry lands in
   `camp_authority_log`; (d) after propagation, `newDevice` is recognized as a valid admin by
   `isValidAdminAt` on a third peer that never ran `approveDevice` itself.
5. **No host-only side effect leaked.** For both `approveDevice` and `revokeDevice` called in
   client mode, assert `host_signing_key` is never read or written (spy on
   `ensureHostSigningKey`/the `host_signing_key` table) and `camps.signing_public_key` is unchanged —
   proving the relaxed path truly never touches Host-exclusive state.
6. **`denyDevice` behavior is unchanged (regression guard, not a new feature).** Confirm `denyDevice`
   still throws in client mode after this change — proving the two-function scope of this ticket was
   not accidentally widened by a careless shared-helper edit.

## Open questions for Governor

1. **Should `denyDevice`'s `mode === 'client'` guard be relaxed in the same ticket, or spun off?**
   It mints no authority entry and has no host-exclusive effect, so the same reasoning that justifies
   relaxing `approveDevice`/`revokeDevice` applies to it — but it was not named in the ticket's scope,
   and relaxing it is a product-visible behavior change (a client-mode admin can now deny a pairing
   request) that the organizer has not explicitly ruled on. Recommend leaving it as a follow-up board
   item rather than folding it in silently.
2. **The ADR's own named residual (offline-race, ~55% confidence, accepted as bounded for v1) is
   unchanged by this ticket** — client-mode minting does not make that residual larger or smaller,
   since the causal-ancestor rule was already mode-agnostic. No action needed here; restated only so
   Security/Red Hat don't mistake "client can now mint" for "a new attack surface on the residual."
