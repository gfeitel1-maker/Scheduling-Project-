---
title: "Headless DB key access for the MCP server and CLI (encryption flip-blocker #2)"
document_type: ticket
status: in-progress
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

## Remaining — slice 2: producer side (the Electron unlock helper)
- [ ] A small Electron entry (run as the logged-in user) that unseals the device key via
  `safeStorage`/`getOrCreateDbKey` and puts it on the protected channel for a single tool invocation
  (env for a child it spawns, or a `chmod 600` file the tool reads then deletes). Settle env-vs-file
  ergonomics here.
- [ ] End-to-end: MCP/CLI open an ENCRYPTED DB via the unlock helper, verified against the real
  driver on a build env where it compiles (same constraint as T175 — Apple clang 16 can't build the
  driver for Node 25; verify under a Node-LTS/Electron build).
- [ ] `security-assessment` re-review of the key channel (the sensitive part) before the encryption
  flag's default flips.

## Note
Dev/test harnesses that deliberately use plaintext DBs (`make-era-fixtures.mjs`, `ingest-sweep.mjs`)
pass no key and are unaffected — correct.
