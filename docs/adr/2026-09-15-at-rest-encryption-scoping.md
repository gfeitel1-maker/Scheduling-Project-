---
title: "At-rest encryption of the camp document and SQLite — scoping"
document_type: adr
authority: normative
status: accepted
implementation_state: in_progress
date: 2026-09-15
program: security-hardening
affects:
  - electron/db/localDb.js
  - electron/db/userDataPath.js
  - electron/sync/automerge/docStore.js
  - SECURITY.md
---

# At-rest encryption of the camp document and SQLite — scoping

**Status: ACCEPTED 2026-09-15.** Owner's requirement is unambiguous: the data must be *encrypted*, and the owner has delegated the how ("you can figure it out, I trust you"). DECISION: **app-level encryption** — the camp SQLite is encrypted with a SQLCipher-family driver and the `.automerge` document is encrypted on write, with the key held in the **OS keychain** (macOS Keychain / Windows DPAPI), released only to this app under the logged-in user. This is chosen over relying on OS full-disk encryption because the requirement is that WE encrypt the data, not that it is contingent on a user toggling FileVault. A director passphrase is explicitly rejected (forget it = lose the camp). SAFETY: implemented as a staged, test-first change with a pre-migration backup (`writePreMigrationBackup` already exists) and independent review before it ships — a botched encryption migration must never risk a camp's data. The scoping below records the reasoning.

## What is unencrypted today, and the threat
Each device stores its camp state as **plaintext files on disk**: the SQLite db (`shoresh.sqlite`
under the userData dir) and the Automerge document (`.automerge`). PINs are scrypt-hashed, but
everything else — schedules, names, the whole camp — is cleartext, and the PIN *hashes* replicate
(4-digit space, crackable offline given the file). SECURITY.md states the current trust model
plainly: *"whoever has the document already has the camp's data."*

The threat at-rest encryption addresses is **a lost or stolen device, or a copied file** (a backup,
a synced folder, a discarded laptop) — an *offline* attacker with the bytes but not a running,
unlocked machine. It does **not** address a running unlocked device or a compromised OS account
(the key is available there by definition), and it is orthogonal to the WAN/transit work (Noise
already encrypts in transit).

## The crux: key management, not the cipher
Encrypting the files is easy; **where the key lives decides whether it helps.** If the key sits in
plaintext next to the data, encryption is theater. The real options:

1. **OS full-disk encryption (FileVault / BitLocker), documented — not app code.** The honest
   default for a desktop app. The OS already encrypts the whole disk with a key protected by the
   user's login; our files inherit that. Zero app crypto to get wrong, protects exactly the
   lost/stolen-device case. **Cost:** it's a deployment requirement, not something the app can
   guarantee — a director on a machine with FileVault off is unprotected, and we can only *check and
   warn*, not enforce.
2. **App-level encryption keyed to the OS keychain (macOS Keychain / Windows DPAPI).** Encrypt the
   SQLite db (via SQLCipher) and the `.automerge` file with a key stored in the OS keychain, which
   the OS releases only to this app under this logged-in user. Protects the file-theft case even
   without full-disk encryption. **Cost:** SQLCipher is a native-module swap for `better-sqlite3`
   (real work + the ABI-rebuild dance we already manage); the `.automerge` file needs its own
   encrypt-on-write/decrypt-on-read wrapper in `docStore.js`; and the key is still available to any
   code running as that OS user (so it's file-at-rest protection, not running-process protection).
3. **App-level encryption keyed to a director passphrase entered at launch.** Strongest against a
   stolen device (the key isn't on the device at all). **Cost:** a new passphrase to set, remember,
   and recover — and *lose the passphrase, lose the camp*, which for a non-technical camp director is
   a worse day than the theft it guards against. Recovery/escrow reintroduces a stored key. High UX
   burden for the threat model.

## Decision: option 2 (app-level encryption), with option 1 as a complementary belt
**Chosen: option 2 — app-level encryption keyed to the OS keychain.** The requirement is that the
data *is* encrypted, so it must not depend on the user having toggled FileVault (option 1 alone is
contingent). We still *also* check for and warn about OS full-disk encryption being off (option 1 as
a cheap complementary layer), but the guarantee comes from option 2. **Option 3 (director passphrase)
is rejected** — for this user base, "forget the passphrase = the camp's data is gone" is a worse
outcome than the theft it guards against.

Confidence: high. The only real cost is implementation effort and migration care, both manageable
(see safety below).

## Implementation plan (staged, safe)
1. Swap `better-sqlite3` → a SQLCipher-family driver (`better-sqlite3-multiple-ciphers`), keyed from
   the OS keychain; keep the ABI-rebuild discipline the repo already documents.
2. Encrypt the `.automerge` document on write / decrypt on read in `docStore.js` with the same
   keychain key.
3. Migrate existing plaintext dbs/docs **behind a pre-migration backup** (`writePreMigrationBackup`),
   idempotent, with a test proving a plaintext camp opens, re-encrypts, and reads back identically.
4. Independent review (`security-assessment`) before it ships — a botched encryption migration must
   never risk a camp's data. Ships behind the same discipline as the other auth-core changes.

- Note: at-rest encryption does not change the CRDT trust model between *paired* devices (each holds
  the data by design); it protects a device's bytes at rest from an offline thief, and stops the
  replicated PIN hashes from being crackable off a stolen file.
