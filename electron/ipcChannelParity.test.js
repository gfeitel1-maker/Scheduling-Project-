// @vitest-environment node
//
// Non-vacuity for the ipcChannelParity guard (see ipcChannelParity.js's header for the defect
// class this exists to catch: 'shoresh:auth-rejected' had a preload listener and no sender for an
// entire Stage 6 cutover, invisible because every test mocked the channel directly). These tests
// plant the defect shape by hand rather than reading real files, so they prove the detection
// itself works before ipcChannelParity.guard.test.js ever points it at the repo.
import { describe, it, expect } from 'vitest'
import { findListenedChannels, findSentChannels, findChannelsWithoutSender } from './ipcChannelParity.js'

describe('findListenedChannels', () => {
  it('extracts every distinct channel registered via ipcRenderer.on', () => {
    const src = `
      onFoo: (cb) => ipcRenderer.on('shoresh:foo', (_e, d) => cb(d)),
      onBar: (cb) => ipcRenderer.on("shoresh:bar", () => cb()),
    `
    expect(findListenedChannels(src)).toEqual(['shoresh:foo', 'shoresh:bar'])
  })

  it('de-duplicates a channel registered more than once', () => {
    const src = `ipcRenderer.on('shoresh:foo', a); ipcRenderer.on('shoresh:foo', b);`
    expect(findListenedChannels(src)).toEqual(['shoresh:foo'])
  })
})

describe('findSentChannels', () => {
  it('finds a direct webContents.send call', () => {
    expect(findSentChannels(`mainWindow.webContents.send('shoresh:foo', data)`).has('shoresh:foo')).toBe(true)
  })

  it('finds a send reached through a local indirection, matching dispatchRemoteOps.js\'s shape', () => {
    const src = `function dispatchRemoteOps(events, { send }) { send('shoresh:op-applied', x) }`
    expect(findSentChannels(src).has('shoresh:op-applied')).toBe(true)
  })
})

describe('findChannelsWithoutSender — the shape that survived the Stage 6 cutover undetected', () => {
  it('flags a listener whose sender was removed from the source (the actual auth-rejected defect)', () => {
    const preloadSrc = `onAuthRejected: (cb) => ipcRenderer.on('shoresh:auth-rejected', (_e, d) => cb(d.code)),`
    // Simulates the deleted WS syncClient.js: the sender that used to exist is gone from the
    // scanned electron/ source entirely, exactly what happened in the real Stage 6 cutover.
    const electronSrc = `mainWindow.webContents.send('shoresh:pairing-request', data)`
    expect(findChannelsWithoutSender(preloadSrc, electronSrc)).toEqual(['shoresh:auth-rejected'])
  })

  it('does not flag a channel once a sender for it exists anywhere in the scanned source', () => {
    const preloadSrc = `onAuthRejected: (cb) => ipcRenderer.on('shoresh:auth-rejected', (_e, d) => cb(d.code)),`
    const electronSrc = `mainWindow.webContents.send('shoresh:auth-rejected', { code })`
    expect(findChannelsWithoutSender(preloadSrc, electronSrc)).toEqual([])
  })

  it('excludes an explicitly named known gap', () => {
    const preloadSrc = `onFoo: (cb) => ipcRenderer.on('shoresh:foo', cb),`
    expect(findChannelsWithoutSender(preloadSrc, '', { knownGaps: ['shoresh:foo'] })).toEqual([])
  })
})
