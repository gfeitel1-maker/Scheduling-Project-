import { describe, it, expect } from 'vitest'
import { describeWriteFailure, writeErrorMessage, deleteRefusalMessage } from './writeErrorMessage'

// docs/adr/2026-07-30-deleting-a-record-a-schedule-uses.md §5 — completion
// evidence 5: no user-facing message attributes a foreign-key failure to the
// connection.

describe('describeWriteFailure', () => {
  it('never blames the connection for a foreign-key violation', () => {
    const message = describeWriteFailure(
      new Error('FOREIGN KEY constraint failed'),
      'That group could not be deleted.'
    )
    expect(message).not.toMatch(/connection|wifi|network/i)
    expect(message).toMatch(/still refers to it/)
  })

  it('does not claim to know WHICH foreign key it was', () => {
    // operations has its own FKs on device_id and author_user_id, with a
    // byte-identical error string. Naming the schedule would be a guess.
    const message = describeWriteFailure(new Error('FOREIGN KEY constraint failed'), 'X.')
    expect(message).not.toMatch(/schedule/i)
  })

  it('names a duplicate name as a duplicate name', () => {
    expect(describeWriteFailure(new Error('UNIQUE constraint failed: groups.name'), 'X.')).toMatch(
      /already has that name/
    )
  })

  it('mentions the network only for a genuine transport failure', () => {
    expect(describeWriteFailure(new Error('socket disconnected'), 'X.')).toMatch(/network/)
  })

  it('says it does not know rather than inventing a cause', () => {
    const message = describeWriteFailure(new Error('something unexpected'), 'X.')
    expect(message).not.toMatch(/connection|network/i)
    expect(message).toMatch(/not something the app recognised/)
  })

  it('survives an error with no message at all', () => {
    expect(describeWriteFailure(undefined, 'X.')).toContain('X.')
  })
})

describe('writeErrorMessage', () => {
  it('keeps the permission branch exactly as it was', () => {
    expect(
      writeErrorMessage(new Error('admin role required'), {
        forbidden: 'Only an admin can delete groups.',
        whatFailed: 'That group could not be deleted.',
      })
    ).toBe('Only an admin can delete groups.')
  })

  it('routes everything else through the mapper', () => {
    expect(
      writeErrorMessage(new Error('FOREIGN KEY constraint failed'), {
        forbidden: 'nope',
        whatFailed: 'That group could not be deleted.',
      })
    ).toMatch(/still refers to it/)
  })
})

describe('deleteRefusalMessage', () => {
  it('says nothing was deleted when the version could not be saved', () => {
    const message = deleteRefusalMessage('snapshot-failed', { name: 'Bunk 2' })
    expect(message).toMatch(/nothing was deleted/i)
    expect(message).toMatch(/still here/)
  })

  it('reports the new count when it changed under the director', () => {
    expect(deleteRefusalMessage('count-changed', { name: 'Bunk 2', slot_count: 76 })).toContain('76')
  })

  it('never blames the connection for a refusal that is not about the network', () => {
    for (const error of ['count-changed', 'snapshot-failed', 'unprotected-slots', 'no-record']) {
      expect(deleteRefusalMessage(error, { name: 'Bunk 2', slot_count: 1, unprotected_count: 1 })).not.toMatch(
        /connection|wifi/i
      )
    }
  })

  it('says the main computer is away only when it is', () => {
    expect(deleteRefusalMessage('host-unreachable')).toMatch(/main computer/)
  })
})
