import { describe, it, expect } from 'vitest'
import { isTransientJoinError } from './joinTransientError'

describe('isTransientJoinError', () => {
  const rows = [
    [new Error('read ECONNRESET'), true],
    [Object.assign(new Error('x'), { code: 'ECONNREFUSED' }), true],
    [new Error('connect ETIMEDOUT 10.0.0.2:4001'), true],
    [new Error('write EPIPE'), true],
    [new Error("Error invoking remote method 'shoresh:join-start': Error: read ECONNRESET"), true],
    [Object.assign(new Error('Encryption failed'), { name: 'EncryptionFailedError', cause: new Error('read ECONNRESET') }), true],
    [Object.assign(new Error('Encryption failed'), { name: 'EncryptionFailedError' }), true],
    [Object.assign(new Error('timed out'), { name: 'TimeoutError' }), true],
    [new Error('The dial request has no valid addresses'), true],
    [new Error('That code is wrong'), false],
    [new Error('device revoked'), false],
    [new Error('schema mismatch'), false],
    [new Error('no join in progress'), false],
    [null, false],
    [undefined, false],
    ['read ECONNRESET', true],
  ]
  it.each(rows)('%s -> %s', (err, expected) => {
    expect(isTransientJoinError(err)).toBe(expected)
  })
})
