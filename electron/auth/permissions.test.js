import { describe, it, expect } from 'vitest'
import { PERMISSIONS } from './permissions.js'

// docs/adr/2026-08-28-stage-aware-nav-landing.md Decision 2(a) — staff (not
// just admin) can trigger the Seed screen's "Import last year" action on the
// Host device. This loosens ONLY the role gate; the mode==='client' device
// gate on ingestCommit (electron/main.js) is untouched by this change.
describe('PERMISSIONS.staff: groups.import (ADR Decision 2a)', () => {
  it('grants staff the groups.import action', () => {
    expect(PERMISSIONS.staff).toContain('groups.import')
  })

  it('leaves other admin-only gates unchanged — devices.approve/revoke stay admin-only via admin: ["*"]', () => {
    expect(PERMISSIONS.staff).not.toContain('devices.approve')
    expect(PERMISSIONS.staff).not.toContain('devices.revoke')
  })

  it('leaves camp_maps.write admin-only (M6 D6 exception, unchanged)', () => {
    expect(PERMISSIONS.staff).not.toContain('camp_maps.write')
    expect(PERMISSIONS.staff).toContain('camp_maps.read')
  })

  it('admin retains full access via the wildcard, unaffected by the new staff grant', () => {
    expect(PERMISSIONS.admin).toEqual(['*'])
  })
})
