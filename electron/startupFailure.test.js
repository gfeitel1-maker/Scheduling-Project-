import { describe, it, expect } from 'vitest'
import { describeStartupFailure, formatStartupFailureLog } from './startupFailure.js'

// T19. The defect was silence, so these tests are about whether anything is
// SAID and whether a director could act on it — not about any single fault.

const ABI_ERROR = new Error(
  "Failed to open local database at /Users/x/Library/Application Support/shoresh/shoresh.sqlite: " +
  "The module 'better_sqlite3.node' was compiled against a different Node.js version using " +
  'NODE_MODULE_VERSION 141. This version of Node.js requires NODE_MODULE_VERSION 148.',
)

describe('describeStartupFailure', () => {
  it('says the data is safe — the first thing a director needs to know', () => {
    const { message } = describeStartupFailure(ABI_ERROR, null)
    expect(message).toMatch(/data has not been changed/i)
  })

  it('gives the director an action, not only a diagnosis', () => {
    // They are completely stuck: the app will not open. A message that only
    // names the fault leaves them exactly where they were.
    const { message } = describeStartupFailure(ABI_ERROR, null)
    expect(message).toMatch(/reinstall/i)
  })

  it('names the schedule file rather than the database, for a database failure', () => {
    // Article V: the director knows camps and schedules, not SQLite.
    const { message } = describeStartupFailure(ABI_ERROR, null)
    expect(message).toMatch(/schedule file/i)
    expect(message.split('Technical detail:')[0]).not.toMatch(/sqlite|NODE_MODULE_VERSION/i)
  })

  it('still keeps the technical detail, placed last', () => {
    // The director may have to relay it to someone who can act on it.
    const { message } = describeStartupFailure(ABI_ERROR, null)
    const idx = message.indexOf('Technical detail:')
    expect(idx).toBeGreaterThan(0)
    expect(message.slice(idx)).toMatch(/NODE_MODULE_VERSION/)
  })

  it('points at the log file when one was written', () => {
    const { message } = describeStartupFailure(ABI_ERROR, '/tmp/startup-error.log')
    expect(message).toContain('/tmp/startup-error.log')
  })

  it('omits the log line entirely when logging itself failed', () => {
    // A logging failure must not become a second, confusing error.
    const { message } = describeStartupFailure(ABI_ERROR, null)
    expect(message).not.toMatch(/Details were saved to/)
  })

  it('handles a non-database failure without claiming it is one', () => {
    const { message } = describeStartupFailure(new Error('EACCES: permission denied'), null)
    expect(message).toMatch(/could not start/i)
    expect(message).not.toMatch(/schedule file/i)
  })

  it('never throws on a malformed error value', () => {
    // This runs in the failure path. It cannot itself fail.
    for (const bad of [null, undefined, 'a string', 42, {}]) {
      expect(() => describeStartupFailure(bad, null)).not.toThrow()
      expect(describeStartupFailure(bad, null).title).toBeTruthy()
    }
  })
})

describe('formatStartupFailureLog', () => {
  it('records the stack, so the file is worth asking a director to send', () => {
    const out = formatStartupFailureLog(ABI_ERROR, '2026-07-29T12:00:00.000Z')
    expect(out).toMatch(/NODE_MODULE_VERSION 141/)
    expect(out).toMatch(/2026-07-29T12:00:00.000Z/)
  })

  it('survives an error with no stack', () => {
    expect(() => formatStartupFailureLog('plain string', 'now')).not.toThrow()
    expect(formatStartupFailureLog('plain string', 'now')).toMatch(/plain string/)
  })
})
