---
title: "Name the at-rest key-acquisition failure at the openLocalDb seam"
document_type: ticket
status: in-progress
created: 2026-09-25
task_class: security-auth
governing_docs: [docs/governance/GOVERNANCE_INDEX.md, docs/adr/2026-09-15-at-rest-encryption-scoping.md, docs/adr/2026-09-16-headless-db-key-access-for-mcp-cli.md, docs/work/tickets/T175-at-rest-encryption-activation.md, SECURITY.md]
archive_when: openLocalDb throws a named db_key_unavailable error (not an opaque SQLite error) when at-rest encryption is enabled and no key is supplied, a non-vacuous test pins the specific code/message (red without the guard, green with it), and the guard is confirmed inert with encryption off and on the interactive main.js path
---

# T260 — Name the at-rest key-acquisition failure

## Why
With at-rest encryption ON, `openLocalDb(filePath, { key })` opens the encrypting driver only when a
key is passed. A caller that reaches the seam with **no key** (`key = null`) while encryption is
enabled falls through to the plaintext driver `new Database(filePath)`. Against an already-encrypted
file that dies later, on first access, with an opaque SQLite error ("file is not a database") — the
right *outcome* (the data is not read) reached by the *wrong route* (nothing was refused; it simply
could not read). The keyless headless callers (`scripts/mcp/tools.js`, `scripts/ingestCli.js`,
`electron/automerge/rebuildSupportCommand.js`) are exactly the ones that can arrive here without a
key once the production default flips, via `resolveHeadlessDbKey()` returning null when neither
`SHORESH_DB_KEY` nor `SHORESH_DB_KEY_FILE` is set (ADR 2026-09-16).

The owner's instruction: "explicitly name the failure so someone knows what's going on."

## What (surgical)
In `openLocalDb`, **before any open attempt**, when `isAtRestEncryptionEnabled()` is true AND the key
is null/absent AND `plaintext !== true`, throw a named error:
- `err.code = 'db_key_unavailable'`
- message: names that the at-rest encryption key could not be obtained for this open, and points at
  the recovery story (`docs/current/KEY_RECOVERY_STORY.md`).

This is a **refusal decision at the open seam**, not a relabelling of the downstream opaque error, so
it stays correct even if the plaintext branch is later changed. It is a no-op when encryption is off
(the flag defaults off), so the ~270 keyless test opens and today's plaintext runtime are unchanged.

### Relationship to assessment finding 3 (main.js interactive path)
Finding 3 wraps *key acquisition* in `main.js` (`acquireDbKey`/`acquireDocCipher`): when the OS
keychain throws, the director gets the "three keys, one event" recovery message and the app fails
closed. That path passes a **non-null** key to `openLocalDb` when encryption is on, so this guard is
inert there. The two are complementary: finding 3 = "the keychain failed to yield a key" (interactive
app); T260 = "no key was provided to this open at all, but encryption is on" (headless callers and any
future caller). No `main.js`/`preload.js` edit is required.

## Intended coarseness — fail-closed regardless of on-disk format (stated, not silent)
The guard fires BEFORE any file inspection, so with the flag on and no key it refuses even a genuine,
still-plaintext SQLite file, not only an encrypted one. This is deliberate and matches the owner's
Stage-3 fail-closed decision: a keyless caller must not silently read or write a plaintext database
once encryption is the policy. Consequence to name plainly: once the production default flips, a
headless MCP/CLI invocation with no `SHORESH_DB_KEY` is refused (by name) even against a file that
happens to still be plaintext — the caller must obtain a key via the unlock helper (ADR 2026-09-16).
The interactive app is unaffected: it passes a real key and migrates the plaintext file to encrypted
on first launch, so the "flag on + plaintext file" state is transient there. This behavior is
test-pinned (see below). The alternative reading — sniff the header and allow a keyless plaintext
open when the flag is on — was rejected: it reintroduces exactly the silent-plaintext path the flag
exists to forbid.

## Non-vacuity (mandatory)
A test that asserts only "an error was thrown" passes in both worlds and proves nothing. The test must:
- (a) assert the SPECIFIC `db_key_unavailable` code and that the message names the key/recovery;
- (b) demonstrate that REMOVING the guard makes the test go RED — without it, encryption-on + null key
  either opens plaintext silently (no throw) or dies with the opaque SQLite error, not the named one;
- (c) demonstrate that WITH the guard, encryption-on + null key yields the NAMED error, before any
  open attempt (no dependency on the encrypting driver, which does not build under Node 25 here).

## Verification
- `electron/db/localDb.test.js` (or the encryption-focused sibling) covers the three points above.
- Guard confirmed inert with the flag off (full keyless suite green) and on the interactive path
  (main.js passes a real key when enabled).
- `node scripts/check-governance.js` green (after `npm run index:work` / `/update-state` regen).
- Test hazard to respect: `isAtRestEncryptionEnabled()` reads the env var ONCE at atRestEncryption
  import, so every guard test must set `SHORESH_AT_REST_ENCRYPTION`, then `vi.resetModules()`, then
  dynamically `import('./localDb.js')` — a static import would read a stale flag. The finding-5
  `plaintext: true` gate lives in `electron/db/sqliteCipher.test.js` ("finding 5 gate"), not in
  check-governance/verify.
