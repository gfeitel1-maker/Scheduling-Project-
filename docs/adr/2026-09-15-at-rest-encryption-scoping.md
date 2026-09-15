---
title: "At-rest encryption of the camp document and SQLite — scoping"
document_type: adr
authority: normative
status: proposed
implementation_state: proposed
date: 2026-09-15
program: security-hardening
affects:
  - electron/db/localDb.js
  - electron/db/userDataPath.js
  - electron/sync/automerge/docStore.js
  - SECURITY.md
---

# At-rest encryption of the camp document and SQLite — scoping

**Status: PROPOSED (scoping only).** Owner asked to scope at-rest encryption alongside the WAN work.
This lays out the threat, the options, the key-management crux, and a recommendation — no code.

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

## Recommendation
**Primary: option 1 (rely on OS full-disk encryption) + a startup check that warns when it is off,**
and document it as the at-rest posture in SECURITY.md. It matches the actual threat (offline device
theft), adds no fragile app crypto, and cannot lock a director out of their own camp.

**If that is judged insufficient, option 2 (SQLCipher + keychain) is the next step** — real
protection against a copied file without a passphrase-loss failure mode. I'd treat it as its own
project (native-module swap, `.automerge` wrapper, migration of existing plaintext dbs, and tests),
not a quick add.

**Do not do option 3** unless the owner explicitly accepts "forget the passphrase = the camp's data
is gone," because for this user base that outcome is worse than the threat.

Confidence: high that option 1 is the right *default* and option 3 is wrong for this user base;
medium on whether the owner wants option 2's extra assurance — that's the decision this doc surfaces.

## Consequences / open decision
- If option 1: a small startup check (FileVault: `fdesetup status`; BitLocker: `manage-bde`/WMI) +
  a non-blocking warning + a SECURITY.md paragraph. Cheap.
- If option 2: scope a follow-up ticket for the SQLCipher swap + `.automerge` wrapper + keychain key
  lifecycle + plaintext-db migration. Meaningful effort; its own ADR.
- Either way, note that at-rest encryption does not change the CRDT trust model between *paired*
  devices (each holds the data by design); it only protects a device's bytes at rest from an
  offline thief.

**Decision needed from the owner:** option 1 (OS-FDE + warn) as the posture, or invest in option 2
(app-level SQLCipher + keychain)?
