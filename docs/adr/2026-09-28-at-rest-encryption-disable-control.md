---
title: "At-rest encryption enable/disable control model — the director-gated disable guard"
document_type: adr
authority: normative
status: proposed
implementation_state: not_started
date: 2026-09-28
program: security-hardening
related_adrs:
  - docs/adr/2026-09-15-at-rest-encryption-scoping.md
  - docs/adr/2026-07-24-centralized-authorization-layer.md
  - docs/adr/2026-07-25-device-trust-revocation.md
related_tickets:
  - docs/work/tickets/T175-at-rest-encryption-activation.md
affects:
  - electron/main.js
  - electron/auth/permissions.js
  - electron/db/sqliteCipher.js
  - electron/db/docCipher.js
  - electron/db/atRestEncryption.js
  - electron/preload.js
  - src/screens (a new settings/security surface)
  - SECURITY.md
---

# At-rest encryption enable/disable control model — the director-gated disable guard

## Status

Proposed, 2026-09-28, architect (routed by owner requirement recorded in
`docs/work/tickets/T175-at-rest-encryption-activation.md`, 2026-09-28 section). This is a **flip
precondition** folded into T175's `archive_when` — it does not change the current staged-OFF
default and does not touch the keychain or a real device's DB. Implementation requires mandatory
Security + Red Hat review before it ships, because it touches `authorize()` and the encryption
migration path.

## Context

`docs/adr/2026-09-15-at-rest-encryption-scoping.md` decided *that* the camp document and SQLite db
are encrypted with a per-device key sealed in the OS keychain, and staged the flip behind
`SHORESH_AT_REST_ENCRYPTION` (`electron/db/atRestEncryption.js`), read once at process start. That
env var is the right mechanism for *staging a rollout* — it is not, and was never meant to be, a
production control surface. Today it is the *only* control: there is no director/host-facing
on/off switch, no authorization check, and no confirmation. Flipping it back to `'off'` on a
device that has already migrated to SQLCipher does not decrypt anything — `openLocalDb` opens
keyless, the keyed file fails to parse, and the device can no longer read its own camp data. The
failure mode is not "data becomes readable in plaintext," it is "device bricks its own data
access."

The owner's requirement, verbatim intent: *"once we turn encryption on, it would have to be hard
to turn off / only turned off by a director or host who knows what they are doing."* Four things
were asked for explicitly (ticket, 2026-09-28 section): (1) disable is a deliberate
`authorize()`-gated host/director act, never an ambient config edit; (2) explicit, informed
confirmation stating the consequence; (3) fail-closed — an unknown/unreadable state must never
read as "safe to disable"; (4) a real design for what "off after on" means, because it does not
safely exist today.

Note on roles: this codebase has exactly two roles, `admin` and `staff` (`electron/auth/
permissions.js`) — there is no separate `director`/`host` role in the permission matrix. "Director
or host" in the owner's language maps onto `admin`; `staff` gets no explicit grant for this action
and falls through `authorize()`'s default-deny, the same posture every other destructive/
irreversible action in this table already uses (`delete`, `bulk_replace`).

## Candidate approaches considered

Generated via divergent ideation across five cognitive frames (regulator, attacker/competitor,
inversion, 3am-on-call/no-support-team, remove-the-load-bearing-assumption) before converging —
required for this kind of security-control decision per the Architect role's divergence gate.

- **Multi-device quorum / peer counter-signature** — disable requires a majority vote or a
  counter-signing peer device. *Rejected as a trap*: this app has no voting/consensus protocol
  today, many camps run a single device, and building one just for this control is exactly the
  premature-generality karpathy-guidelines warns against. It also doesn't fix the bricking hazard
  — a quorum-approved disable still needs *something* to decrypt with.
- **Disable = fork a new plaintext camp/device identity** — toggling off spawns a new camp ID or
  device-variant rather than mutating in place. *Rejected as a trap*: it contradicts the
  single-camp-per-device-db invariant and campId continuity this whole app is built on (schedule
  templates, sync, every foreign key), to solve a UI-friction problem. Far more blast radius than
  the actual ask.
- **Time-delayed / staged disable (72-hour countdown, dual-db parallel run)** — adds a cooling-off
  period or a week of dual plaintext+encrypted operation before finalizing. Interesting as a
  *cheap addition* (a countdown costs little), but as the *primary* mechanism it doesn't answer
  the load-bearing question — what does "off" actually do to the bytes — and a parallel dual-DB
  run duplicates most of the complexity of a real migration anyway without more safety.
- **Refuse entirely / push disable out to an offline CLI-only recovery procedure** — no in-app
  control at all; disabling means running a documented out-of-band tool. Genuinely viable, and
  the ticket explicitly asks the Architect to weigh it. Rejected as the *primary* path because the
  ticket's own persona is "a director or host who knows what they're doing" — the codebase already
  describes the director as non-technical elsewhere (SECURITY.md, PLATFORM_STATE.md), and an
  admin-only in-app control with heavy confirmation friction achieves the same "hard, deliberate,
  gated" property without abandoning the person the feature is *for*.
- ★ **A real, verified decrypt-migration mirroring `migratePlaintextToEncrypted` in reverse** —
  the disable action performs an actual backup→decrypt→verify→shred cycle, symmetric to the
  encrypt-side migration that already exists and is already trusted (unit- and integration-tested,
  shipped). This is the non-obvious-but-viable pick: it is the only candidate that actually closes
  the stated hazard (a disabled device stays *readable*) rather than either refusing the feature
  or hand-waving past the hard part. It reuses a pattern this codebase has already built, reviewed,
  and hardened once — the smallest responsible answer to "what does off mean."

## Approach

### 1. The control model (recommended, confidence: high)

Two separate surfaces, not one shared toggle:

- **Staged rollout default** (`SHORESH_AT_REST_ENCRYPTION` env var, `electron/db/
  atRestEncryption.js`) — unchanged by this ADR. It stays exactly what it is today: a
  build/environment-level default for *new* devices and the eventual one-line flip, per T175's
  existing plan. This ADR does not touch it or its default value.
- **New, in-app, `authorize()`-gated director/host actions** — `Enable at-rest encryption` and
  `Disable at-rest encryption`, reachable only from an authenticated admin session in the running
  app (a settings/security screen). These are the *production* controls once a device has
  encryption in some state; the env var stops being the only lever the moment this ships.

Enable and disable are **not symmetric in required friction**, because they are not symmetric in
risk:
- **Enable** (plaintext → encrypted) already has a safe, tested, one-way path
  (`migratePlaintextToEncrypted`) with no bricking hazard — a failed migration restores from
  backup and the device stays exactly as readable as before. Enable therefore needs
  `authorize()` + a single confirmation, admin-gated for consistency, but does not need the same
  weight of friction as disable.
- **Disable** (encrypted → plaintext) is the hazard the owner named. It gets the full guard below.

Recommendation confidence: **high**. This reuses an existing, reviewed pattern (the encrypt-side
migration) instead of inventing new machinery, keeps the env var's job unchanged (satisfies the
constraint that this must not touch the staged-OFF default), and answers the owner's literal ask
— hard, deliberate, admin-gated — without the blast radius of quorum or camp-forking approaches.

### 2. The disable guard — `authorize()` seam

New action name, following the existing `<resource>.<verb>` convention
(`electron/auth/permissions.js`): `security.disable_at_rest_encryption` (and
`security.enable_at_rest_encryption` for symmetry). Added to `ENTITIES`-adjacent action space —
**not** added to `PERMISSIONS.staff`, so it resolves to admin-only via `authorize()`'s existing
default-deny, the same posture `delete`/`bulk_replace` already use for every other entity in that
table. No new permission-matrix mechanism needed.

The IPC handler (new, in `electron/main.js`, exposed via `electron/preload.js` as e.g.
`window.shoresh.disableAtRestEncryption(confirmationPhrase)`) is structured like every other
mutating handler in this file:

```js
const authz = authorize({ db, token, action: 'security.disable_at_rest_encryption' })
if (!authz.allowed) return { ok: false, reason: authz.reason }
```

`authorize()` re-derives role and device-trust from the database on this call — never trusts
anything cached in the renderer or in the session token — matching the app's one standing auth
invariant. This is the exact seam every other privileged mutation already funnels through; no new
authorization mechanism is introduced.

**Why this cannot become a new bypass on the headless MCP/CLI surface:** `scripts/mcp/tools.js`,
`scripts/ingestCli.js`, and `rebuildSupportCommand` call `openLocalDb` directly as plain Node —
they have no session token, no `authorize()` wiring, and are not Electron IPC handlers. The
disable/enable actions live **only** inside `electron/main.js`'s IPC handler set, which is the
only place `authorize()` is callable (it needs a `db` + a session `token`, neither of which the
headless scripts possess). This ADR adds no new exported function that a headless script could
import to reach the same effect — `decryptEncryptedToPlaintext` (below) is called from exactly one
place, the IPC handler, the same way `migratePlaintextToEncrypted` is today called from exactly
`openLocalDb`'s keyed-open path. If a future change needs headless disable, that is a new decision
requiring its own review — not something this design permits by omission.

### 3. Informed confirmation

Before the IPC call fires, the renderer screen requires the admin to type a confirmation phrase
(mirroring the existing pattern in `src/screens/JoinByCodeScreen.jsx`, `src/screens/elective/
assignment/AssignmentPanel.jsx`, and `electron/ops/ingest.js` — this codebase already has a
type-to-confirm convention; reuse it rather than inventing a new one) against consequence copy
stating, in plain language:

> Disabling at-rest encryption on **this device** decrypts `<campId>`'s database and document back
> to plaintext files. Camper data (including PIN hashes) will be readable by anyone with file
> access to this computer. This only affects this device — other paired devices keep their own
> encryption state until disabled separately on each of them. This cannot be undone by turning
> encryption back on; re-enabling starts a fresh migration.

This satisfies the house "no silent toggle / surface every consequence" rule the same way
`describeWriteFailure`-style copy does elsewhere in the app — the confirmation names the actual
data exposed and the actual scope (per-device, not camp-wide), not a generic "are you sure."

**Per-device scope — open question flagged below.** The device key is minted per-device
(`electron/db/dbEncryptionKey.js`: "generated once per device"), so disable is naturally a
per-device action with no cross-device coordination required by the crypto itself. The
confirmation copy above states this explicitly so an admin doesn't believe disabling one device
disables the camp's encryption everywhere.

### 4. Disable-migration semantics — `decryptEncryptedToPlaintext`

New function in `electron/db/sqliteCipher.js`, the mirror image of the existing
`migratePlaintextToEncrypted`, reusing its exact safety shape (already reviewed and shipped for
the encrypt direction):

1. **Backup first, fatal on failure.** Copy the current encrypted file before touching it — same
   `writeBackup` injection point `migratePlaintextToEncrypted` already uses. A failed backup means
   "do not proceed," identical wording/behavior to the existing function.
2. **Decrypt in place.** Open with the current key, `PRAGMA rekey = ""` (SQLite3MultipleCiphers'
   documented way to remove encryption in place — verify this exact pragma form against the
   installed `better-sqlite3-multiple-ciphers@12.11.1` docs before implementation, per
   `org-source-verification`; do not assume symmetry with the encrypt-side `PRAGMA rekey = "x'…'"`
   without checking the empty-key/removal semantics for this specific driver version).
3. **Verify before shredding anything.** Reopen the file **without** a key and read a row back
   (`SELECT count(*) FROM sqlite_master` or equivalent), proving the file is genuinely readable
   plaintext, before the encrypted backup is removed.
4. **Shred the encrypted backup only on a successful verify.** Any failure at step 2 or 3 restores
   from the backup and throws — the device is left exactly as encrypted (and readable) as it was
   before the attempt, never half-migrated. This is the direct fix for the bricking hazard: a
   failed disable cannot brick the device, because verify-before-shred guarantees the device ends
   the attempt in a known-readable state, either newly-plaintext or still-encrypted.

The `.automerge` document gets the equivalent treatment in `docCipher.js`/`docStore.js`: write a
decrypted copy, verify it round-trips (decode it back and confirm the expected shape/campId), then
replace the encrypted file — same backup-verify-shred discipline, not a new pattern.

This directly answers the ticket's open question #4: **"off after on" means a real, verified
reverse migration**, not a silent config flip and not a flat refusal. Refusing entirely was
considered (see Candidates) and rejected as abandoning the feature's own stated audience (a
director/host who legitimately needs their device readable again). A guided-export-only path
(dump to a new file, leave the original encrypted) was also considered internally as a lower-risk
variant but rejected for this ADR: it leaves the device in a state where "disabled" doesn't mean
what the admin was told it means (the original file stays encrypted and the device still cannot
read its own live db without the key) — worse UX for no safety gain over the verified in-place
migration, since the in-place migration already has a tested backup-restore path for every failure
mode.

### 5. Fail-closed invariant

State detection reuses the existing deterministic mechanism: `isPlaintextSqliteFile` (file-header
magic-byte check, not trial-and-error open) already answers "is this file plaintext or
encrypted/new" without needing a separate tracked state variable. This ADR does **not** introduce
a new persisted "encryption state" flag/row — doing so would create exactly the drift class
(config says one thing, file says another) the inversion-frame ideation flagged as a hazard, and
karpathy-guidelines argues against state you don't need. The disable IPC handler:

- Refuses (returns a distinguishable error, never proceeds) if the header check throws, the
  keychain/key acquisition throws, or the file is already plaintext (no-op-with-error, matching
  `migratePlaintextToEncrypted`'s existing idempotency guard against re-migrating).
- Never falls back to "assume plaintext, allow the toggle" on any of the above — an unreadable or
  ambiguous state is refused, not treated as safe-to-disable, satisfying requirement #3 literally.

### 6. The test that pins it

New test file, e.g. `electron/main.disableAtRestEncryption.test.js` (or alongside the existing
`sqliteCipher.integration.test.js` gating convention for the driver-dependent half):

- **RED — role gate.** A `staff`-role session calling the disable IPC handler is denied by
  `authorize()` (`reason: 'forbidden'`), and the encrypted file's header is unchanged afterward
  (assert the actual bytes, not just the return value — this project's standing lesson is "assert
  the row, not the call").
- **RED — device-trust gate.** A revoked/untrusted device's session is denied, re-checked on this
  call (not cached), per `authorize()`'s existing revocation-enforcement pattern
  (`docs/adr/2026-07-25-device-trust-revocation.md`).
- **RED — missing/mismatched confirmation.** Calling the handler without the exact confirmation
  phrase is rejected before any file is touched.
- **RED — fail-closed on unknown state.** Simulate the header check or key acquisition throwing;
  assert the handler refuses and the file is byte-identical afterward (not "assume plaintext").
- **GREEN — the happy path.** Admin role + trusted device + correct confirmation → 
  `decryptEncryptedToPlaintext` runs; assert (a) the on-disk header becomes the plaintext SQLite
  magic bytes, (b) a row inserted before disable reads back identically after, (c) the pre-disable
  encrypted backup no longer exists (shredded), (d) an audit event is recorded via
  `recordAuditEvent` (mirroring the `users.*` audit convention already in `authorize()`).
- **GREEN — idempotency.** Calling disable twice returns a clear "already plaintext" outcome the
  second time, not a crash or a silent no-op that looks identical to success.
- Non-vacuity discipline throughout: every RED case must assert the *file bytes* are unchanged,
  not just that the function returned an error — a test that only checks the return value would
  pass even if the guard were removed and the migration ran anyway.

## Files/modules affected

- `electron/auth/permissions.js` — add `security.disable_at_rest_encryption` /
  `security.enable_at_rest_encryption` to the action vocabulary (admin-only via default-deny, no
  staff grant).
- `electron/main.js` — new IPC handlers, `authorize()`-gated, calling the new sqliteCipher/
  docCipher functions.
- `electron/preload.js` — expose `window.shoresh.disableAtRestEncryption` /
  `enableAtRestEncryption` in the `contextBridge` block.
- `electron/db/sqliteCipher.js` — new `decryptEncryptedToPlaintext(filePath, key, { Database,
  writeBackup, fsImpl })`, mirroring `migratePlaintextToEncrypted`'s signature and safety shape.
- `electron/db/docCipher.js` / `electron/sync/automerge/docStore.js` — equivalent decrypt-and-
  verify path for the `.automerge` file.
- A new (or extended existing) settings/security screen under `src/screens/` for the confirmation
  UI — Designer's job to spec if this is judged UI-significant; this ADR states the copy content
  and confirmation mechanics but not the visual layout.
- `SECURITY.md` — document the new control alongside the existing "At-rest encryption" section
  once implemented.
- `electron/db/atRestEncryption.js` — **unchanged** (constraint: this design must not touch the
  staged-OFF default).

## Reused vs. new

**Reused:** the `authorize()` seam and its role/device-trust re-check invariant (no new auth
mechanism); the backup→verify→shred safety shape from `migratePlaintextToEncrypted` (mirrored, not
reinvented); the file-header detection (`isPlaintextSqliteFile`) as the sole source of truth for
current state (no new persisted state variable); the existing type-to-confirm UI convention
(`JoinByCodeScreen.jsx`, `AssignmentPanel.jsx`, `ingest.js`); the existing `recordAuditEvent`
audit-log convention `authorize()` already uses for `users.*` actions.

**New:** `decryptEncryptedToPlaintext` (SQLite) and its `.automerge` equivalent — genuinely new
because no reverse-migration path exists today; the two new `authorize()` action names; the new
IPC handlers and their confirmation-gated renderer surface. Nothing existing covers "safely turn
an encrypted device back to plaintext," which is exactly the gap the owner named.

## ADR required: yes

Filed at `docs/adr/2026-09-28-at-rest-encryption-disable-control.md` (this document). This meets
the ADR bar on all three counts: hard to reverse (a shipped disable path that bricks devices would
be a real incident, and the authorization model, once chosen, is expensive to redo across every
caller); surprising without context (a future reader seeing an admin-gated confirmation-heavy
"disable encryption" screen would reasonably ask why it isn't just a settings toggle — this records
why); and the result of a genuine trade-off among real alternatives (verified reverse-migration vs.
refuse-entirely vs. guided-export, each with different UX/safety costs, decided here).

## Open questions for Governor

1. **Is disable meant to be per-device or camp-wide?** This design assumes per-device (matching
   the per-device key model in `dbEncryptionKey.js`) with confirmation copy that says so
   explicitly. If the owner's actual mental model is "encryption is a camp-level setting," that
   is a product decision this ADR cannot make unilaterally — it would require either a
   cross-device coordination mechanism (rejected here as quorum/consensus scope creep, per
   Candidates) or accepting that "disabled" is genuinely per-device and the UI must say so loudly
   enough that an admin doesn't assume otherwise.
2. **Should the confirmation include a cooling-off delay** (e.g., "disable pending, takes effect
   after N minutes, cancellable")? Divergent ideation surfaced this as a cheap addition on top of
   the verified-migration mechanism, not a replacement for it. This ADR does not include it in the
   baseline design — it is friction on top of an already-safe operation, and karpathy-guidelines
   argues against adding it speculatively. Flagging it as an option the owner may want given the
   "hard to turn off" framing; Maker should not add it without a product decision either way.
3. **Exact PRAGMA form for decrypt-in-place** under `better-sqlite3-multiple-ciphers@12.11.1` needs
   verification against that driver's actual documented behavior before Maker implements step 2 of
   §4 — flagged per `org-source-verification` rather than assumed symmetric with the encrypt
   direction.
4. **Is a settings/security screen for this UI-significant enough to route through Designer**
   before Maker, or is the existing type-to-confirm pattern sufficient precedent to skip a design
   pass? This ADR states copy and mechanics but leaves the visual/screen-placement call to
   Governor.
