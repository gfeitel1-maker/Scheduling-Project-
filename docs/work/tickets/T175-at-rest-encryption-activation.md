---
title: "At-rest encryption activation — flip on document + SQLite encryption, safely"
document_type: ticket
status: in-progress
created: 2026-09-15
task_class: security-auth
governing_docs: [docs/governance/GOVERNANCE_INDEX.md, docs/adr/2026-09-15-at-rest-encryption-scoping.md, docs/work/security/2026-09-15-at-rest-encryption-activation-assessment.md, docs/current/KEY_RECOVERY_STORY.md]
archive_when: both the document and SQLite files are encrypted at rest on a real device, all five review gaps are closed and test-covered, SECURITY.md states the narrowed boundary, and the change has been real-app verified
---

# T175 — At-rest encryption activation

The foundation is merged and **inert** (key provider #417, document cipher #421, liveDoc cipher seam
#422, rebuild undecryptable refusal). Nothing is encrypted on disk yet. This ticket is the activation:
turning it on, in the reviewed order, with the five gaps closed first.

Success predicate: on a real device, both `shoresh.sqlite` and `<campId>.automerge` are unreadable
without the OS-keychain key; a legacy plaintext device migrates once, safely, behind a verified
backup; no reader is left behind; and SECURITY.md states the (narrower-than-"encrypted-at-rest")
boundary. Non-goals: protecting a running/unlocked machine or a same-OS-login attacker (out of scope
by design — trusted-device model).

## Order is load-bearing (assessment finding 1, HIGH)
The crackable PIN hashes live in the **SQLite** file, not the document. So:
1. Document encryption activation (main.js wiring + readers). Real progress, but does NOT close the
   named threat on its own.
2. SQLite encryption + migration.
3. **Only after step 2** may any "encrypted at rest" claim be made (SECURITY.md, user-facing copy).
Steps 1 and 2 may be separate PRs; the CLAIM may not precede step 2.

## Done so far
- [x] Reader-surface confirmed complete: exactly 3 `.automerge` readers (liveDoc ✅ threaded;
  main.js:2510; rebuildSupportCommand ✅ threaded + undecryptable refusal). campDocument/syncNode are
  in-memory encode/decode, not file readers.
- [x] Finding 2 (rebuild "no file" vs "undecryptable") — closed, test-covered.
- [x] **Document-encryption activation wired + tested, behind a staged flag.** `electron/db/atRestEncryption.js`
  (`SHORESH_AT_REST_ENCRYPTION`, default OFF, exactly-"on" to enable; `acquireDocCipher` fail-closed).
  main.js acquires the cipher, injects it into liveDoc, passes it to the second reader, and surfaces
  the recovery story instead of a raw crash on key failure (finding 3, document side). Provably inert
  when off. Nothing on disk is encrypted until the flag is set for the reviewed real-app rollout.

## SQLite-at-rest thread — CODE COMPLETE + unit-tested; real-crypto verification pending a compatible build env (2026-09-15)
Built, behind the same staged flag (default OFF). What landed:
- `electron/db/sqliteCipher.js` — `rawKeyPragma` (SQLCipher raw-key form, no PBKDF2), `isPlaintextSqliteFile`
  (16-byte header detection, no driver trial-and-error), and `migratePlaintextToEncrypted` with the
  full finding-4 safety: pre-migration backup written FIRST and **fatal on failure**, encrypted copy
  produced via `sqlcipher_export`, **verified by a keyed re-open+read BEFORE** the plaintext original
  is replaced, and the plaintext backup **shredded only on success**; a failed verify aborts leaving
  the original untouched. 8 unit tests (fakes + the regular driver) cover orchestration + detection.
- `openLocalDb(filePath, { key, plaintext })` — keyed path uses the encrypting driver, migrating a
  plaintext file first; the default (no-key) path is unchanged (regular better-sqlite3, static import).
  The encrypting driver is loaded **lazily and only when keyed**, and a usability probe (`ctor(':memory:')`)
  makes an unbuilt driver fail CLOSED with a clear message (finding 5's silent-fallback concern:
  encrypted bytes are unreadable without the key regardless, and a forgotten key is a loud failure).
  `{ plaintext: true }` is the TEST-ONLY opt-in for the committed era fixtures (guards against a keyed
  open migrating/mutating them).
- `main.js` acquires the DB key (`acquireDbKey`) alongside the doc cipher and passes it to all three
  `openLocalDb` call sites; inert when the flag is off.
- `better-sqlite3-multiple-ciphers@12.11.1` added as an **optionalDependency** (exact + integrity in
  the lock, `optional: true`) — pins the engine-matched driver without failing `npm install` where it
  cannot build.
- `electron/db/sqliteCipher.integration.test.js` — end-to-end real-crypto proof (fresh keyed db is
  non-plaintext on disk + reads back; plaintext→encrypted migration preserves data + shreds backup;
  wrong key fails; `{plaintext:true}` does not migrate a fixture). Gated: it SKIPS with a visible
  "driver ABSENT — not a pass" marker where the driver is not usably built.

**VERIFIED UNDER NODE (2026-09-16), and it caught a real bug.** The driver cannot build for Node 25.8.1
here (Apple clang 16 — the only compiler on this Tier-3 Intel Mac, no bottles — cannot compile Node
25's V8 header syntax `ReadExternalPointerField<{...}>` even at `-std=c++20`; regular better-sqlite3
only works via a prebuilt). So the driver was built from source for **node@22.23.2** (whose headers
clang 16 *can* compile) and the real crypto exercised there via a standalone harness
(`scratchpad/verify-sqlcipher.mjs`, run under node@22 to avoid the node@25-ABI regular driver /
openLocalDb). Result: **9/9 real-driver assertions PASS** — fresh keyed db is encrypted on disk +
reads back, wrong key rejected, plaintext→encrypted migration preserves data + shreds the backup,
backup failure fatal.
- **The bug it caught (would have broken every real migration):** the migration used
  `sqlcipher_export()`, which threw *"no such function"* — that is SQLCipher-proper; this driver is
  SQLite3MultipleCiphers, which encrypts a plaintext db IN PLACE via `PRAGMA rekey`. Fixed
  (backup→rekey→verify→shred, restore-from-backup on any failure). The unit tests missed it because
  they used a fake DB; the real driver caught it. This is the whole reason the verification mattered.
- **Toolchain recorded (per review):** verified with node@22.23.2 + better-sqlite3-multiple-ciphers
  12.11.1, built by Apple clang 16. A CI build on a Node-LTS image is a different artifact.
- **Still NOT end-to-end:** this is Node-level proof. It does NOT prove the driver loads under
  **Electron's** ABI — a module-load failure there would be invisible to any Node/Vitest test. That
  Electron-ABI load + a real-app boot with encryption on is part of the real-app verification the
  owner is taking; the committed `sqliteCipher.integration.test.js` runs the same checks on CI where
  the driver builds for the CI runtime.

## Gaps — status
- [x] **Finding 3 — startup hard-fail wrapped.** main.js's key-acquisition block (`acquireDbKey`/
  `acquireDocCipher`) catches a keychain failure and logs the "three keys, one event" recovery guidance
  before any db/doc open, then fails closed — not a raw stack trace. (The keychain-lost case is the
  common one; a corrupt-under-key open still surfaces as a wrapped open error.)
- [x] **Finding 4 — migration safety.** `migratePlaintextToEncrypted` writes the backup FIRST and is
  **fatal on backup failure**, verifies the encrypted copy by a keyed re-open+read BEFORE replacing
  the original, shreds the plaintext backup only on success, and aborts-untouched on a failed verify.
  Idempotent (cleans a prior `.enc-migrate`). Unit-tested.
- [x] **Finding 5 — `{ plaintext: true }` is test-only, AND gated.** It forces the plaintext driver
  even if a key is passed, guarding the committed era fixtures from a keyed open migrating them.
  Production sites pass the real key. **Gate DONE (2026-09-16):** `electron/db/sqliteCipher.test.js`
  ("finding 5 gate") walks `electron/` + `scripts/`, skips `.test.js`, strips line comments, and fails
  if any production line matches `plaintext\s*:\s*true`. On origin/main, 10/10 green. The only real
  `plaintext: true` call sites are the two era-fixture tests; the localDb.js occurrences are the doc
  comment + the `plaintext = false` default param (neither matches). rebuildSupportCommand's fresh-db
  rebuild target — see MCP/CLI below.
- [ ] **Constraint 4 / boundary wording (SECURITY.md).** State the guarantee is narrower than
  "encrypted at rest": per-OS-user keychain; a same-login attacker on a shared office Mac is
  undefended. Land WITH the flip (making the claim), not before. **DRAFTED AND READY (2026-09-16)** —
  drop this into SECURITY.md as part of the flip commit, not before (it makes a claim only true once
  encryption is on):

  > ### At-rest encryption (what it does and does not protect)
  > With at-rest encryption enabled, both the camp document (`<campId>.automerge`) and the local
  > database (`shoresh.sqlite`) are encrypted on disk with a per-device key sealed in the operating
  > system keychain (macOS Keychain via Electron `safeStorage`). The key is never written beside the
  > data.
  >
  > **This defends one specific thing: a powered-off or stolen device.** Someone who takes the
  > hardware, or copies the files off it, cannot read a camp's data without also being able to log in
  > as the same OS user on that machine.
  >
  > **It does NOT defend against:** an attacker who is already logged in as the same OS user (a shared
  > office login is therefore not protected from its own users), a running and unlocked machine, or
  > malware running as that user. It is a trusted-device model, not full-disk encryption and not a
  > defense against a live, authenticated attacker. For a shared machine, use separate OS user
  > accounts — the keychain isolation is per-OS-user.
  >
  > **Recovery:** the key lives only in this device's keychain. If the OS keychain is reset or the
  > device is lost with no other paired device holding a copy, the encrypted data cannot be recovered.
  > See KEY_RECOVERY_STORY.md.
- [x] **Single-device warning precondition — DONE (#424, ba259b9).** Confirmed in shipped origin/main
  by the app-icon-audit session, with two nuances that carry into the flip:
  - `otherDeviceCount` counts SURVIVING copies (`authorized_at IS NOT NULL AND revoked_at IS NULL`),
    not rows — it ignores inert `pairing_status='unknown'` stubs and, critically, revoked devices
    (counting a device the director deliberately cut off would be the worst possible wrong answer).
    Both cases have tests. Don't regress this when the flip touches sync/sidebar surfaces.
  - The copy deliberately says "no second copy to **restore from**", NOT "cannot be recovered", and a
    test asserts the stronger phrase is ABSENT so it can't drift in before encryption exists.
    **FLIP ACTION ITEM:** when encryption goes on, the stronger "cannot be recovered without this
    computer" wording may become warranted — but that is a DELIBERATE copy change bundled INTO the flip
    changeset, with the absence-test updated in the same commit, coordinated with the sidebar surface
    owner. Not a silent edit, and not before the flip lands.

## Real-app Electron verification (2026-09-16) — DONE, and it caught three defects

Ran the app under Electron 43 with `SHORESH_AT_REST_ENCRYPTION=on` against a real (disposable dev)
database. **Result: encryption works end-to-end** — the key is acquired, the plaintext db is migrated
to encrypted (header no longer `SQLite format 3\0`, a pre-migration backup written), and a SECOND
launch reads the encrypted db back with the persisted key and boots with no error. But it only got
there after fixing three things unit tests could never have caught:

1. **FIXED — key acquired before `app.whenReady()`.** `main.js` acquired the safeStorage key at module
   top level (pre-ready). `safeStorage.isEncryptionAvailable()` is **false before ready, true after**
   (probed directly), so encryption failed closed on every real launch. Fixed by wrapping the setup in
   an async IIFE and `await app.whenReady()` after `applyUserDataPath` (which must stay pre-ready for
   setName), before the key acquisition + keyed db open. Unit tests inject an always-available fake
   safeStorage, so only a real Electron run surfaced this.
2. **DEV-FIXED (2026-09-16); packaged verification still owed — the encrypting driver's Electron binary
   must sit where its loader looks.** The fork loads via `require('bindings')('better_sqlite3.node')`,
   which searches `build/Release` and the node-pre-gyp path `lib/binding/node-v<ABI>-<platform>-<arch>/`.
   prebuild-install placed the Electron-ABI binary at `bin/darwin-x64-148/better-sqlite3-multiple-ciphers.node`
   (wrong dir AND wrong name), so `bindings` couldn't find it and the app failed closed.
   **Fix (`scripts/ensure-abi.js`):** the `preelectron:build` step (`ensure-abi.js electron`) now ALSO
   rebuilds the fork when it is installed, via `electron-rebuild -f -w better-sqlite3-multiple-ciphers`,
   which produces `node_modules/better-sqlite3-multiple-ciphers/build/Release/better_sqlite3.node` — the
   exact path `bindings` resolves, mirroring how the non-fork driver already lands. Pure decision
   `decideFork()` + `forkIsInstalled()` unit-tested (5 cases in `scripts/ensure-abi.test.js`); the
   rebuild is NON-FATAL (the fork is an optional dep and encryption is OFF by default — a fork build
   failure must never break the normal keyless build). **Deterministic proof:** ran the fork rebuild
   directly, confirmed the binary appears at `build/Release/better_sqlite3.node` (2.3 MB, Electron ABI,
   exit 0). **STILL OWED before the flip:** a real `electron-builder` packaged run + install to confirm
   the placement SURVIVES packaging (electron-builder's own npmRebuild step must not push it back to
   `bin/…`) — that step re-touches the owner's installed app, so schedule it with the owner.
   **PACKAGED PLACEMENT VERIFIED (2026-09-16) — closed.** Ran `npm run electron:build` (dir target,
   unsigned) on branch claude/security-testing-agent-8e9c63 (which carries the ensure-abi fork arm).
   Inspected `release/mac/Shoresh.app/Contents/Resources/app/node_modules/better-sqlite3-multiple-ciphers/`:
   the Electron-ABI fork binary is present at **`build/Release/better_sqlite3.node`** (the path
   `require('bindings')('better_sqlite3.node')` resolves first) AND at the node-pre-gyp fallback
   `lib/binding/node-v148-darwin-x64/better_sqlite3.node` (v148 = Electron 43 ABI). So the placement
   SURVIVES packaging — electron-builder's npmRebuild + the ensure-abi fork rebuild together land the
   binary where the loader looks, with asar disabled so node_modules is copied raw. This was the last
   code-side flip-blocker verifiable without the owner's machine; it is now closed. What remains needs
   the owner: installing this build + a real-app encryption-on run on their machine (the ticket's
   "real-app verification … must not be skipped").
3. **OPEN (free, local — NOT an Apple Developer ID) — key persistence across app UPDATES.**
   CORRECTION (earlier draft of this finding overstated it): at-rest encryption needs **no Apple
   Developer ID and no Apple account**. It uses `safeStorage`, which stores its master key in an
   ordinary login-keychain item named by app name ("shoresh Safe Storage") — a free, built-in macOS
   facility. Verified: the same installed app, relaunched, reads its key and the encrypted db fine
   while UNSIGNED. What the "different process couldn't decrypt" test actually showed is only that the
   keychain item's ACL is tied to the app's code identity. The one real nuance: after an app UPDATE
   (a rebuild with a different identity), macOS may show a **one-time "allow keychain access" prompt**
   (Always Allow) — a click, never a lockout, no data loss, no cost. To eliminate even that prompt,
   sign the build with a **free self-signed certificate** created locally (Keychain Access →
   Certificate Assistant → Create a Certificate → Code Signing, or `security`), set as
   `mac.identity` — no Apple account. Apple Developer ID / notarization is a **distribution**
   (Gatekeeper) concern for shipping to other Macs, entirely separate from encryption, and is NOT
   required to turn encryption on.

## The flip's real blockers (why the default stays OFF even with the crypto verified)
1. **Real-app (Electron + keychain) verification.** DONE 2026-09-16 (above) — and it produced the
   three findings, one fixed, two open (driver-binary placement in the packaged build; code-signing
   for key persistence).
2. **The headless MCP/CLI surface cannot read an encrypted db.** `scripts/mcp/tools.js` (every tool),
   `scripts/ingestCli.js`, and `rebuildSupportCommand` (its oldDb AND the fresh rebuild target) open
   `openLocalDb` **without a key** — they run as plain Node with no Electron `safeStorage`, so once the
   db is encrypted they hit a keyless open and fail (fail-safe: a clear error, never corruption). The
   owner uses MCP machine-access tools, so enabling encryption **disables those tools against the db**
   until they have a key-access path (its own design question — a headless process getting the sealed
   key partially defeats the keychain model; likely needs the app to hand it over deliberately). This
   was not fully surfaced by the assessment and is a genuine flip precondition. Rebuild's undecryptable
   *document* refusal (finding 2) already handles the doc side; the SQLite side of the MCP surface is
   the open item.

## Supply chain (assessment open question C) — VERIFIED (2026-09-16)
`better-sqlite3-multiple-ciphers` is pinned to **12.11.1** — exact (no `^`/`~`), the matching line to
this repo's `better-sqlite3 ^12.11.1`. Verified: `package.json` optionalDependencies = exact
`"12.11.1"`; `package-lock.json` carries the resolved npmjs URL + a sha512 `integrity` hash;
`npm audit --omit=dev` = **0 vulnerabilities** on the resolved tree; and `electron-rebuild` builds it
cleanly under this repo's flow (the `ensure-abi.js` fork arm + the packaged-build check below both
exercise it). Single maintainer (m4heshd), sole dep node-addon-api, versioning mirrors upstream
better-sqlite3. Remaining supply-chain care is ongoing (re-audit on any bump); the pin itself is settled.

## Verification (both required before ship)
- Full suite green under the new SQLite driver (openLocalDb is opened by ~270 test files) + the
  `SHORESH_TEST_SCRYPT_N=1024` fast path.
- **Real-app verification**: the packaged/electron:dev app boots with encryption on, loads its camp
  document and db, syncs with a peer, and a legacy plaintext camp migrates once and reads back
  identically. This cannot be proven by unit tests alone and must not be skipped.
- Independent re-review (`security-assessment`) of the migration diff before merge.

## Open question needing a hardware test
Does `safeStorage` survive an OS keychain reset / Migration Assistant transfer? Determines how often
the hard-fail fires. Needs a restored-Mac test (owner-side).
