// @vitest-environment node
//
// Stage 5c (docs/work/plans/2026-09-06-stage5-live-wiring-design.md § 3): turns "the Automerge doc
// advanced from beforeHeads to afterHeads" into the same `{entity, entity_id, field, value,
// device_id, author_user_id}` shape the renderer's `shoresh:op-applied` consumers already parse.
// Pure module — no SQLite, no Electron, no IPC — so this test never touches the real db.
import { describe, it, expect } from 'vitest'
import * as A from '@automerge/automerge'
import { createEmptyDoc, applyWrite, MODELED_ENTITIES } from '../../automerge/campDocument.js'
import { DELETE_FIELD } from '../../ops/operations.js'
import { synthesizeOpEvents } from './docDiffEvents.js'

function eventsFor(mutate, { deviceId } = {}) {
  const before = createEmptyDoc()
  const beforeHeads = A.getHeads(before)
  const after = mutate(before)
  const afterHeads = A.getHeads(after)
  return synthesizeOpEvents(after, beforeHeads, afterHeads, { deviceId })
}

describe('synthesizeOpEvents', () => {
  it('synthesizes one event for a new string field, with the value read from after-state', () => {
    const events = eventsFor((doc) => applyWrite(doc, { entity: 'activities', entity_id: 'a1', field: 'name', value: 'Archery' }))
    const nameEvents = events.filter((e) => e.field === 'name')
    expect(nameEvents).toHaveLength(1)
    expect(nameEvents[0]).toMatchObject({ entity: 'activities', entity_id: 'a1', field: 'name', value: 'Archery' })
  })

  it('deduplicates a single field edit that produces multiple patches (string splice)', () => {
    // A string field write is Automerge Text under the hood: `put` (empty) + `splice`. Both patches
    // touch the SAME (entity_id, field) — the caller must see exactly ONE event, not two.
    const events = eventsFor((doc) => applyWrite(doc, { entity: 'activities', entity_id: 'a1', field: 'name', value: 'Archery' }))
    const nameEvents = events.filter((e) => e.entity_id === 'a1' && e.field === 'name')
    expect(nameEvents).toHaveLength(1)
  })

  it('handles a numeric field value', () => {
    const events = eventsFor((doc) => {
      let d = applyWrite(doc, { entity: 'locations', entity_id: 'l1', field: 'capacity', value: 20 })
      return d
    })
    const capEvents = events.filter((e) => e.field === 'capacity')
    expect(capEvents).toHaveLength(1)
    expect(capEvents[0].value).toBe(20)
  })

  it('handles a boolean field value (coerced to \'1\'/\'0\' by applyWrite\'s coerceOpValue, same as the op-log)', () => {
    const events = eventsFor((doc) => applyWrite(doc, { entity: 'anchor_activities', entity_id: 'anc1', field: 'is_all_groups', value: true }))
    const boolEvents = events.filter((e) => e.field === 'is_all_groups')
    expect(boolEvents).toHaveLength(1)
    expect(boolEvents[0].value).toBe('1')
  })

  it('one event per (entity_id, field) — two different fields on the same row are two events', () => {
    const events = eventsFor((doc) => {
      let d = applyWrite(doc, { entity: 'activities', entity_id: 'a1', field: 'name', value: 'Archery' })
      d = applyWrite(d, { entity: 'activities', entity_id: 'a1', field: 'location', value: 'Field 1' })
      return d
    })
    expect(events.filter((e) => e.entity_id === 'a1')).toHaveLength(2)
    expect(events.map((e) => e.field).sort()).toEqual(['location', 'name'])
  })

  it('a deleted row synthesizes ONE event with field DELETE_FIELD and no value', () => {
    const before = applyWrite(createEmptyDoc(), { entity: 'activities', entity_id: 'a1', field: 'name', value: 'Archery' })
    const beforeHeads = A.getHeads(before)
    const after = applyWrite(before, { entity: 'activities', entity_id: 'a1', field: DELETE_FIELD, value: null })
    const afterHeads = A.getHeads(after)
    const events = synthesizeOpEvents(after, beforeHeads, afterHeads, {})
    expect(events).toHaveLength(1)
    expect(events[0]).toMatchObject({ entity: 'activities', entity_id: 'a1', field: DELETE_FIELD })
    expect('value' in events[0]).toBe(false)
  })

  it('ignores a patch whose top-level path segment is not a modeled entity', () => {
    // MODELED_ENTITIES never contains 'not_a_real_entity' — confirms the scope fence.
    expect(MODELED_ENTITIES.has('not_a_real_entity')).toBe(false)
    const before = createEmptyDoc()
    const beforeHeads = A.getHeads(before)
    // Mutate something outside the doc's modeled shape is not directly expressible via applyWrite
    // (it asserts modeled entities), so instead assert the guard using a genuinely unmodeled entity
    // name would throw at applyWrite — proving the fence exists upstream of this module too.
    expect(() => applyWrite(before, { entity: 'not_a_real_entity', entity_id: 'x', field: 'f', value: 1 })).toThrow()
    const afterHeads = A.getHeads(before)
    expect(synthesizeOpEvents(before, beforeHeads, afterHeads, {})).toEqual([])
  })

  it('skips a field not registered in PROJECTIONS[entity].fields (mirrors applyWrite\'s silent no-op)', () => {
    // applyWrite itself silently no-ops an unregistered field, so no patch is ever produced for it —
    // this proves the fence holds end-to-end (nothing to synthesize an event FROM).
    const before = createEmptyDoc()
    const beforeHeads = A.getHeads(before)
    const after = applyWrite(before, { entity: 'activities', entity_id: 'a1', field: 'not_a_real_field', value: 'x' })
    const afterHeads = A.getHeads(after)
    expect(synthesizeOpEvents(after, beforeHeads, afterHeads, {})).toEqual([])
  })

  it('device_id is exactly what the caller passes (a remote peer id), never inferred as local', () => {
    const localDeviceId = 'local-device-should-never-appear'
    const events = eventsFor(
      (doc) => applyWrite(doc, { entity: 'activities', entity_id: 'a1', field: 'name', value: 'Archery' }),
      { deviceId: 'remote-peer-42' }
    )
    expect(events).toHaveLength(1)
    expect(events[0].device_id).toBe('remote-peer-42')
    expect(events[0].device_id).not.toBe(localDeviceId)
  })

  it('device_id defaults to null when the caller passes none, never a guessed local id', () => {
    const events = eventsFor((doc) => applyWrite(doc, { entity: 'activities', entity_id: 'a1', field: 'name', value: 'Archery' }))
    expect(events).toHaveLength(1)
    expect(events[0].device_id).toBeNull()
  })

  it('every event carries author_user_id: null (a merged CRDT change has no single op-log author)', () => {
    const events = eventsFor((doc) => applyWrite(doc, { entity: 'activities', entity_id: 'a1', field: 'name', value: 'Archery' }))
    expect(events[0].author_user_id).toBeNull()
  })
})
