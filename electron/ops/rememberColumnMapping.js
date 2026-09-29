// Remember a camp's confirmed column mapping for the elective preference
// import. T312 (slice of T281; umbrella T278; ADR §6, §6.0, §6.3).
//
// THROUGH THE OP LOG, NOT A DIRECT INSERT, and the distinction is the whole
// owner ruling rather than a style choice. `recordImportDecisions` next door
// writes `import_decisions` with a raw INSERT, which is correct THERE because
// that table is host-local and never synced. This entity REPLICATES, so a raw
// INSERT would land it in this device's projection and in no document — the
// feature would look like it worked on one laptop and silently fail to be the
// thing it was built to be. Every field goes through `appendOp` inside one
// `runAtomic`, the same path every other synced write uses.
//
// IDEMPOTENT BY CONSTRUCTION. The id is derived from (camp_id, kind, match_key),
// so re-confirming the same form is a field update on the same row rather than a
// second row. That is also what makes two devices confirming DIFFERENT readings
// of one form produce a `conflicts` row a human resolves, instead of two rows
// and an arbitrary winner — see deriveCampSeedlingId's own note.
import { randomUUID } from 'node:crypto'
import { appendOp, runAtomic } from './operations.js'
import { deriveCampSeedlingId } from './electiveDerivedIds.js'

export const SEEDLING_KIND_COLUMN_ROLES = 'preference_column_roles'

/**
 * @param db
 * @param campId
 * @param matchKey  headerMatchKey() output — `hdr-` + hex. Derived from HEADER
 *   TEXT only (ADR §6.0's privacy constraint); a raw header is rejected by
 *   `opaque()` in the derivation, which is the guard doing its job.
 * @param payload   the roles keyed by header text, from `bindingFromMapping`.
 * @returns {{ok:true, id:string}|{ok:false, error:string}}
 */
export function rememberColumnMapping(db, {
  campId, matchKey, payload, authorUserId = null, deviceId,
} = {}) {
  if (!db || !campId || !matchKey || !payload) return { ok: false, error: 'MISSING_ARGUMENT' }

  let id
  try {
    id = deriveCampSeedlingId(campId, SEEDLING_KIND_COLUMN_ROLES, matchKey)
  } catch (e) {
    // A malformed component rather than a storage failure — surfaced rather than
    // swallowed, because a silently unremembered mapping is indistinguishable
    // from a camp that has simply never confirmed one.
    return { ok: false, error: e.message }
  }

  // Serialised ONCE, here, so the string written to the document and the string
  // a recall parses cannot differ by key order.
  const fields = {
    camp_id: campId,
    kind: SEEDLING_KIND_COLUMN_ROLES,
    match_key: matchKey,
    payload: JSON.stringify(payload),
    status: 'active',
    confirmed_by: authorUserId,
    confirmed_at: new Date().toISOString(),
  }

  try {
    runAtomic(db, () => {
      for (const [field, value] of Object.entries(fields)) {
        appendOp(db, {
          entity: 'camp_seedlings', entity_id: id, field, value,
          author_user_id: authorUserId, device_id: deviceId, client_write_id: randomUUID(),
        })
      }
    })
  } catch (e) {
    return { ok: false, error: e.message }
  }

  return { ok: true, id }
}
