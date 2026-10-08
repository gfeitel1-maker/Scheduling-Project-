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
  const at = now.toISOString()
  if (event.outcome === 'deny') {
    const same = state.audit.find(
      (e) => e.outcome === 'deny' && e.action === event.action && e.reason === event.reason && e.authorization_id === event.authorization_id
    )
    if (same) {
      same.count = (same.count ?? 1) + 1
      same.last_at = at
      return
    }
  }
  state.audit.push({ ...event, at, count: 1, first_at: at, last_at: at })
  while (state.audit.length > AUDIT_QUEUE_CAP) {
    const i = state.audit.findIndex((e) => e.outcome === 'deny')
    state.audit.splice(i === -1 ? 0 : i, 1)
  }
}

const LOCK_SUFFIX = '.lock'
const LOCK_RETRY_MS = 25
const LOCK_TIMEOUT_MS = 2000
const LOCK_STALE_MS = 10000

function sleep(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms)
}

const lockToken = (fsImpl, file) => {
  try { return JSON.parse(fsImpl.readFileSync(file, 'utf8')).token } catch { return undefined }
}

// Moves a stale lock aside atomically (only one waiter's rename can win), then checks it really was
// the stale lock this waiter judged; if a live lock was swapped in meanwhile it is put back.
function breakStaleLock(fsImpl, lock, token) {
  const seen = lockToken(fsImpl, lock)
  if (Date.now() - fsImpl.statSync(lock).mtimeMs <= LOCK_STALE_MS) return false
  const aside = `${lock}.${token}.stale`
  fsImpl.renameSync(lock, aside)
  if (lockToken(fsImpl, aside) !== seen) {
    try { fsImpl.linkSync(aside, lock) } catch { /* someone else holds it now */ }
  }
  fsImpl.unlinkSync(aside)
  return true
}

// The unlock helper runs in a separate process, so every read-modify-write of the sealed store takes
// this cross-process lock and re-reads inside it; otherwise a late write-back can undo a revoke.
function updateStore(userDataDir, safeStorage, mutate, { fsImpl = fs } = {}) {
  const lock = path.join(userDataDir, TOOL_AUTH_FILE + LOCK_SUFFIX)
  const deadline = Date.now() + LOCK_TIMEOUT_MS
  const token = crypto.randomBytes(8).toString('hex')
  let fd
  for (;;) {
    try {
      fd = fsImpl.openSync(lock, 'wx')
      break
    } catch (err) {
      if (err.code !== 'EEXIST') throw err
      try {
        if (breakStaleLock(fsImpl, lock, token)) continue
      } catch { /* lock vanished; retry */ }
      if (Date.now() >= deadline) {
        throw new ToolAuthorizationError('tool-auth-store-busy', 'The tool authorization store is busy. Try again.')
      }
      sleep(LOCK_RETRY_MS)
    }
  }
  try {
    fsImpl.writeSync(fd, JSON.stringify({ pid: process.pid, at: Date.now(), token }))
    fsImpl.closeSync(fd)
    const state = read(userDataDir, safeStorage, fsImpl)
    const result = mutate(state)
    write(userDataDir, safeStorage, state, fsImpl)
    return result
  } finally {
    if (lockToken(fsImpl, lock) === token) {
      try { fsImpl.unlinkSync(lock) } catch { /* already gone */ }
    }
  }
}

export function grantToolAuthorization(userDataDir, safeStorage, { label, scope, createdBy = null, id = crypto.randomBytes(8).toString('hex') } = {}, { fsImpl = fs, now = new Date() } = {}) {
  if (typeof label !== 'string' || label.trim().length === 0) throw new Error('A tool name (label) is required')
  if (!SCOPES.includes(scope)) throw new Error(`scope must be one of: ${SCOPES.join(', ')}`)
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
  updateStore(userDataDir, safeStorage, (state) => { state.tools.push(record) }, { fsImpl })
  return { authorization: publicRecord(record), secret }
}

export function revokeToolAuthorization(userDataDir, safeStorage, id, { fsImpl = fs, now = new Date() } = {}) {
  return updateStore(userDataDir, safeStorage, (state) => {
    const record = state.tools.find((t) => t.id === id)
    if (!record) throw new Error('Tool authorization not found')
    if (!record.revoked_at) record.revoked_at = now.toISOString()
    return publicRecord(record)
  }, { fsImpl })
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
    const event = { action: 'tool_authorization.use', outcome: 'deny', reason: code, authorization_id: matches ? record.id : null }
    try { updateStore(userDataDir, safeStorage, (s) => queue(s, event, now), { fsImpl }) } catch { /* the refusal still stands */ }
    throw new ToolAuthorizationError(code, message)
  }
  if (!matches) return refuse('tool-not-authorized', NOT_AUTHORIZED_MESSAGE)
  if (record.revoked_at) return refuse('tool-authorization-revoked', REVOKED_MESSAGE)

  const event = { action: 'tool_authorization.use', outcome: 'allow', reason: null, authorization_id: record.id }
  try { updateStore(userDataDir, safeStorage, (s) => queue(s, event, now), { fsImpl }) } catch { /* audit queue is best-effort; the grant is valid */ }
  return { id: record.id, label: record.label, scope: record.scope }
}

export function drainToolAuditEvents(userDataDir, safeStorage, { fsImpl = fs } = {}) {
  const file = path.join(userDataDir, TOOL_AUTH_FILE)
  if (!fsImpl.existsSync(file)) return []
  return updateStore(userDataDir, safeStorage, (state) => {
    const events = state.audit
    state.audit = []
    return events
  }, { fsImpl })
}
