// Ending every session on this device (T345 follow-up, final audit on packaged 3ae9fb9).
//
// Sessions are stateless signed tokens (electron/auth/localAuth.js), so the renderer's stored token
// would verify again after a restart. Turning at-rest encryption off promises to sign everyone out,
// so it records the moment it happened in a small device-local file. isSessionEnded (checked by
// authorize() and the verifySession IPC) then rejects every user session issued before it. Device
// tokens are not sessions and are unaffected. A file, not a table: the database is being rewritten at that moment, and this
// fact belongs to this device alone, like the at-rest key.
import fs from 'node:fs'
import path from 'node:path'
import { setSessionsValidAfter } from './auth/localAuth.js'

export const FILE = 'sessions-valid-after.json'

// Records "now" and applies it in this process at once.
export function endAllSessions(userDataDir, now = Date.now()) {
  fs.writeFileSync(path.join(userDataDir, FILE), JSON.stringify({ validAfter: now }))
  setSessionsValidAfter(now)
  return now
}

// Read at startup, before any session is verified. A missing or unreadable file ends nothing.
export function loadSessionsValidAfter(userDataDir) {
  let validAfter = 0
  try {
    const parsed = JSON.parse(fs.readFileSync(path.join(userDataDir, FILE), 'utf8'))
    if (Number.isFinite(parsed?.validAfter)) validAfter = parsed.validAfter
  } catch { /* no record: no session has been ended on this device */ }
  setSessionsValidAfter(validAfter)
  return validAfter
}
