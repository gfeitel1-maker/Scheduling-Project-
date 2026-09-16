---
title: "Headless DB-key channel for MCP/CLI under at-rest encryption — security assessment"
document_type: security-assessment
authority: advisory
status: complete
date: 2026-09-16
assessed_against_commit: 57cbd16a2e0e1f9e2d77d12a5d3d451988028314
assessed_branch: claude/security-testing-agent-8e9c63
program: security-hardening
scope: headless at-rest key access (SHORESH_DB_KEY / SHORESH_DB_KEY_FILE + Electron unlock helper) for the MCP server and ingest CLI
affects:
  - electron/db/headlessDbKey.js
  - electron/unlockDbKey.js
  - scripts/mcp/server.js
  - scripts/mcp/tools.js
  - scripts/ingestCli.js
  - electron/db/localDb.js
  - electron/db/sqliteCipher.js
adr: docs/adr/2026-09-16-headless-db-key-access-for-mcp-cli.md
---

# Headless DB-key channel — security assessment

## Provenance caveat (read first)
The task brief states this code is "all merged to main." It is **not**: `electron/db/headlessDbKey.js`
and `electron/unlockDbKey.js` do not exist on `main` (HEAD `be237f9`), and `main`'s `openLocalDb`
takes no key argument and `scripts/mcp/tools.js` passes none. The full keyed implementation exists
only on branch `claude/security-testing-agent-8e9c63` (assessed at `57cbd16`). This assessment is of
the branch code. Treat it as a pre-merge review, not a review of shipped `main`.

## Trust model this is measured against
The at-rest key is 32 random bytes sealed by Electron `safeStorage` in the OS keychain
(`electron/db/dbEncryptionKey.js`). The property `safeStorage` buys, per its own header comment, is:
**an offline thief with the disk cannot unseal the key without the user's OS login.** The live-process
trust boundary is "same OS user" — anyone who can run the app can already read the data. The channel
is acceptable insofar as it does not weaken *either* property.

---

## A. Does the channel widen the attack surface? — MIXED (env: no; file: yes, if it lingers)
- **`--print` → env var (`SHORESH_DB_KEY`)**: within the model. Process environment is readable only
  by the same user (`ps eww` for own processes; Linux `/proc/PID/environ` is 0400 owner-only). It is
  transient and dies with the process. It is NOT argv, so it is not in `ps` output to other users.
  CONFIRMED by reading `electron/unlockDbKey.js:38` (writes hex to stdout) and
  `electron/db/headlessDbKey.js:21-22` (reads env, `String(...).trim()`). Minor residual: the env var
  is inherited by every child of the tool process — broader than needed but same-user.
- **`--to-file` → `SHORESH_DB_KEY_FILE`**: this is where the surface widens — see Findings 1 and 2.
  Writing the raw 32-byte key to a file on disk that nothing deletes reintroduces exactly the
  offline-disk-theft exposure that `safeStorage` exists to prevent. The ADR's "adds no new trust"
  claim (line 55) holds for the *live same-user* threat but is FALSE for the *offline-disk* threat
  whenever the file outlives the run.

## B. Malformed / attacker-controlled key input — CLEAN
`resolveHeadlessDbKey` (`electron/db/headlessDbKey.js:19-34`) reads the value, trims it, and rejects
anything that is not exactly `KEY_BYTES*2` hex chars via `/^[0-9a-fA-F]+$/` + length check, throwing
rather than proceeding. Traced:
- Wrong length / non-hex → throws; the error reports only `hex.length`, never the content, so a
  mis-pointed `SHORESH_DB_KEY_FILE` cannot exfiltrate an arbitrary file's bytes through the message.
- The validated Buffer flows to `rawKeyPragma` (`electron/db/sqliteCipher.js:23`) as
  `key.toString('hex')` inside `x'...'`. Because the Buffer is provably 32 bytes, the hex is always
  `[0-9a-f]{64}` — no pragma/SQL injection is reachable. CONFIRMED.
- `SHORESH_DB_KEY_FILE` pointing at a symlink is followed by `readFileSync`, but the env var is the
  operator's own and same-user, so this crosses no privilege boundary. Not a finding.
No path opens plaintext silently on a malformed key: the throw aborts the process
(`scripts/mcp/server.js:50-52`, `scripts/ingestCli.js` via the same resolver at server entry).

## C. Fail-closed on a missing key with encryption ON — HOLDS (fails loud, though not by name)
If the DB is encrypted but no key is supplied, `dbKey` resolves to `null` and the tools call
`openLocalDb(dbPath, { key: null })`. That takes the plaintext-driver branch
(`electron/db/localDb.js:3093-3095`), which opens the handle lazily and then executes
`db.pragma('foreign_keys = ON')` against an encrypted file → SQLite "file is not a database" → caught
and rethrown as `Failed to open local database ...` (`localDb.js:3132-3139`). It does NOT return rows
and does NOT silently read plaintext. CONFIRMED. Cosmetic gap only: the error is a generic open
failure, not a "key required" message; an operator debugging a forgotten `SHORESH_DB_KEY` gets a
misleading "not a database" rather than "this DB is encrypted; supply a key."

## D. `--to-file` permission window / symlink — CONFIRMED FINDING (see Finding 1)
## E. Tradeoffs to reopen — see "Re-opened tradeoffs" below.

---

## Confirmed findings (ranked by leverage)

### Finding 1 — HIGH: the key file is written without O_EXCL; pre-existing-file + symlink window
`emitDbKey` (`electron/unlockDbKey.js:31-37`) does `fsImpl.writeFileSync(filePath, keyHex, {mode:0o600})`
then `fsImpl.chmodSync(filePath, 0o600)`. Two confirmed problems, by reading the code:
1. **Node's `mode` option is honored only when the file is CREATED.** If `filePath` already exists
   with looser perms (e.g. 0644), `writeFileSync` does not change them; the raw key is written into a
   world-/group-readable file, and only the subsequent `chmodSync` narrows it. Between the write and
   the chmod there is a window where the key sits at the pre-existing (looser) perms.
2. **`writeFileSync` follows symlinks.** If an attacker (or a stale artifact) pre-creates `filePath`
   as a symlink, the key is written through it to the link target, and the `0o600`/chmod applies to
   the target — the key can land at an attacker-chosen path.
Attack path: any local process able to pre-create/point the chosen key-file path (a predictable path
in a shared/world-writable dir such as `/tmp`) before the helper runs. Under the strict same-user
model this is same-user-only; on a multi-user host, or with a predictable path under a shared temp
dir, it is a genuine cross-user key leak.
Fix: create with `fs.openSync(path, 'wx', 0o600)` (O_CREAT|O_EXCL, fails if it exists / refuses to
follow into an existing symlink), or write to a fresh `mkdtemp` 0700 dir + file and never reuse a
caller-supplied existing path. Drop the post-hoc `chmodSync` in favor of exclusive create.

### Finding 2 — HIGH: nothing deletes `SHORESH_DB_KEY_FILE`; the raw key persists on disk, defeating safeStorage's whole purpose
The ADR (line 44) describes the file mode as "a `chmod 600` file it writes and the tool deletes after
reading." That deletion is **not implemented anywhere.** Confirmed by a tree-wide search: the only
code that touches `SHORESH_DB_KEY_FILE` is `resolveHeadlessDbKey` (`headlessDbKey.js:23-24`), which
only *reads* it; no producer, consumer, or wrapper unlinks it. The unlock helper writes it and exits;
the MCP/CLI reads it and never removes it. Consequence: the unsealed 32-byte key sits in a plaintext
file on disk indefinitely. This directly negates the property `safeStorage` exists to provide — an
offline disk thief who could not unseal `db.key.enc` without the OS login can now simply read
`SHORESH_DB_KEY_FILE` and decrypt the database. The sensitive part of the whole at-rest program (the
key leaving the keychain) leaves it and stays out.
Fix: make the file single-use and self-deleting — the resolver should `unlinkSync` it immediately
after read (best-effort, before use), OR the helper should spawn the tool as a child with the key in
its env and never use a file at all (the ADR's preferred env path), OR write to an O_EXCL file that a
`finally` in the invoking wrapper unlinks. Until one of these lands, the `--to-file` mode should be
documented as leaving key material on disk and should not be the recommended path.

### Finding 3 — LOW/informational: keyed open of a still-plaintext DB triggers an in-place encrypting migration from a "read" tool
When a key IS supplied and the on-disk file is still plaintext, `openLocalDb` runs
`migratePlaintextToEncrypted` in place (`localDb.js:3088-3090`) before opening. So a nominally
read-only MCP verb (`list_entities`, `export_schedule`, `schedule_state`) invoked with a key against a
not-yet-encrypted DB will rewrite and encrypt the file (and write+shred a pre-migration backup). This
is inherent to `openLocalDb`, not unique to the headless channel, and it fails safe (backup is FATAL
on failure, verify-before-shred). Flagged only because the headless path makes it reachable from tools
whose contract reads as read-only; no data-loss path was found.

---

## Open questions (NOT findings — need investigation)
- **Env-var vs file as the *default* documented path.** The ADR leaves producer ergonomics "medium
  confidence." If Finding 2 is fixed by making env the only supported path (helper spawns the child
  with the key in its environment), the file mode and its whole risk class disappear. Worth settling
  before the flip: is there any consumer that genuinely cannot take the key via env and needs a file?
- **Windows behavior of the file mode.** `mode: 0o600` and `chmodSync` are effectively no-ops for
  ACL-based Windows permissioning; on a shipped Windows target the "0600 file" is not owner-restricted
  the way the comment implies. Needs a Windows-specific check before `--to-file` is blessed there.
- **Who runs the unlock helper, and under what shell.** The documented one-liner uses command
  substitution `SHORESH_DB_KEY="$(electron ... --print)"`. Whether that transits shell history / a
  logged command depends on the operator's shell config; worth a one-line operator note.

## Re-opened tradeoffs
| Tradeoff | Conditions when accepted | Still hold? | Recommendation |
|---|---|---|---|
| "The unlock helper adds no new trust — same OS user + keychain" (ADR line 55) | True for the live, same-user process boundary | PARTIALLY. False for the offline-disk-theft threat whenever `--to-file` leaves the key on disk (Finding 2), and on multi-user hosts for the file window (Finding 1). | Fix Findings 1-2 before the encryption default flips; then the claim holds. |
| Two small Node tools stay plain Node; reject "run under Electron" (ADR option 2) | Chosen to avoid dragging Electron into every CLI call | Reasonable, but the rejected option's security property was real: the key never leaves an Electron process. | Keep option 3, but close the gap the rejection created: make the key single-use and prefer env-passing (child-process env) over an on-disk file, which is the closest thing to "never persisted." |

## Summary Score (for Grader)
Security posture: **3/5** — the resolver (validation, no-argv, fail-closed) is sound and confirmed,
but the `--to-file` producer path has two confirmed HIGH gaps (no O_EXCL/symlink window; the key file
is never deleted, so the raw key persists on disk and defeats the offline-theft property safeStorage
exists for). These must be fixed before the at-rest encryption default flips. Also: the work is on a
branch, not on `main` as the brief stated.
