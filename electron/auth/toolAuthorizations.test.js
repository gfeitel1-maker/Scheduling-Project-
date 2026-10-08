// @vitest-environment node
// Director-authorized tool connections (docs/adr/2026-10-08-director-authorized-tool-connections.md).
// Accountability control on the OS-user + keychain boundary — NOT a defense against a same-user attacker.
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {
  grantToolAuthorization,
  revokeToolAuthorization,
  listToolAuthorizations,
  checkToolAuthorization,
  drainToolAuditEvents,
  TOOL_AUTH_FILE,
} from './toolAuthorizations.js'

// XOR-"seals" so the blob is not greppable, mimicking safeStorage's opacity.
const fakeSafeStorage = {
  isEncryptionAvailable: () => true,
  encryptString: (s) => Buffer.from(Buffer.from(s, 'utf8').map((b) => b ^ 0x5a)),
  decryptString: (b) => Buffer.from(Buffer.from(b).map((x) => x ^ 0x5a)).toString('utf8'),
}

let dir
beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'toolauth-')) })
afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }) })

const grant = (over = {}) =>
  grantToolAuthorization(dir, fakeSafeStorage, { label: "Greg's laptop MCP", scope: 'read', createdBy: 'dev-1', ...over })

function refusal(fn) {
  try { fn() } catch (e) { return e }
  throw new Error('expected a refusal, got success')
}

describe('grant -> tool connects', () => {
  it('returns the secret once and a public record; the secret verifies', () => {
    const { authorization, secret } = grant()
    expect(typeof secret).toBe('string')
    expect(authorization).toMatchObject({ label: "Greg's laptop MCP", scope: 'read', revoked_at: null })
    expect(authorization.secret_hash).toBeUndefined()
    const ok = checkToolAuthorization(dir, fakeSafeStorage, secret)
    expect(ok).toMatchObject({ id: authorization.id, scope: 'read' })
  })
  it('rejects an invalid scope and an empty label', () => {
    expect(() => grant({ scope: 'admin' })).toThrow(/scope/)
    expect(() => grant({ label: '  ' })).toThrow(/label/)
  })
})

describe('only the hash is stored; the secret is never on disk', () => {
  it('neither the secret nor its raw form appears in any file under the dir, sealed or not', () => {
    const { secret } = grant()
    const sealed = fs.readFileSync(path.join(dir, TOOL_AUTH_FILE))
    expect(sealed.includes(Buffer.from(secret))).toBe(false)
    const unsealed = fakeSafeStorage.decryptString(sealed)
    expect(unsealed).not.toContain(secret)
    expect(unsealed).toMatch(/secret_hash/)
  })
  it('non-vacuity: the unsealed blob DOES contain the hash, so the scan can see stored material', () => {
    const { authorization } = grant()
    const unsealed = JSON.parse(fakeSafeStorage.decryptString(fs.readFileSync(path.join(dir, TOOL_AUTH_FILE))))
    expect(unsealed.tools[0].secret_hash).toMatch(/^[0-9a-f]{64}$/)
    expect(unsealed.tools[0].id).toBe(authorization.id)
  })
  it('list never exposes hashes', () => {
    grant()
    expect(JSON.stringify(listToolAuthorizations(dir, fakeSafeStorage))).not.toContain('secret_hash')
  })
})

describe('refusals are named', () => {
  it('unknown / forged secret -> tool-not-authorized', () => {
    grant()
    expect(refusal(() => checkToolAuthorization(dir, fakeSafeStorage, 'nope')).code).toBe('tool-not-authorized')
    const { authorization } = grant({ label: 'second' })
    expect(refusal(() => checkToolAuthorization(dir, fakeSafeStorage, `${authorization.id}.${'0'.repeat(64)}`)).code).toBe('tool-not-authorized')
    expect(refusal(() => checkToolAuthorization(dir, fakeSafeStorage, '')).code).toBe('tool-not-authorized')
    expect(refusal(() => checkToolAuthorization(dir, fakeSafeStorage, null)).code).toBe('tool-not-authorized')
  })
  it('no store at all -> tool-not-authorized (never db_key_unavailable)', () => {
    const e = refusal(() => checkToolAuthorization(dir, fakeSafeStorage, 'x.y'))
    expect(e.code).toBe('tool-not-authorized')
    expect(e.code).not.toBe('db_key_unavailable')
  })
  it('revoked -> tool-authorization-revoked, re-read live each call', () => {
    const { authorization, secret } = grant()
    expect(checkToolAuthorization(dir, fakeSafeStorage, secret).id).toBe(authorization.id)
    revokeToolAuthorization(dir, fakeSafeStorage, authorization.id, { revokedBy: 'dev-1' })
    const e = refusal(() => checkToolAuthorization(dir, fakeSafeStorage, secret))
    expect(e.code).toBe('tool-authorization-revoked')
    expect(listToolAuthorizations(dir, fakeSafeStorage)[0].revoked_at).toBeTruthy()
  })
  it('a corrupt store fails closed with the named refusal', () => {
    fs.writeFileSync(path.join(dir, TOOL_AUTH_FILE), Buffer.from('garbage'))
    expect(refusal(() => checkToolAuthorization(dir, fakeSafeStorage, 'a.b')).code).toBe('tool-not-authorized')
  })
  it('revoking an unknown id throws', () => {
    expect(() => revokeToolAuthorization(dir, fakeSafeStorage, 'missing')).toThrow(/not found/)
  })
})

describe('use is audited via a drainable queue (no camp key needed at key-release time)', () => {
  it('refusals and successful use are queued, secrets never are, and drain empties the queue', () => {
    const { authorization, secret } = grant()
    checkToolAuthorization(dir, fakeSafeStorage, secret)
    refusal(() => checkToolAuthorization(dir, fakeSafeStorage, 'bad.secret'))
    revokeToolAuthorization(dir, fakeSafeStorage, authorization.id)
    refusal(() => checkToolAuthorization(dir, fakeSafeStorage, secret))
    const events = drainToolAuditEvents(dir, fakeSafeStorage)
    expect(events.map((e) => `${e.action}:${e.outcome}:${e.reason ?? ''}`)).toEqual([
      'tool_authorization.use:allow:',
      'tool_authorization.use:deny:tool-not-authorized',
      'tool_authorization.use:deny:tool-authorization-revoked',
    ])
    expect(events[2].authorization_id).toBe(authorization.id)
    expect(JSON.stringify(events)).not.toContain(secret)
    expect(drainToolAuditEvents(dir, fakeSafeStorage)).toEqual([])
  })
})

describe('sealed-store read-modify-write is serialized', () => {
  const lockFile = () => path.join(dir, `${TOOL_AUTH_FILE}.lock`)

  it('a revoke that lands between the check\'s read and its audit write is not overwritten', () => {
    const { authorization, secret } = grant()
    let intercepted = false
    const fsImpl = {
      ...fs,
      existsSync: fs.existsSync,
      renameSync: fs.renameSync,
      writeFileSync: fs.writeFileSync,
      readFileSync: (...args) => {
        const stale = fs.readFileSync(...args)
        if (!intercepted) {
          intercepted = true
          revokeToolAuthorization(dir, fakeSafeStorage, authorization.id)
        }
        return stale
      },
    }
    checkToolAuthorization(dir, fakeSafeStorage, secret, { fsImpl })
    const [rec] = listToolAuthorizations(dir, fakeSafeStorage)
    expect(rec.revoked_at).not.toBeNull()
  })

  it('a fresh lock held by someone else makes grant fail with tool-auth-store-busy', () => {
    fs.writeFileSync(lockFile(), JSON.stringify({ pid: 1, at: Date.now() }))
    expect(refusal(() => grant()).code).toBe('tool-auth-store-busy')
  }, 10000)

  it('a stale lock is broken and grant succeeds; the lock is gone afterwards', () => {
    fs.writeFileSync(lockFile(), JSON.stringify({ pid: 1, at: 0 }))
    const old = new Date(Date.now() - 60000)
    fs.utimesSync(lockFile(), old, old)
    expect(() => grant()).not.toThrow()
    expect(fs.existsSync(lockFile())).toBe(false)
  })
})

describe('audit queue coalesces repeated denials', () => {
  it('500 forged + 300 revoked-id checks keep the allow and yield two deny entries with counts', () => {
    const { authorization, secret } = grant()
    checkToolAuthorization(dir, fakeSafeStorage, secret)
    const second = grant()
    revokeToolAuthorization(dir, fakeSafeStorage, second.authorization.id)
    for (let i = 0; i < 500; i++) expect(() => checkToolAuthorization(dir, fakeSafeStorage, `forged.${i}`)).toThrow()
    for (let i = 0; i < 300; i++) expect(() => checkToolAuthorization(dir, fakeSafeStorage, second.secret)).toThrow()
    const events = drainToolAuditEvents(dir, fakeSafeStorage)
    expect(events.filter((e) => e.outcome === 'allow')).toHaveLength(1)
    const denies = events.filter((e) => e.outcome === 'deny')
    expect(denies.map((d) => d.count).sort()).toEqual([300, 500])
    expect(denies.every((d) => d.first_at && d.last_at && d.at === d.first_at)).toBe(true)
    expect(authorization.id).toBeTruthy()
  }, 60000)
})
