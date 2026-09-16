// Anti-vacuity suite for the `doc-names-missing-file` check (T186).
//
// The standing rule this file exists to honour: a guard proven only against the
// defect it was DESIGNED for proves nothing. The check was written to catch
// `electron/sync/syncServer.js` sitting in inline backticks in CLAUDE.md. Every
// case below except the first is a shape it was NOT designed for, and the
// commit message records which of them the first implementation missed.

import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { checkDocFileRefs, makeResolver, DESCRIPTIVE_DOC_PATHS } from './check-governance.js'

// A fixture repo whose code layer is known exactly, so "missing" means missing.
let root
beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), 'docrefs-'))
  mkdirSync(join(root, 'electron/sync/automerge'), { recursive: true })
  mkdirSync(join(root, 'src/engine'), { recursive: true })
  writeFileSync(join(root, 'electron/sync/automerge/discovery.js'), '')
  writeFileSync(join(root, 'electron/sync/joinCode.js'), '')
  writeFileSync(join(root, 'src/engine/buildSchedule.js'), '')
})
afterAll(() => rmSync(root, { recursive: true, force: true }))

const run = (text) => checkDocFileRefs([{ path: 'CLAUDE.md', text }], makeResolver(root))
const codes = (text) => run(text).map((f) => f.message)

describe('doc-names-missing-file — the shape it was designed for', () => {
  it('flags a missing file named in inline backticks', () => {
    expect(run('The server lives in `electron/sync/ghostServer.js` today.')).toHaveLength(1)
  })
})

describe('doc-names-missing-file — shapes it was NOT designed for', () => {
  it('flags a missing path inside a fenced code block', () => {
    const text = ['```bash', 'node electron/ghost/missingRunner.js --once', '```'].join('\n')
    expect(codes(text).join(' ')).toContain('electron/ghost/missingRunner.js')
  })

  it('flags a missing path carrying a :line suffix', () => {
    expect(codes('See `src/engine/ghostEngine.js:42` for the seed.').join(' '))
      .toContain('src/engine/ghostEngine.js')
  })

  it('does not double-report the same file named with and without a line suffix', () => {
    expect(run('`src/engine/ghostEngine.js:42` and `src/engine/ghostEngine.js`')).toHaveLength(1)
  })

  it('flags a missing directory path', () => {
    expect(codes('The live engine is `electron/ghostdir/`.').join(' ')).toContain('electron/ghostdir')
  })

  it('flags a missing directory named with a glob tail', () => {
    expect(codes('Everything under `electron/ghostdir/**` ships.').join(' ')).toContain('electron/ghostdir')
  })

  it('flags a full path whose basename exists somewhere else', () => {
    // The real file is electron/sync/automerge/discovery.js. A doc naming
    // electron/sync/discovery.js is WRONG, and a basename-only resolver calls
    // it clean — the exact under-match that would make this gate vacuous.
    expect(codes('mDNS lives in `electron/sync/discovery.js`.').join(' '))
      .toContain('electron/sync/discovery.js')
  })

  it('flags a dead markdown link target', () => {
    expect(codes('See [the notes](docs/current/GHOST_NOTES.md) for detail.').join(' '))
      .toContain('docs/current/GHOST_NOTES.md')
  })

  it('flags a missing file with an extension outside the original list', () => {
    const msgs = codes('See `electron/ghost.mjs` and `docs/current/GHOST_STATE.md`.').join(' ')
    expect(msgs).toContain('electron/ghost.mjs')
    expect(msgs).toContain('docs/current/GHOST_STATE.md')
  })
})

describe('doc-names-missing-file — must not fire on legitimate text', () => {
  it('accepts a file that exists at the exact path named', () => {
    expect(run('`electron/sync/automerge/discovery.js` handles mDNS.')).toEqual([])
  })

  it('accepts a bare module name that exists somewhere', () => {
    expect(run('The engine is `buildSchedule.js`, a pure function.')).toEqual([])
  })

  it('accepts a bare extension used as a naming convention', () => {
    expect(run('Tests are named `.test.js`.')).toEqual([])
  })

  it('accepts a glob family, not a claim about one file', () => {
    expect(run('Styles live in `src/**/*.css`.')).toEqual([])
  })

  it('accepts an npm/shell word that merely contains a dot', () => {
    expect(run('Run `npm run verify` and `electron-rebuild -f -w better-sqlite3`.')).toEqual([])
  })

  it('accepts a deliberately-absent path that is allowlisted with a reason', () => {
    expect(run('`src/hooks/useSession.js` no longer exists.')).toEqual([])
  })
})

describe('code, shell words and quoted non-repo paths are not path claims', () => {
  it('ignores a path embedded in a quoted code expression', () => {
    expect(run("Several tests do `readFileSync('../sync/ghostClient.js')`.")).toEqual([])
  })

  it('ignores the tail of a quoted home-relative path', () => {
    expect(run('Dev reads `~/Library/Application Support/shoresh-dev`.')).toEqual([])
  })

  it('ignores a URL', () => {
    expect(run('The dev server is at `http://localhost:5200/index.js`.')).toEqual([])
  })

  it('ignores a truncated path prefix left dangling by prose', () => {
    expect(run('See the `docs/adr/2026-08-17-` series.')).toEqual([])
  })

  it('resolves a partial path by suffix, since it never claimed to start at the root', () => {
    expect(run('`automerge/discovery.js` handles peer discovery.')).toEqual([])
  })

  it('still flags a partial path that matches nothing', () => {
    expect(codes('`ghostdir/discovery.js` handles peer discovery.').join(' '))
      .toContain('ghostdir/discovery.js')
  })
})

describe('the historical layer inside a descriptive doc is exempt', () => {
  it('exempts a line that strikes something out', () => {
    expect(run('| ~~`schedule:map`~~ | `src/screens/GhostMapScreen.jsx` | RETIRED |')).toEqual([])
  })

  it('exempts a dated _Prior: header note', () => {
    expect(run('_Prior: 2026-09-08 (`electron/sync/ghostServer.js` is gone.)_')).toEqual([])
  })

  it('exempts an explicitly marked historical region, and resumes after it', () => {
    const text = [
      '<!-- doc-refs:historical -->',
      '## Removed',
      '- `electron/sync/ghostServer.js` was deleted.',
      '<!-- /doc-refs:historical -->',
      'Live: `src/engine/ghostEngine.js` runs the pass.',
    ].join('\n')
    const msgs = codes(text)
    expect(msgs.join(' ')).not.toContain('ghostServer.js')
    expect(msgs.join(' ')).toContain('src/engine/ghostEngine.js')
  })

  it('an unclosed historical marker does not silently exempt a later doc', () => {
    const docs = [
      { path: 'A.md', text: '<!-- doc-refs:historical -->\n`src/a/ghost.js`' },
      { path: 'B.md', text: '`src/b/ghost.js` is live.' },
    ]
    const f = checkDocFileRefs(docs, makeResolver(root))
    expect(f.map((x) => x.message).join(' ')).toContain('src/b/ghost.js')
  })
})

describe('the descriptive corpus is the scoped one', () => {
  it('covers CLAUDE.md and does not claim to cover the historical layer', () => {
    expect(DESCRIPTIVE_DOC_PATHS).toContain('CLAUDE.md')
    for (const p of DESCRIPTIVE_DOC_PATHS) {
      expect(p.startsWith('docs/adr') || p.startsWith('docs/work') || p.startsWith('docs/archive'))
        .toBe(false)
    }
  })
})
