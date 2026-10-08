// Director-authorized tool connections (docs/adr/2026-10-08-director-authorized-tool-connections.md).
//
// A director names a tool (MCP server / CLI), picks read or read-write, and is shown a per-tool secret
// ONCE. Only the secret's hash is stored. The unlock helper (electron/unlockDbKey.js) will not release
// the at-rest key to a tool that cannot present a live, non-revoked secret.
//
// HONEST LIMIT (owner ruling 2026-10-08, "it's accountability"): this is a governance control —
// explicit, named, listed, revocable, audited — layered on the existing OS-user + keychain boundary.
// It is NOT a cryptographic defense against a process running as the same OS user, which can unseal
// the key itself. Do not describe it as one.
//
// The store is safeStorage-SEALED and lives OUTSIDE the encrypted camp DB, so it is readable at
// key-release time without the camp key (including the app-closed, transient-Electron path).
// audit_events lives INSIDE that DB, so events raised here (tool use / refusal) are queued in the
// sealed store and drained into audit_events by the running app (drainToolAuditEvents).
import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'

export const TOOL_AUTH_FILE = 'tool-authorizations.enc'
export const SCOPES = ['read', 'read-write']
const AUDIT_QUEUE_CAP = 200

export class ToolAuthorizationError extends Error {
  constructor(code, message) {
    super(message)
    this.code = code
  }
}

const NOT_AUTHORIZED_MESSAGE =
  'This tool is not authorized to connect to this camp. Ask the director to authorize it in Connected Tools.'
const REVOKED_MESSAGE =
  "This tool's authorization was revoked. Ask the director to authorize it again in Connected Tools."

const sha256 = (s) => crypto.createHash('sha256').update(s).digest('hex')
// Compared against when the id is unknown, so unknown-id and wrong-secret take the same path.
const DUMMY_HASH = sha256('no-such-tool')

function read(userDataDir, safeStorage, fsImpl) {
  const file = path.join(userDataDir, TOOL_AUTH_FILE)
  if (!fsImpl.existsSync(file)) return { tools: [], audit: [] }
  const parsed = JSON.parse(safeStorage.decryptString(fsImpl.readFileSync(file)))
  return { tools: parsed.tools ?? [], audit: parsed.audit ?? [] }
}

function write(userDataDir, safeStorage, state, fsImpl) {
  if (!safeStorage.isEncryptionAvailable()) {
    throw new Error('Tool authorizations cannot be stored: OS keychain encryption is unavailable.')
  }
  const file = path.join(userDataDir, TOOL_AUTH_FILE)
  const tmp = `${file}.tmp`
  fsImpl.writeFileSync(tmp, safeStorage.encryptString(JSON.stringify({ version: 1, ...state })))
  fsImpl.renameSync(tmp, file)
}

const publicRecord = ({ secret_hash: _h, ...rest }) => rest

function queue(state, event, now) {
  state.audit.push({ ...event, at: now.toISOString() })
  if (state.audit.length > AUDIT_QUEUE_CAP) state.audit.splice(0, state.audit.length - AUDIT_QUEUE_CAP)
}

export function grantToolAuthorization(userDataDir, safeStorage, { label, scope, createdBy = null } = {}, { fsImpl = fs, now = new Date() } = {}) {
  if (typeof label !== 'string' || label.trim().length === 0) throw new Error('A tool name (label) is required')
  if (!SCOPES.includes(scope)) throw new Error(`scope must be one of: ${SCOPES.join(', ')}`)
  const state = read(userDataDir, safeStorage, fsImpl)
  const id = crypto.randomBytes(8).toString('hex')
  const secret = `${id}.${crypto.randomBytes(32).toString('hex')}`
  const record = {
    id,
    label: label.trim(),
    scope,
    created_at: now.toISOString(),
    created_by: createdBy,
    revoked_at: null,
    secret_hash: sha256(secret),
  }
  state.tools.push(record)
  write(userDataDir, safeStorage, state, fsImpl)
  return { authorization: publicRecord(record), secret }
}

export function revokeToolAuthorization(userDataDir, safeStorage, id, { fsImpl = fs, now = new Date() } = {}) {
  const state = read(userDataDir, safeStorage, fsImpl)
  const record = state.tools.find((t) => t.id === id)
  if (!record) throw new Error('Tool authorization not found')
  if (!record.revoked_at) record.revoked_at = now.toISOString()
  write(userDataDir, safeStorage, state, fsImpl)
  return publicRecord(record)
}

export function listToolAuthorizations(userDataDir, safeStorage, { fsImpl = fs } = {}) {
  return read(userDataDir, safeStorage, fsImpl).tools.map(publicRecord)
}

// THE single checkpoint. Every key release goes through here; it re-reads the store on every call
// (never a snapshot), records every outcome, and throws only the two named refusal codes.
export function checkToolAuthorization(userDataDir, safeStorage, secret, { fsImpl = fs, now = new Date() } = {}) {
  let state
  try {
    state = read(userDataDir, safeStorage, fsImpl)
  } catch {
    throw new ToolAuthorizationError('tool-not-authorized', NOT_AUTHORIZED_MESSAGE)
  }
  const presented = typeof secret === 'string' ? secret.trim() : ''
  const dot = presented.indexOf('.')
  const record = dot > 0 ? state.tools.find((t) => t.id === presented.slice(0, dot)) : undefined
  const expected = Buffer.from(record?.secret_hash ?? DUMMY_HASH, 'hex')
  const actual = Buffer.from(sha256(presented), 'hex')
  const matches = crypto.timingSafeEqual(expected, actual) && Boolean(record)

  const refuse = (code, message) => {
    queue(state, { action: 'tool_authorization.use', outcome: 'deny', reason: code, authorization_id: matches ? record.id : null }, now)
    try { write(userDataDir, safeStorage, state, fsImpl) } catch { /* the refusal still stands */ }
    throw new ToolAuthorizationError(code, message)
  }
  if (!matches) return refuse('tool-not-authorized', NOT_AUTHORIZED_MESSAGE)
  if (record.revoked_at) return refuse('tool-authorization-revoked', REVOKED_MESSAGE)

  queue(state, { action: 'tool_authorization.use', outcome: 'allow', reason: null, authorization_id: record.id }, now)
  try { write(userDataDir, safeStorage, state, fsImpl) } catch { /* audit queue is best-effort; the grant is valid */ }
  return { id: record.id, label: record.label, scope: record.scope }
}

export function drainToolAuditEvents(userDataDir, safeStorage, { fsImpl = fs } = {}) {
  const state = read(userDataDir, safeStorage, fsImpl)
  if (state.audit.length === 0) return []
  const events = state.audit
  write(userDataDir, safeStorage, { ...state, audit: [] }, fsImpl)
  return events
}
