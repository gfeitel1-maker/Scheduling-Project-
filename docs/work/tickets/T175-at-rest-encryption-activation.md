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

## Gaps to close BEFORE the flip
- [ ] **Finding 3 (MEDIUM) — startup hard-fail is uncaught.** A lost keychain makes `openLocalDb`
  (main.js:1902) and `loadAutomergeDoc` (main.js:2510) throw at launch — intended, but today a raw
  crash. Wrap into the "three keys, one event" recovery message (KEY_RECOVERY_STORY.md), not a stack trace.
- [ ] **Finding 4 (MEDIUM) — migration safety.** `writePreMigrationBackup` is best-effort/swallowed
  (localDb.js:3067-3071); for the encryption migration, backup failure must be **fatal**. The `.bak`
  is the only plaintext copy — must verify a key-read of the encrypted result BEFORE deleting the
  plaintext backup, and shred the `.bak` on success. Migration must be idempotent + crash-safe.
- [ ] **Finding 5 (MEDIUM) — era-fixture `{ plaintext: true }` opt-in is a bypass primitive.** Must
  be test-only and unreachable from IPC/renderer. All 5 production `openLocalDb` sites always pass
  the real key. Add a gate asserting `plaintext: true` appears only under `test/`. Note
  rebuildSupportCommand.js:131 opens a *fresh* db to rebuild into — that must be opened encrypted
  once SQLite encryption is on.
- [ ] **Constraint 4 / boundary wording.** SECURITY.md must state the guarantee is narrower than
  "encrypted at rest": per-OS-user keychain; a same-login attacker on a shared office Mac is
  undefended (T149 stale-claim lesson, applied up front). Land with step 3, not before.
- [ ] **Single-device warning is a precondition.** The sidebar single-device warning (owned by the
  app-icon-audit session, `syncStatusLabel`/`getSyncStatus`) must land BEFORE the flip — the
  "pair a second device" advice is only useful while the data is still recoverable.

## Supply chain (assessment open question C)
`better-sqlite3-multiple-ciphers` v13.0.3 (2026-08-07, sole dep node-addon-api ^8, single maintainer
m4heshd, versioning mirrors upstream better-sqlite3). This repo pins `better-sqlite3 ^12.11.1`, so the
fork must be pinned to the **matching 12.x line**, exact-versioned, integrity-hashed, `npm audit`-clean
on the resolved tree, and confirmed to `electron-rebuild` cleanly under this repo's flow. Settle on a
branch through the security gate before adopting.

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
