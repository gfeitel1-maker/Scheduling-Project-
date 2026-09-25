---
title: "Headless DB key access for the MCP server and CLI (encryption flip-blocker #2)"
document_type: ticket
status: completed
created: 2026-09-16
task_class: security-auth
governing_docs: [docs/governance/GOVERNANCE_INDEX.md, docs/adr/2026-09-16-headless-db-key-access-for-mcp-cli.md, docs/work/tickets/T175-at-rest-encryption-activation.md]
archive_when: the MCP server and ingest CLI can open an encrypted DB via the unlock helper, verified against the real driver, and security-assessment has re-reviewed the key channel
---

# T179 — Headless DB key access for the MCP server and CLI

Closes flip-blocker #2 from [[T175]]: the headless machine-access tools run as plain Node with no OS
keychain access, so they cannot read an encrypted DB. Design in
`docs/adr/2026-09-16-headless-db-key-access-for-mcp-cli.md` (option 3: protected key channel + a small
Electron unlock helper).

## Done — slice 1: consumer side (inert by default)
- [x] `electron/db/headlessDbKey.js` — `resolveHeadlessDbKey()` reads the 32-byte key from
  `SHORESH_DB_KEY` (hex) or `SHORESH_DB_KEY_FILE`, NEVER argv; returns null when neither is set
  (→ plaintext, today's behavior); throws on a malformed value (never silently plaintext). 7 unit tests.
- [x] MCP server (`scripts/mcp/server.js`) resolves the key once into the tool ctx.
- [x] All MCP tools (`scripts/mcp/tools.js`) thread `{ key: dbKey }` into `openLocalDb`; the ingest
  tools pass `dbKey` into `runIngestCli`; the rebuild tool builds the doc cipher from the key and
  passes both `key` + `cipher` to `rebuildProjectionFromDocumentAtPath`.
- [x] `rebuildProjectionFromDocumentAtPath` accepts `key` and threads it to both its `openLocalDb`
  opens (old + fresh rebuild target).
- [x] `runIngestCli` accepts `dbKey` and threads it to its `openLocalDb`.
- [x] Provably inert: 63 MCP/CLI/rebuild/resolver/cipher tests green with no key (unchanged behavior).

## Slice 2: producer side (the Electron unlock helper)
- [x] `electron/unlockDbKey.js` — an Electron entry (run as the logged-in user) that unseals the
  device key via `safeStorage`/`getOrCreateDbKey` and emits it on the protected channel:
  `--print` (hex to stdout, for `SHORESH_DB_KEY="$(...)"`) or `--to-file <path>` (a `0600` file, for
  `SHORESH_DB_KEY_FILE`). `npm run unlock-key`. The emit/argv logic is pure + unit-tested (6 tests);
  the safeStorage glue runs only when the file is the Electron entry point (never under vitest).
- [x] Adds no new trust — same OS-user keychain access the app itself uses.

## Remaining
- [x] **End-to-end verified (2026-09-16, under node@22 + the real driver).** The MCP tool handlers
  (`setupSummaryTool`/`listEntitiesTool`) and `resolveHeadlessDbKey` were exercised against a REAL
  encrypted DB via a standalone harness (`scratchpad/e2e-headless-encrypted.mjs`): 7/7 —
  encrypted-on-disk after keyed open; a tool WITHOUT the key cannot read it (fail-closed); a tool
  WITH the key (and with the key from `resolveHeadlessDbKey`'s env channel) reads it. Node-level
  proof; the driver also builds for Electron's ABI (T175 packaged build), so the Electron path holds.
- [x] `security-assessment` re-review done (`docs/work/security/2026-09-16-headless-key-channel-assessment.md`):
  resolver sound (no-argv, strict validation, fail-closed all CONFIRMED); **two HIGH findings against
  the file producer mode** — no `O_EXCL` (symlink/perm window) and the key file was never deleted
  (unsealed key persisted on disk, defeating safeStorage's offline-theft property). **Both closed** by
  removing `--to-file` entirely and making env-passing (`--exec`, key only in the spawned child's env,
  never on disk) the primary channel; `--print` kept for advanced use. 7 helper tests updated.
- [x] SECURITY.md boundary wording landed (the narrower-than-"encrypted-at-rest" guarantee, framed as
  implemented-but-off) — T175 constraint 4.

## Note
Dev/test harnesses that deliberately use plaintext DBs (`make-era-fixtures.mjs`, `ingest-sweep.mjs`)
pass no key and are unaffected — correct.

## CLOSED 2026-09-25 — all three archive_when conditions met in shipped code

Verified against the tree (not the ticket prose) on 2026-09-25:

- **Headless open of an encrypted DB works without a PIN.** The Electron unlock helper
  (`electron/unlockDbKey.js`, `--exec` mode) unseals the per-device key via `safeStorage` /
  `getOrCreateDbKey` — OS-user keychain access, no interactive PIN — and hands it to the spawned
  headless process in its env only. The MCP server (`scripts/mcp/server.js`) resolves it once via
  `resolveHeadlessDbKey` and threads `{ key: dbKey }` into every `openLocalDb`; the ingest CLI
  (`scripts/ingestCli.js`) threads `dbKey` the same way. `electron/db/headlessDbKey.test.js` +
  `electron/unlockDbKey.test.js` — 14/14 green (2026-09-25).
- **Verified against the real driver** — slice-3 e2e harness, node@22 + the real driver, 7/7 (recorded above).
- **security-assessment re-reviewed the key channel** —
  `docs/work/security/2026-09-16-headless-key-channel-assessment.md`; the two HIGH file-producer
  findings were closed by removing `--to-file` and making `--exec` (key in the child env only, never
  on disk) the primary channel.

**Effect beyond this ticket:** T179 no longer blocks T175 (turn on at-rest encryption). T175 remains
the owner's gated decision; this ticket only clears its named flip-blocker #2.

**One field caveat, recorded for the owner, deliberately NOT fixed here (out of scope):** after the
T175 flip, a headless caller that *fails to obtain* the key passes `key: null`, which
`openLocalDb` (`electron/db/localDb.js:3903`) routes to the plaintext driver. Against an encrypted
file that fails on first access — so it fails in the safe direction (no silent plaintext read of
encrypted bytes) — but surfaces as an opaque SQLite error rather than a named "could not obtain the
database key". A small, optional legibility fix if the owner wants it; logged as a board card.

