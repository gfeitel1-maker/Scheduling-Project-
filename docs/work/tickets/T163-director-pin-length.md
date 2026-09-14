---
title: "Director PINs require 6+ digits; role promotion resets the PIN"
document_type: ticket
status: completed
created: 2026-09-14
task_class: security-auth
governing_docs: [docs/governance/GOVERNANCE_INDEX.md, SECURITY.md]
archive_when: a staff-creation UI screen exists (so its PIN-length copy can be audited too), or the admin-wildcard blast-radius follow-up named below is scoped as its own ticket
---

# T163 — Director PIN length + a dedicated promotion path

**Owner decision (2026-09-14):** DIRECTORS (role `admin`) require a 6+ digit PIN; staff keep 4.
Rationale: `users.pin_hash`/`pin_salt` are modeled document fields that replicate in plaintext to
every approved device, and a 4-digit PIN is only 10,000 offline guesses — the login lockout
(`attemptLogin`'s 5-attempt / 30-second window) does not apply to an attacker working offline
against the replicated file. See the T150 section of `SECURITY.md` for the full threat model this
sits inside.

## What changed

1. **The rule.** `assertValidPin(pin, role)` in `electron/auth/localAuth.js`:
   - digits only (`/^\d+$/`) for both roles — a deliberate widening beyond the original ask. Before
     this ticket, any non-empty string of at most 32 characters passed, so a staff PIN of `"a"` was
     legal despite the UI promising a numeric keypad. Closing that costs nothing extra here and
     removes a UI/server disagreement.
   - `admin` requires length 6..32; `staff` requires length 4..32. One constant
     (`PIN_MIN_LENGTH = { admin: 6, staff: 4 }`), not two copies of "6".
   - `role` was already validated as `'admin'|'staff'` before this check runs, in both
     `createUserHandler` and `bootstrapCamp` (confirmed by reading, not assumed) — so a bogus role
     string can never silently pick the lower floor.
   - The chokepoint is `assertValidPin` inside `createUser`, before any hashing. Renderer validation
     (`CampBootstrapScreen.jsx`) is a UX affordance only; it is never the control.
   - `bootstrapCamp` hardcodes `role: 'admin'` for the very first user and reaches the same check —
     it now rejects a 4-digit admin PIN exactly like `createUserHandler` does.

2. **The role-escalation hole.** The server cannot know a PIN's plaintext length from its scrypt
   hash — that is structural, not an oversight, and is documented inline where it matters
   (`electron/ops/promoteToAdmin.js`). So an admin flipping `users.role` from `staff` to `admin`
   through the generic `write()` IPC handler could silently leave an existing 4-digit staff PIN in
   place behind a newly director-privileged account, defeating the rule above entirely.
   - `write()` (`electron/main.js`) now refuses `entity:'users' field:'role' value:'admin'`
     outright, naming the dedicated handler in the error — mirroring how `IPC_PIN_FIELDS`
     (`electron/ops/pinFields.js`) already blocks `pin_hash`/`pin_salt` from leaving the main
     process on a different boundary (the op-applied/op-conflict IPC push and history reads).
   - A new `promoteToAdmin({ token, userId, newPin })` handler is the only path that may perform the
     promotion. It is admin-gated (action `users.promote`, default-deny for staff since `users` is
     absent from `permissions.js`'s `ENTITIES`), requires a fresh `newPin` that passes
     `assertValidPin(newPin, 'admin')`, and writes the new `pin_hash`/`pin_salt` **atomically with
     the role flip** via `runAtomic` (`electron/ops/operations.js`) — the multi-write job shares one
     rollback boundary across SQLite, the op-log, and the Automerge document.
   - Wired through `electron/preload.js` (`shoresh:promote-to-admin`), `src/localClient.js`, and
     `src/localClient.mock.js` (dev-mode mirror of the same rule), with `electron/main.js`'s
     `HANDLER_CHANNELS` list and `registerHandlers` kept in sync so
     `electron/ipcSurfaceParity.test.js` stays green.

3. **Existing users.** No grandfather path, no login-time refusal — there is no live camp data yet,
   and the owner's standing preference is a clean cutover over back-compatibility shims. `verifyPin`
   deliberately does **not** call the new role-aware `assertValidPin`; it uses a separate
   `assertPinShape` that only checks the pre-existing non-empty/≤32-character shape, so an already
   -stored PIN (of whatever length) keeps logging in. **This answer would change if real camps
   existed** — the compromise then would be a flagged-not-blocked login nudge ("consider a longer
   PIN") rather than a refusal. A future maintainer re-adding grandfathering should read this before
   assuming the current all-or-nothing posture still applies.

4. **UI.** `src/screens/CampBootstrapScreen.jsx` now requires 6+ digits before allowing submission
   (`/^\d{6,}$/`) and states the requirement in the copy, instead of only surfacing the server's
   rejection after a submit round-trip. No dedicated staff-creation screen exists yet in the UI
   (`createUser` is only reachable via `localClient`/`localClient.mock`, not called from any screen)
   — there was nothing else to update.

## What this does and does not fix

Recorded in `SECURITY.md`'s T150 section: raises the offline guess space for a director PIN from
10,000 to 1,000,000 (~100x attacker cost — hours-to-days of offline scrypt work rather than
minutes), which is **not** "safe" on its own. It does nothing about blast radius — `admin` remains an
unconditional wildcard (`PERMISSIONS.admin = ['*']` in `electron/auth/permissions.js`), so cracking
one director's PIN still buys every admin-gated action in the camp. Narrowing that wildcard is a
follow-up the owner has been told about and is **not** built here.

## Tests

- `electron/auth/localAuth.test.js`: admin 5-digit PIN throws, 6-digit passes; staff 3-digit throws,
  4-digit passes (no regression); non-digit PIN throws for both roles; every pre-existing admin
  fixture in this file and in `electron/main.test.js` that used a 4-digit PIN was bumped to 6+
  digits (both the seeding call and any matching `login()` call).
- `electron/main.test.js`: `bootstrapCamp` rejects a 4-digit admin PIN; the generic `write()` path
  refuses `users.role -> 'admin'` and names `promoteToAdmin`, leaving the role unchanged;
  `promoteToAdmin` rejects with no token, rejects for a staff-session caller (admin-only), rejects
  with no `newPin`, and succeeds with a 6-digit `newPin` — role and hash both change, the old PIN no
  longer verifies, and the new PIN logs in as `admin`.
