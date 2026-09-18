// @vitest-environment node
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { codeForAuthRejectedReason, REASON_TO_CODE } from './authRejectedSender.js'

describe('codeForAuthRejectedReason', () => {
  it('maps invalid_token to 4401', () => {
    expect(codeForAuthRejectedReason('invalid_token')).toBe(4401)
  })
  it('maps local_token_not_valid_for_network to 4402', () => {
    expect(codeForAuthRejectedReason('local_token_not_valid_for_network')).toBe(4402)
  })
  it('maps device_not_found and device_not_authorized to 4403', () => {
    expect(codeForAuthRejectedReason('device_not_found')).toBe(4403)
    expect(codeForAuthRejectedReason('device_not_authorized')).toBe(4403)
  })
  it('maps device_revoked to 4404', () => {
    expect(codeForAuthRejectedReason('device_revoked')).toBe(4404)
  })
  it('maps peer_identity_mismatch to 4405 — must stay distinct from the 4403/4404 revoked copy', () => {
    expect(codeForAuthRejectedReason('peer_identity_mismatch')).toBe(4405)
  })
  it('falls back to 4401 (benign) for an unrecognized reason', () => {
    expect(codeForAuthRejectedReason('something_new')).toBe(4401)
  })
})

// Code-reviewer finding (MEDIUM), 2026-09-17. REASON_TO_CODE and evaluateAuthenticate's own code
// choices live in two files with nothing forcing them to agree. They agree today — verified by
// hand — but "verified by hand today" is exactly what the dead emitter this ticket fixes was, too.
// Assert the parity against connectionAuth.js's real source, so drift fails a test instead of
// silently downgrading a refusal to the benign notice via the `?? 4401` fallback.
describe('REASON_TO_CODE parity with connectionAuth.js (drift guard)', () => {
  const src = readFileSync(join(dirname(fileURLToPath(import.meta.url)), 'auth', 'connectionAuth.js'), 'utf8')

  it('maps every (reason, code) pair connectionAuth.js actually returns', () => {
    // Every `code: NNNN, reason: 'x'` / `reason: 'x', code: NNNN` literal pair, plus the
    // ternary form `code: reason === 'device_revoked' ? 4404 : 4403`.
    const pairs = new Map()
    for (const m of src.matchAll(/code:\s*(\d{4})\s*,\s*reason:\s*'([a-z_]+)'/g)) pairs.set(m[2], Number(m[1]))
    for (const m of src.matchAll(/reason:\s*'([a-z_]+)'\s*,\s*code:\s*(\d{4})/g)) pairs.set(m[1], Number(m[2]))
    for (const m of src.matchAll(/reason\s*===\s*'([a-z_]+)'\s*\?\s*(\d{4})\s*:\s*(\d{4})/g)) pairs.set(m[1], Number(m[2]))

    expect(pairs.size, 'found no (reason, code) pairs in connectionAuth.js — the scanner is broken, not the code clean').toBeGreaterThan(2)

    for (const [reason, code] of pairs) {
      expect(REASON_TO_CODE[reason],
        `connectionAuth.js returns code ${code} for reason '${reason}', but authRejectedSender.js ` +
        `maps it to ${REASON_TO_CODE[reason] ?? 'nothing (falls back to 4401, the benign notice)'}. ` +
        `Update REASON_TO_CODE — a mismatch shows the director the wrong message, not no message.`
      ).toBe(code)
    }
  })
})
