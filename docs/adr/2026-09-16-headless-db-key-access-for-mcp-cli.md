---
title: "Headless key access for the MCP server and CLI under at-rest encryption"
document_type: adr
authority: normative
status: accepted
implementation_state: in_progress
date: 2026-09-16
program: security-hardening
affects:
  - scripts/mcp/server.js
  - scripts/mcp/tools.js
  - scripts/ingestCli.js
  - electron/db/localDb.js
---

# Headless key access for the MCP server and CLI under at-rest encryption

**Status: ACCEPTED 2026-09-16.** This resolves flip-blocker #2 recorded in T175: once at-rest
encryption is on, the headless machine-access tools cannot read the database.

## Problem
The MCP server (`scripts/mcp/server.js`) and the ingest CLI (`scripts/ingestCli.js`) run as **plain
Node processes** — the server's own header says so — and every tool calls `openLocalDb(dbPath)` with
no key. The at-rest encryption key is sealed with Electron's `safeStorage` in the OS keychain, which
is **only reachable from an Electron process running as the logged-in user**. So the moment a device's
DB is encrypted, `openLocalDb` in these tools hits an encrypted file with no key and fails (fail-safe:
a clear error, never corruption). That disables the owner's machine-access surface — a genuine
regression, and the reason encryption's default stays OFF until this is closed.

## Options considered
1. **Pass the key on the command line (`--db-key <hex>`).** Simplest, but the key is then visible in
   the process list (`ps`) to any local user — an unacceptable leak for the one secret the whole
   scheme protects. Rejected.
2. **Run the MCP server / CLI under Electron (headless).** They'd get `safeStorage` directly. Correct,
   but a large change to the process model (the MCP stdio transport under an Electron main process),
   turns two small Node tools into Electron apps, and drags Electron into every CLI invocation.
   Heavier than the problem warrants for the common case. Kept as a possible future consolidation, not
   the first step.
3. **A protected key channel + a small Electron unlock helper.** The tools stay plain Node and read
   the key from a channel that is NOT world-visible: an env var (`SHORESH_DB_KEY`, hex) or a
   user-only-readable key file (`SHORESH_DB_KEY_FILE`). The one component that touches the keychain is
   a tiny **Electron unlock helper** that unseals the device key via `safeStorage` and hands it to the
   spawned tool for that run (env for a child it spawns, or a `chmod 600` file it writes and the tool
   deletes after reading). **Chosen.**

## Decision: option 3
- **Consumer side (this slice):** a headless key resolver `resolveHeadlessDbKey()` reads the key from
  `SHORESH_DB_KEY` (hex) or `SHORESH_DB_KEY_FILE`, validates it is 32 bytes, and returns `null` when
  neither is set. The MCP server and CLI resolve it once and thread `{ key }` into every `openLocalDb`
  call. **Default is no key → plaintext open, exactly today's behavior**, so this is inert until
  encryption is enabled and a key is provided — no behavior change ships dark.
- **Producer side (`electron/unlockDbKey.js`):** an Electron unlock helper (run as the logged-in
  user) that calls `getOrCreateDbKey(userDataDir, safeStorage)` and hands the key to the tool. Because
  it runs under the same OS user Electron would, it adds no new trust: anyone who could run it could
  already run the app and read the data.

## Security re-review update (2026-09-16) — env-passing only; `--to-file` removed
`docs/work/security/2026-09-16-headless-key-channel-assessment.md` confirmed the resolver is sound
(no-argv, strict validation, fail-closed all hold) but raised **two HIGH findings against a file
producer mode**: (1) a file write without `O_EXCL` has a symlink/permission window, and (2) nothing
deleted the file, so the unsealed key persisted on disk indefinitely — which negates the exact
offline-theft property `safeStorage` provides. Both are now closed by **removing the file-write mode
entirely** and making **env-passing the primary channel**:
- `--exec -- <command…>` unseals the key and **spawns the tool with `SHORESH_DB_KEY` in the child's
  environment only** — the key never touches disk and never enters the launching shell. This is the
  recommended mode.
- `--print` (hex to stdout) is kept for advanced/manual use; transient and owner-only.
- The helper no longer writes a key file. `resolveHeadlessDbKey` still *accepts* an operator-managed
  `SHORESH_DB_KEY_FILE` (their own secret file, their responsibility) but the helper never creates
  one, so findings 1 & 2 (which were about the helper's write) do not apply.

Confidence: high on the consumer side (a small, inert, testable seam). Medium on the exact producer
ergonomics (env vs short-lived file) — to be settled with the unlock-helper slice and a security
re-review, since key handling is the sensitive part.

## Non-goals / boundary
This does not widen who can read the data: the unlock helper is gated by the same OS-user keychain
access the app itself uses. It does not put a plaintext key on the command line. It does not make the
tools able to read another user's or another device's DB. The dev/test harnesses that deliberately
use plaintext DBs (`make-era-fixtures.mjs`, era fixtures) pass no key and are unaffected.

## Verification
- `resolveHeadlessDbKey` unit-tested (env hex, key file, wrong size, absent → null).
- Threading is inert by default (no key → current plaintext behavior; existing MCP/CLI tests unchanged).
- The end-to-end "encrypted DB opened by the MCP/CLI via the unlock helper" path is verified with the
  real driver on a build environment where it compiles (same constraint as T175), and re-reviewed by
  `security-assessment` before the encryption flag's default flips.
