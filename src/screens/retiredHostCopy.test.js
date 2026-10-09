import { describe, it, expect } from 'vitest'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'

const RETIRED = /master schedule|Shoresh Host|Host this camp|main office computer|without reinstalling/i
const MAIN_COMPUTER = /main computer/i
const SRC = join(__dirname, '..')
// Owned by open PR #769 at the time of the sweep; remove once they land.
const MAIN_COMPUTER_PENDING = new Set(['screens/DeviceManagerScreen.jsx'])

const isComment = line => /^\s*(\/\/|\*|\/\*)/.test(line)

function sourceFiles(dir) {
  return readdirSync(dir).flatMap(n => {
    const p = join(dir, n)
    if (statSync(p).isDirectory()) return sourceFiles(p)
    return /\.jsx?$/.test(n) && !/\.test\.jsx?$/.test(n) ? [p] : []
  })
}

export function mainComputerOffenders(files, read = f => readFileSync(f, 'utf8')) {
  const offenders = []
  for (const f of files) {
    const rel = relative(SRC, f)
    if (MAIN_COMPUTER_PENDING.has(rel)) continue
    read(f).split('\n').forEach((line, i) => {
      if (!isComment(line) && MAIN_COMPUTER.test(line)) offenders.push(`${rel}:${i + 1}`)
    })
  }
  return offenders
}

describe('retired host-model copy', () => {
  it('does not appear in user-facing screen strings', () => {
    const offenders = []
    for (const f of readdirSync(__dirname).filter(n => n.endsWith('.jsx'))) {
      readFileSync(join(__dirname, f), 'utf8').split('\n').forEach((line, i) => {
        if (isComment(line)) return
        if (RETIRED.test(line)) offenders.push(`${f}:${i + 1}`)
      })
    }
    expect(offenders).toEqual([])
  })

  it('"main computer" does not appear in screens, components or utils (non-comment lines)', () => {
    const files = ['screens', 'components', 'utils'].flatMap(d => sourceFiles(join(SRC, d)))
    expect(mainComputerOffenders(files)).toEqual([])
  })

  it('the "main computer" scan catches a planted string and skips comments and the pending allowlist', () => {
    const planted = {
      [join(SRC, 'screens/Planted.jsx')]: "  // main computer in a comment\n  <div>Approve it on the main computer.</div>",
      [join(SRC, 'screens/DeviceManagerScreen.jsx')]: "<div>Waiting on the main computer</div>",
    }
    expect(mainComputerOffenders(Object.keys(planted), f => planted[f])).toEqual(['screens/Planted.jsx:2'])
  })
})
