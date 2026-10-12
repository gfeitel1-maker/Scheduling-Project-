const TRANSIENT = /ECONNRESET|ECONNREFUSED|ETIMEDOUT|EPIPE|no valid addresses/i
const TRANSIENT_NAMES = new Set(['EncryptionFailedError', 'TimeoutError'])

export function isTransientJoinError(err) {
  if (!err) return false
  if (typeof err === 'string') return TRANSIENT.test(err)
  if (TRANSIENT_NAMES.has(err.name)) return true
  return TRANSIENT.test(`${err.code ?? ''} ${err.message ?? ''}`) || isTransientJoinError(err.cause)
}
