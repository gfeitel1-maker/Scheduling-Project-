import { describe, it, expect } from 'vitest'
import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'

const RETIRED = /master schedule|Shoresh Host|Host this camp|main office computer|without reinstalling/i

describe('retired host-model copy', () => {
  it('does not appear in user-facing screen strings', () => {
    const offenders = []
    for (const f of readdirSync(__dirname).filter(n => n.endsWith('.jsx'))) {
      readFileSync(join(__dirname, f), 'utf8').split('\n').forEach((line, i) => {
        if (/^\s*(\/\/|\*|\/\*)/.test(line)) return
        if (RETIRED.test(line)) offenders.push(`${f}:${i + 1}`)
      })
    }
    expect(offenders).toEqual([])
  })
})
