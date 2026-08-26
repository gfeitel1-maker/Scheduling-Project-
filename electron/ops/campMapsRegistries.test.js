// @vitest-environment node
//
// Positive verification that camp_maps (M6, schema v33,
// docs/adr/2026-08-16-locations-optional-map.md) is registered in every place
// the ADR's "Registry checklist" names — especially the three silent-failure
// rows the ADR flags by number:
//   1. PROJECTIONS            — omission => writes append to the op log and are
//                               silently discarded
//   3. DOMAIN_SNAPSHOT_TABLES — omission => first-pairing clients never receive
//                               the image
//   4. permissions.ENTITIES / staff grant — omission => staff silently denied
//                               read despite Q7 requiring it (or a leaked
//                               write, the opposite failure)
// plus DIRECT_CAMP_ENTITIES, RESTORE_DECISIONS, MOCK_WRITE_ALLOWLIST, and
// ENTITY_LABEL. Mirrors locationsRegistries.test.js's shape exactly.
import { describe, it, expect } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { PROJECTIONS } from './projections.js'
import { DIRECT_CAMP_ENTITIES, DOMAIN_SNAPSHOT_ORDER } from './campScopedEntities.js'
import { RESTORE_DECISIONS } from './restore.js'
import { MAX_FIELD_VALUE_LENGTH } from './operations.js'
import { PERMISSIONS, ENTITIES } from '../auth/permissions.js'
import { MOCK_WRITE_ALLOWLIST } from '../../src/localClient.mock.js'
import { ENTITY_LABEL } from '../../src/screens/recordLabels.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))

describe('v33 registry coverage — camp_maps', () => {
  it('is a projected entity, keyed by id = camp_id (row 1 — writes materialize, not silently discarded)', () => {
    expect(PROJECTIONS.camp_maps).toBeTruthy()
    expect(PROJECTIONS.camp_maps.key).toBe('id')
    expect(PROJECTIONS.camp_maps.fields).toEqual(
      expect.arrayContaining(['camp_id', 'image_data', 'image_mime', 'image_width', 'image_height'])
    )
  })

  it('is a direct-camp-scoped entity (list() + first-pairing full_sync)', () => {
    expect(DIRECT_CAMP_ENTITIES.has('camp_maps')).toBe(true)
  })

  it('is in the client first-pairing snapshot, ordered after the unconditional camps insert (row 3)', () => {
    // syncClient.js single-sources DOMAIN_SNAPSHOT_TABLES = DOMAIN_SNAPSHOT_ORDER
    // (imported from campScopedEntities.js, T88) — no more literal array to
    // regex. Assert membership against the single source, and preserve the
    // ordering intent: applyFullSyncSnapshot (syncClient.js) always inserts
    // `camps` in its own unconditional loop BEFORE iterating
    // DOMAIN_SNAPSHOT_TABLES, so any position of 'camp_maps' within that
    // array is necessarily after the camps insert. The real ordering
    // constraint that matters within the array itself is the FK-safety
    // comment on DOMAIN_SNAPSHOT_ORDER — camp_maps only depends on camps.id,
    // so it may appear anywhere in the array, but it must still be present.
    expect(DOMAIN_SNAPSHOT_ORDER).toContain('camp_maps')
    const src = fs.readFileSync(path.join(__dirname, '../sync/syncClient.js'), 'utf8')
    expect(src).toMatch(
      /camp_maps:\s*\['id', 'camp_id', 'image_data', 'image_mime', 'image_width', 'image_height', 'kind'\]/
    )
  })

  it('staff hold camp_maps.read but NOT camp_maps.write (row 4 — D6 carve-out, both directions matter)', () => {
    expect(PERMISSIONS.staff).toContain('camp_maps.read')
    expect(PERMISSIONS.staff).not.toContain('camp_maps.write')
    // Deliberately NOT in ENTITIES — being there would derive BOTH read and
    // write for staff via staffReadWrite, which would leak write access.
    expect(ENTITIES).not.toContain('camp_maps')
  })

  it('has a restore decision refusing camp_maps (singleton row, no independent delete UI)', () => {
    expect(RESTORE_DECISIONS.camp_maps).toMatch(/^refused:/)
  })

  it('has a mock write allowlist matching PROJECTIONS.camp_maps.fields', () => {
    expect(MOCK_WRITE_ALLOWLIST.camp_maps).toEqual(
      expect.arrayContaining(['camp_id', 'image_data', 'image_mime', 'image_width', 'image_height'])
    )
  })

  it('has a director-facing label', () => {
    expect(ENTITY_LABEL.camp_maps).toBe('Camp map')
  })

  it('has a size guard registered for image_data, the one field that needs it (D2)', () => {
    expect(MAX_FIELD_VALUE_LENGTH.camp_maps).toEqual({ image_data: 1_400_000 })
  })
})

describe('RESTORE_DECISIONS covers every projected entity (restore.test.js guard, restated)', () => {
  it('has an entry for camp_maps so the build does not fail on an unlisted projection', () => {
    expect(RESTORE_DECISIONS.camp_maps, 'missing RESTORE_DECISIONS for camp_maps').toBeDefined()
  })
})
