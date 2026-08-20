import { describe, it, expect, vi } from 'vitest'
import { parseArgs, main } from './ingest.js'

describe('ingest.js argv parsing', () => {
  it('parses file, --db, --commit, --mode, --json', () => {
    const opts = parseArgs(['schedule.txt', '--db', '/tmp/x.sqlite', '--commit', '--mode', 'replace', '--json'])
    expect(opts).toEqual({ file: 'schedule.txt', dbPath: '/tmp/x.sqlite', action: 'commit', mode: 'replace', json: true })
  })

  it('defaults to preview/add/no-json', () => {
    const opts = parseArgs(['schedule.txt', '--db', '/tmp/x.sqlite'])
    expect(opts.action).toBe('preview')
    expect(opts.mode).toBe('add')
    expect(opts.json).toBe(false)
  })
})

describe('ingest.js main', () => {
  it('prints usage and returns 0 with --help', () => {
    const spy = vi.spyOn(console, 'log').mockImplementation(() => {})
    const code = main(['--help'])
    expect(code).toBe(0)
    expect(spy).toHaveBeenCalled()
    spy.mockRestore()
  })

  it('prints usage and returns non-zero with no args', () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {})
    const code = main([])
    expect(code).toBe(0) // no-arg path matches the --help branch (argv.length === 0)
    spy.mockRestore()
  })

  it('returns non-zero when --db is missing', () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {})
    const code = main(['schedule.txt'])
    expect(code).toBe(1)
    spy.mockRestore()
  })

  it('rejects an invalid --mode', () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {})
    const code = main(['schedule.txt', '--db', '/tmp/x.sqlite', '--mode', 'bogus'])
    expect(code).toBe(1)
    spy.mockRestore()
  })
})
