import { describe, it, expect } from 'vitest'
import { NO_SELECTION, toggleTile, isTileSelected, tileStates, isNodeSelection } from './selectionModel.js'

// T95 — the import-review tiles are a LENS, not a second inbox. Multi-select
// restores the pre-RootMap behaviour (owner, 2026-09-12: "happy to see 2 or
// more at a time") without reopening the one-authoritative-model invariant:
// selecting two tiles widens what is shown, it never creates a second queue.
//
// Node selection stays single by design — a node is a drill-down into one
// domain/child, a different gesture from "widen the lens".
describe('reconciliation selection model (T95)', () => {
  it('defaults to no selection — the quiet first glance', () => {
    expect(NO_SELECTION).toEqual({ type: 'none' })
    expect(tileStates(NO_SELECTION)).toEqual([])
    expect(isTileSelected(NO_SELECTION, 'changed')).toBe(false)
  })

  it('selecting one tile from none yields a single-state tile selection', () => {
    const s = toggleTile(NO_SELECTION, 'changed')
    expect(s.type).toBe('tile')
    expect(tileStates(s)).toEqual(['changed'])
    expect(isTileSelected(s, 'changed')).toBe(true)
    expect(isTileSelected(s, 'understood')).toBe(false)
  })

  it('selecting a SECOND tile keeps both — the actual T95 ask', () => {
    const s = toggleTile(toggleTile(NO_SELECTION, 'changed'), 'understood')
    expect(tileStates(s)).toEqual(['changed', 'understood'])
    expect(isTileSelected(s, 'changed')).toBe(true)
    expect(isTileSelected(s, 'understood')).toBe(true)
  })

  it('re-clicking a selected tile removes just that one', () => {
    const both = toggleTile(toggleTile(NO_SELECTION, 'changed'), 'understood')
    const s = toggleTile(both, 'changed')
    expect(tileStates(s)).toEqual(['understood'])
  })

  it('removing the last selected tile returns to none, not an empty tile selection', () => {
    const s = toggleTile(toggleTile(NO_SELECTION, 'changed'), 'changed')
    expect(s).toEqual(NO_SELECTION)
  })

  it('preserves click order so the heading reads in the order the director picked', () => {
    const s = toggleTile(toggleTile(NO_SELECTION, 'understood'), 'changed')
    expect(tileStates(s)).toEqual(['understood', 'changed'])
  })

  it('toggling a tile while a NODE is selected replaces it — a lens, not an intersection', () => {
    const node = { type: 'node', domainKey: 'structure', childKey: 'groups' }
    const s = toggleTile(node, 'changed')
    expect(s.type).toBe('tile')
    expect(tileStates(s)).toEqual(['changed'])
  })

  it('isNodeSelection distinguishes the drill-down gesture', () => {
    expect(isNodeSelection({ type: 'node', domainKey: 'structure' })).toBe(true)
    expect(isNodeSelection(toggleTile(NO_SELECTION, 'changed'))).toBe(false)
    expect(isNodeSelection(NO_SELECTION)).toBe(false)
  })

  it('never mutates the selection it is given', () => {
    const first = toggleTile(NO_SELECTION, 'changed')
    const snapshot = tileStates(first).slice()
    toggleTile(first, 'understood')
    expect(tileStates(first)).toEqual(snapshot)
  })
})
