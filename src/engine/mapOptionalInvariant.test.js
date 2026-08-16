// M6 invariant 3 (docs/adr/2026-08-16-locations-optional-map.md): the engine
// and readiness never read map_geometry or camp_maps. buildSchedule.js and
// readiness.js have zero references today (grepped) — this test pins that
// this stays true, per the ADR's own instruction that this "must remain a
// Maker/Verifier-checked invariant, not a one-time claim".
import { describe, it, expect } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))

describe('M6 optional invariant — the engine never depends on the camp map', () => {
  it('buildSchedule.js does not reference map_geometry or camp_maps', () => {
    const src = fs.readFileSync(path.join(__dirname, 'buildSchedule.js'), 'utf8')
    expect(src).not.toMatch(/map_geometry/)
    expect(src).not.toMatch(/camp_maps/)
  })

  it('readiness.js does not reference map_geometry or camp_maps', () => {
    const src = fs.readFileSync(path.join(__dirname, 'readiness.js'), 'utf8')
    expect(src).not.toMatch(/map_geometry/)
    expect(src).not.toMatch(/camp_maps/)
  })
})
