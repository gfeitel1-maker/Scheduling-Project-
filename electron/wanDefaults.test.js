// @vitest-environment node
import fs from 'node:fs'
import { describe, it, expect } from 'vitest'
import { applyPackagedWanDefaults, DEFAULT_RENDEZVOUS_URL } from './wanDefaults.js'

const run = (env, isPackaged) => { applyPackagedWanDefaults(env, isPackaged); return env }

describe('applyPackagedWanDefaults (T340 switch-on)', () => {
  it('packaged + unset turns the punch ladder on', () => {
    expect(run({}, true).SHORESH_PUNCH_ENABLED).toBe('true')
  })
  it("packaged + 'false' stays off", () => {
    expect(run({ SHORESH_PUNCH_ENABLED: 'false' }, true).SHORESH_PUNCH_ENABLED).toBe('false')
  })
  it('packaged + any other explicit value is left for the strict check to refuse', () => {
    expect(run({ SHORESH_PUNCH_ENABLED: '1' }, true).SHORESH_PUNCH_ENABLED).toBe('1')
    expect(run({ SHORESH_PUNCH_ENABLED: '' }, true).SHORESH_PUNCH_ENABLED).toBe('')
  })
  it('unpackaged + unset stays unset', () => {
    expect(run({}, false).SHORESH_PUNCH_ENABLED).toBeUndefined()
  })

  it('rendezvous: packaged + unset gets the Worker URL', () => {
    expect(run({}, true).SHORESH_RENDEZVOUS_URL).toBe(DEFAULT_RENDEZVOUS_URL)
    expect(DEFAULT_RENDEZVOUS_URL).toBe('https://shoresh-rendezvous.jays-lives-dev.workers.dev')
  })
  it('rendezvous: a set value overrides', () => {
    expect(run({ SHORESH_RENDEZVOUS_URL: 'https://example.test' }, true).SHORESH_RENDEZVOUS_URL).toBe('https://example.test')
  })
  it('rendezvous: set-but-empty is kept empty (rung 3 disabled), distinct from unset', () => {
    expect(run({ SHORESH_RENDEZVOUS_URL: '' }, true).SHORESH_RENDEZVOUS_URL).toBe('')
  })
  it('rendezvous: unpackaged + unset gets none', () => {
    expect(run({}, false).SHORESH_RENDEZVOUS_URL).toBeUndefined()
  })
  it("rendezvous: not defaulted when punch is explicitly off (the Worker is rung 3 of the punch ladder)", () => {
    expect(run({ SHORESH_PUNCH_ENABLED: 'false' }, true).SHORESH_RENDEZVOUS_URL).toBeUndefined()
  })
})

describe('main.js wiring', () => {
  it('resolves the defaults once with app.isPackaged, before whenReady', () => {
    const src = fs.readFileSync(new URL('./main.js', import.meta.url), 'utf8')
    expect(src.match(/applyPackagedWanDefaults\(process\.env, app\.isPackaged\)/g)).toHaveLength(1)
    expect(src.indexOf('applyPackagedWanDefaults(process.env')).toBeLessThan(src.indexOf('await app.whenReady()', src.indexOf('applyUserDataPath(app)')))
  })
})
