// At-rest key access for HEADLESS (plain-Node) processes — the MCP server and the ingest CLI
// (ADR docs/adr/2026-09-16-headless-db-key-access-for-mcp-cli.md; flip-blocker #2 of T175).
//
// These processes cannot reach Electron's safeStorage / the OS keychain, so once a device's DB is
// encrypted they have no key. This reads the key from a PROTECTED channel — an env var or a
// user-only-readable file — and NEVER from argv (which is world-visible in `ps`, and this is the one
// secret the whole scheme protects). The Electron "unlock helper" (a later slice) is what puts the
// key on that channel for a single invocation.
//
//   SHORESH_DB_KEY       the 32-byte key as a hex string
//   SHORESH_DB_KEY_FILE  path to a file whose contents are that hex string
//
// Returns null when neither is set → the caller opens the DB plaintext, exactly today's behavior, so
// this is INERT until encryption is enabled and a key is supplied. A present-but-malformed value
// THROWS (fail loud) — a headless run told to use a key must never silently fall back to plaintext.
import fs from 'node:fs'
import { KEY_BYTES } from './dbEncryptionKey.js'

export function resolveHeadlessDbKey({ env = process.env, fsImpl = fs } = {}) {
  let hex = null
  if (env.SHORESH_DB_KEY) {
    hex = String(env.SHORESH_DB_KEY).trim()
  } else if (env.SHORESH_DB_KEY_FILE) {
    hex = fsImpl.readFileSync(env.SHORESH_DB_KEY_FILE, 'utf8').trim()
  }
  if (!hex) return null
  if (!/^[0-9a-fA-F]+$/.test(hex) || hex.length !== KEY_BYTES * 2) {
    throw new Error(
      `resolveHeadlessDbKey: the at-rest key must be exactly ${KEY_BYTES * 2} hex characters ` +
        `(${KEY_BYTES} bytes); got ${hex.length}. Refusing to proceed rather than open plaintext.`
    )
  }
  return Buffer.from(hex, 'hex')
}
