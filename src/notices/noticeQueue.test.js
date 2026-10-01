// Pure-function tests for the FIFO notice queue (T200 board follow-up: an
// offline-queue rejection could overwrite a bootstrap-failure notice,
// losing it). These pin the three queue operations without any React/DOM —
// src/App.test.jsx pins the director-visible behavior built on top of them.
// Deliberately id-keyed throughout (round 2 removed `dismissHead`, a
// positional removal that raced a deferred dismiss fade against an id-keyed
// clean-resolve removal — see noticeQueue.js's header comment).
import { describe, it, expect } from 'vitest'
import { enqueue, upsertById, removeById } from './noticeQueue'

describe('enqueue', () => {
  it('appends a new entry to the end', () => {
    const queue = [{ id: 'a', message: 'first' }]
    const result = enqueue(queue, { id: 'b', message: 'second' })
    expect(result).toEqual([{ id: 'a', message: 'first' }, { id: 'b', message: 'second' }])
  })

  it('does not mutate the input array', () => {
    const queue = [{ id: 'a', message: 'first' }]
    enqueue(queue, { id: 'b', message: 'second' })
    expect(queue).toEqual([{ id: 'a', message: 'first' }])
  })

  it('appends two entries with identical messages as two distinct entries', () => {
    let queue = []
    queue = enqueue(queue, { id: '1', message: 'same' })
    queue = enqueue(queue, { id: '2', message: 'same' })
    expect(queue).toHaveLength(2)
    expect(queue[0].id).not.toBe(queue[1].id)
  })
})

describe('upsertById', () => {
  it('appends a new entry when no entry with this id exists', () => {
    const queue = [{ id: 'a', message: 'first' }]
    const result = upsertById(queue, 'b', { message: 'second' })
    expect(result).toEqual([{ id: 'a', message: 'first' }, { id: 'b', message: 'second' }])
  })

  it('replaces the entry with this id in place, preserving its position', () => {
    const queue = [
      { id: 'a', message: 'first' },
      { id: 'b', message: 'second' },
      { id: 'c', message: 'third' },
    ]
    const result = upsertById(queue, 'b', { message: 'second-updated' })
    expect(result).toEqual([
      { id: 'a', message: 'first' },
      { id: 'b', message: 'second-updated' },
      { id: 'c', message: 'third' },
    ])
  })

  it('merges the patch onto the existing entry rather than replacing it wholesale', () => {
    const queue = [{ id: 'a', message: 'first', retry: 'fn', source: 'bootstrap' }]
    const result = upsertById(queue, 'a', { message: 'updated' })
    expect(result).toEqual([{ id: 'a', message: 'updated', retry: 'fn', source: 'bootstrap' }])
  })

  it('does not mutate the input array', () => {
    const queue = [{ id: 'a', message: 'first' }]
    upsertById(queue, 'a', { message: 'updated' })
    expect(queue).toEqual([{ id: 'a', message: 'first' }])
  })
})

describe('removeById', () => {
  it('removes the entry with this id wherever it sits in the queue', () => {
    const queue = [
      { id: 'a', message: 'first' },
      { id: 'b', message: 'second' },
      { id: 'c', message: 'third' },
    ]
    const result = removeById(queue, 'b')
    expect(result).toEqual([
      { id: 'a', message: 'first' },
      { id: 'c', message: 'third' },
    ])
  })

  it('is a no-op when the id is not present', () => {
    const queue = [{ id: 'a', message: 'first' }]
    const result = removeById(queue, 'missing')
    expect(result).toEqual([{ id: 'a', message: 'first' }])
  })

  it('does not mutate the input array', () => {
    const queue = [{ id: 'a', message: 'first' }, { id: 'b', message: 'second' }]
    removeById(queue, 'a')
    expect(queue).toEqual([{ id: 'a', message: 'first' }, { id: 'b', message: 'second' }])
  })
})
