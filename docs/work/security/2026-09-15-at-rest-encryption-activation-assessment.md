---
title: "At-rest encryption activation/migration — security assessment"
document_type: security-assessment
authority: advisory
status: complete
date: 2026-09-15
assessed_against_commit: 12f03665548940f9f135aa5cb38e95c868704643
program: security-hardening
scope: at-rest-encryption activation + migration seam (docs, SQLite, supply-chain)
affects:
  - electron/db/dbEncryptionKey.js
  - electron/db/docCipher.js
  - electron/db/localDb.js
  - electron/db/projectManager.js
  - electron/sync/automerge/docStore.js
  - electron/sync/automerge/liveDoc.js
  - electron/main.js
  - electron/automerge/rebuildSupportCommand.js
---

# At-rest encryption activation/migration — assessment

Date: 2026-09-15   Assessed against commit: 12f03665

## Boundary verdict
Trusted-LAN boundary: HOLDS. This work does not touch transport; it is orthogonal to the
WAN/DHT gate. It narrows the *at-rest* guarantee for a stolen/copied file. The guarantee is
correctly scoped narrower than "encrypted at rest" (per-OS-user keychain; a same-login
attacker on a shared camp-office Mac is not defended). ADR constraint #4 requires SECURITY.md
to say so — that doc edit is a shipping precondition, not optional.

## Confirmed findings (ranked by leverage)

### 1. Sequencing — activating DOCUMENT encryption alone leaves the named threat OPEN (answers A)
Severity: HIGH (false-guarantee risk) | Confirmed by code trace.
The ADR names the concrete threat as the replicated PIN hashes being "crackable offline given
the file" (ADR lines 24, 79). Those hashes live in the **SQLite** file (users table), NOT in
the `.automerge` document. Encrypting only the document therefore does NOT close the threat the
program exists to close. Shipping "document encryption" and describing the release as "encrypted
at rest" would be a T149-class stale claim.
Recommendation: the two flips may land in separate PRs (document first is the lower-risk slice —
its migration is automatic via docCipher passthrough, no destructive rewrite), BUT no
"encrypted at rest" claim may appear in SECURITY.md or release notes until the SQLite flip has
also shipped. Order: document encryption → SQLite encryption+migration → SECURITY.md claim.

### 2. rebuildSupportCommand cannot distinguish "no file" from "undecryptable" (answers F)
Severity: HIGH | Confirmed by code trace (rebuildSupportCommand.js:117, validateRebuildSource:65).
Line 117 is `fs.existsSync(resolvedDocPath) ? loadAutomergeDoc(...) : null`. Once the document
is encrypted, an undecryptable file (lost/rotated keychain entry) is PRESENT on disk, so
existsSync is true, so loadAutomergeDoc is called — and `docCipher.decrypt().final()` THROWS on
a MAGIC-prefixed buffer under the wrong key (GCM auth failure). That throw propagates out of
validateRebuildSource uncaught; the caller sees a generic error, NOT the `doc === null` "no file"
refusal (line 65). The two cases need OPPOSITE support advice (ADR constraint #2): "no file" =
pair/seed; "undecryptable" = your key is gone, this device's data is NOT_RECOVERABLE, nothing to
rebuild from. Required change: catch the decrypt failure at the load site and surface a distinct
`RebuildRefusalError` for undecryptable, and add a NOT_RECOVERABLE_NOTICE line covering
"both SQLite and document encrypted under a lost key → nothing rebuildable."

### 3. Startup path will hard-fail (correctly) but the crash must be caught and explained (answers D)
Severity: MEDIUM | Confirmed by code trace (main.js:1902 openLocalDb, main.js:2510 loadAutomergeDoc).
This is the codebase's first deliberate hard-fail (ADR §"hard-fail exception"). If the keychain
entry is lost, openLocalDb (once keyed) and loadAutomergeDoc will both throw at launch. That is
the intended behavior, but today main.js:1902 is not wrapped to translate a keyed-open failure
into the "three keys, one event" recovery message. Without that, the director gets a raw crash,
not the humane recovery page the ADR promises. Required: a single catch at the keyed-open seam
that renders the recovery story (ties to ADR constraint #3 / KEY_RECOVERY_STORY.md).

### 4. Mid-migration key loss is the unhandled crash-safety gap (answers D)
Severity: MEDIUM | Confirmed by reading writePreMigrationBackup + openLocalDb migration flow.
writePreMigrationBackup (projectManager.js:151) copies the plaintext file to a `.bak` BEFORE
migration and chmod 600 — good, and it makes the plaintext→encrypted step recoverable IF the
backup survives. But: (a) it is best-effort and swallowed (localDb.js:3067-3071) — a backup
failure proceeds silently into an encrypting migration, exactly the case where you most want to
stop. For the encryption migration specifically, backup failure must be FATAL (refuse to migrate),
not swallowed. (b) The `.bak` is PLAINTEXT and left on disk indefinitely — it reintroduces the
very cleartext-file exposure encryption removes. It must be shredded/removed on confirmed
successful migration, and its existence documented as a transient exposure window. (c) Idempotency:
SQLCipher keys the whole file, so "some data re-encrypted then key lost mid-migration" is not a
partial-plaintext/partial-cipher file — SQLCipher rekey is transactional at the page level, but a
crash between "mint key" and "finish rekey" can leave a file the new key half-applies to. The
migration must verify it can re-open the encrypted file with the key and read a sentinel row
BEFORE deleting the plaintext backup. Recommend: mint key → backup (fatal on failure) → rekey →
verify-read → only then remove plaintext backup.

### 5. Era-fixture plaintext opt-in is a real bypass unless keyed to the fixture, not the API (answers E)
Severity: MEDIUM | Confirmed against ADR constraint #1 + openLocalDb 5 prod call sites.
`openLocalDb(path, { plaintext: true })` as a bare boolean is a bypass primitive: any future code
(or an attacker who can influence a call site) that passes it opens an unencrypted db, and the
"no key ⇒ plaintext" silent fallback the ADR forbids is one refactor away. Keep it narrow:
(a) the flag must NEVER be settable from IPC/renderer input — it is a test-only literal;
(b) the 5 production call sites (main.js:1902/2064/2297, rebuildSupportCommand.js:112/131) must
ALWAYS pass the real key and never the flag — add a lint/grep gate asserting `plaintext: true`
appears only under test/; (c) consider gating the flag behind a `NODE_ENV==='test'` assertion
inside openLocalDb so a packaged build throws if it is ever passed. Note rebuildSupportCommand:131
opens a FRESH db to rebuild INTO — that must be opened ENCRYPTED (with the key), which is easy to
get wrong since it is a brand-new file.

## Open questions (NOT findings — need investigation before confirm/drop)

- Supply-chain provenance of better-sqlite3-multiple-ciphers (answers C): CONFIRMED via `npm view`
  it is at v13.0.3, published 2026-08-07 (actively maintained), depends only on node-addon-api ^8,
  repo git://github.com/m4heshd/better-sqlite3-multiple-ciphers. Its version numbering MIRRORS
  upstream better-sqlite3 (also 13.0.3). CONCERN: this repo pins better-sqlite3 ^12.11.1, so the
  drop-in must be pinned to the matching 12.x line of the fork, not `latest`, to keep the SQLite3
  API/ABI identical. Single-maintainer (m4heshd) = a bus-factor/provenance concern; recommend
  pinning an exact version, committing the integrity hash, and running `npm audit` on the resolved
  tree before merge. NOT yet confirmed: whether the 12.x fork line builds cleanly under this repo's
  electron-rebuild flow, and whether any transitive advisory exists at the pinned version — settle
  by adding it on a branch and running the security gate.
- Does electron `safeStorage` on the shipped macOS target survive an OS keychain reset / Migration
  Assistant transfer? This decides how often the hard-fail actually fires in the field. Settle with
  a hardware test on a restored-from-backup Mac.

## Reader-surface confirmation (answers B)
CONFIRMED complete: exactly three readers of the `.automerge` file exist outside docStore.js —
(1) liveDoc.js (call sites at :200, :207, :304, :423, all already threading docCipher),
(2) main.js:2510, (3) rebuildSupportCommand.js:117. Verified by grepping every docStore importer
and every `.automerge`/loadDoc/saveDoc reference in electron/. campDocument.js's saveDoc/loadDoc
(:339/:342) are the in-memory encode/decode primitives (bytes<->doc), NOT file readers, and
syncNode.js's loadDoc reference is to that in-memory decoder — neither touches disk. No missed
reader. Once the cipher is injected, all three must receive the SAME cipher instance; main.js:2510
and rebuildSupportCommand currently pass none.

## Re-opened tradeoffs
- The plaintext `.bak` from writePreMigrationBackup (see finding 4b): accepted historically as a
  human-accessible safety net under a fully-plaintext model, where a plaintext backup exposed
  nothing the live file didn't. Under encryption that condition no longer holds — the backup is now
  the ONLY plaintext copy. Recommendation: shred on successful migration; do not reopen the
  best-effort/swallowed semantics for the encryption migration specifically (finding 4a).
- "A missing thing must never hard-fail" (codebase-wide invariant): correctly and explicitly
  reopened by the ADR for encryption. Confirmed appropriate — but findings 2 and 3 are the cost of
  that reopening being only half-wired today.

## Summary Score (for Grader)
Security posture: 3 — Foundation (key lifecycle, cipher, injectors) is sound and correctly inert;
activation is safe to proceed IF five gaps are closed before ship: sequence-then-claim (1),
undecryptable-vs-absent in rebuild (2), a caught+explained startup hard-fail (3), fatal-backup +
shred-plaintext + verify-before-delete migration (4), and a non-bypassable test-only plaintext
opt-in with a pinned/audited driver (5).
